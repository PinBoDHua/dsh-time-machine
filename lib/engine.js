import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CONFIRM_PHRASE,
  ERROR_CODES,
  PLAN_TTL_MS,
  RESTORE_MODES,
} from '../shared/protocol.js'
import {
  commitTree,
  deleteRef,
  ensureShadowRepo,
  runGc,
  snapshotTree,
  treeEntries,
  updateRef,
  verifyCommit,
  diffNumstat,
} from './git.js'
import {
  applyEntries,
  buildRestorePlan,
  RestoreError,
  rollbackToSafety,
  verifyRestoredEntries,
} from './restore.js'
import { CheckpointStore } from './store.js'
import {
  abortError,
  formatError,
  makeCheckpointId,
  makePlanId,
  nowIso,
  throwIfAborted,
  writeJsonAtomic,
} from './util.js'

export class EngineError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'EngineError'
    this.code = code
    this.details = details
  }
}

function combinedSignal(...signals) {
  const list = signals.filter((signal) => signal !== undefined && signal !== null)
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]
  return AbortSignal.any(list)
}

function checkpointRef(id) {
  return `refs/time-machine/checkpoints/${id}`
}

function planRef(planId) {
  return `refs/time-machine/plans/${planId}`
}

function journalFile(binding, planId) {
  return join(binding.journalDir, `${planId}.json`)
}

function publicCheckpoint(entry, index = -1) {
  return {
    id: entry.id,
    kind: entry.kind,
    phase: entry.phase,
    sessionId: entry.sessionId,
    turn: entry.turn,
    label: entry.label,
    createdAt: entry.createdAt,
    stats: entry.stats,
    warnings: entry.warnings,
    current: index === 0,
  }
}

function planSummary(plan) {
  return {
    planId: plan.planId,
    checkpointId: plan.targetId,
    mode: plan.mode,
    files: plan.entries.length,
    writes: plan.writes,
    deletes: plan.deletes,
    addedLines: plan.addedLines,
    deletedLines: plan.deletedLines,
    sample: plan.sample,
    truncatedSample: plan.truncatedSample,
    warnings: plan.warnings,
    expiresAt: plan.expiresAt,
    workspacePath: plan.workspacePath,
  }
}

/**
 * 一个工作区一个引擎。所有快照、恢复、GC 都在同一条串行链上跑；
 * 事件里的 turn/start 与 turn/end 只排队，不阻塞 Agent。
 */
export class TimeMachineEngine {
  constructor({ binding, configStore, git, logger, version, gitAvailable = true }) {
    this.binding = binding
    this.configStore = configStore
    this.git = git
    this.logger = logger
    this.version = version
    this.gitAvailable = gitAvailable
    this.store = new CheckpointStore({ binding, logger })
    this.chain = Promise.resolve()
    this.lifetime = new AbortController()
    this.disposed = false
    this.activeTurns = new Map()
    this.afterAttempts = new Map()
    this.plans = new Map()
    this.protected = new Set()
    this.lastError = null
    this.ready = undefined
    this.journalCache = { at: 0, entries: [] }
  }

  async init() {
    this.ready ??= (async () => {
      await this.store.load()
      try {
        const files = await readdir(this.binding.journalDir)
        if (files.length > 0) {
          this.logger?.warn?.(`dsh-time-machine: 发现 ${files.length} 个未完成的恢复日志（${this.binding.workspacePath}），可在终端运行 dsh-time-machine recover`)
          for (const file of files) {
            if (!file.endsWith('.json')) continue
            try {
              const value = JSON.parse(await readFile(join(this.binding.journalDir, file), 'utf8'))
              if (typeof value.safetyId === 'string') this.protected.add(value.safetyId)
            } catch {
              /* skip unreadable journal */
            }
          }
        }
      } catch {
        /* journal directory is created lazily */
      }
      return this
    })()
    return this.ready
  }

  config() {
    return this.configStore.get()
  }

  isBusy() {
    return this.activeTurns.size > 0
  }

  /**
   * 工具发起的恢复允许在“只有它自己这一轮在跑”时执行：模型在两次工具调用
   * 之间等待工具结果，恢复不会与并行写文件重叠；其他会话仍在跑时仍然拒绝。
   */
  isBusyFor(sessionId, allowActiveSession = false) {
    if (!allowActiveSession) return this.activeTurns.size > 0
    for (const id of this.activeTurns.keys()) {
      if (id !== sessionId) return true
    }
    return false
  }

  activeTurn(sessionId) {
    return this.activeTurns.get(sessionId) ?? null
  }

  recordError(error, context) {
    const message = formatError(error)
    this.lastError = { at: nowIso(), code: error?.code ?? 'ERROR', message, context }
    if (error?.code !== 'SESSION_BUSY') {
      this.logger?.warn?.(`dsh-time-machine: ${context} 失败：${message}`)
    }
  }

  enqueue(task) {
    const run = this.chain.then(async () => {
      if (this.disposed) throw new EngineError('DISPOSED', '时光机已卸载')
      return task(this.lifetime.signal)
    })
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  startTurn(sessionId, turn) {
    this.activeTurns.set(sessionId, turn)
    const config = this.config()
    if (!config.auto || !config.beforeTurn) return Promise.resolve({ skipped: 'disabled' })
    return this.enqueue((signal) => this.checkpoint({
      sessionId,
      turn,
      kind: 'auto',
      phase: 'before',
      signal,
    })).catch((error) => {
      this.recordError(error, '轮次开始快照')
      return { skipped: 'error', error: formatError(error) }
    })
  }

  stopping(sessionId, turn) {
    return this.afterTurn(sessionId, turn)
  }

  endTurn(sessionId, turn) {
    if (this.activeTurns.get(sessionId) === turn) this.activeTurns.delete(sessionId)
    void this.afterTurn(sessionId, turn).catch((error) => {
      this.recordError(error, '轮次结束快照')
    })
  }

  afterTurn(sessionId, turn) {
    const key = `${sessionId}:${String(turn)}`
    const existing = this.afterAttempts.get(key)
    if (existing !== undefined) return existing
    const config = this.config()
    if (!config.auto || !config.afterTurn) {
      const skipped = Promise.resolve({ skipped: 'disabled' })
      this.afterAttempts.set(key, skipped)
      return skipped
    }
    const attempt = this.enqueue((signal) => this.checkpoint({
      sessionId,
      turn,
      kind: 'auto',
      phase: 'after',
      signal,
    })).catch((error) => {
      this.recordError(error, '轮次结束快照')
      return { skipped: 'error', error: formatError(error) }
    })
    this.afterAttempts.set(key, attempt)
    if (this.afterAttempts.size > 200) {
      const oldest = this.afterAttempts.keys().next().value
      if (oldest !== undefined) this.afterAttempts.delete(oldest)
    }
    return attempt
  }

  forgetSession(sessionId) {
    this.activeTurns.delete(sessionId)
  }

  async status(sessionId) {
    await this.init()
    const config = this.config()
    const checkpoints = this.store.list(50).map((entry, index) => publicCheckpoint(entry, index))
    const journals = await this.listJournals().catch(() => [])
    return {
      workspacePath: this.binding.workspacePath,
      workTree: this.binding.workTree,
      prefix: this.binding.prefix,
      checkpoints,
      total: this.store.get().checkpoints.length,
      busy: this.isBusy(),
      activeTurn: sessionId === undefined ? null : this.activeTurn(sessionId),
      settings: config,
      lastError: this.lastError,
      journals: journals.map((entry) => ({
        planId: entry.planId,
        createdAt: entry.createdAt,
        targetId: entry.targetId,
        safetyId: entry.safetyId,
      })),
      version: this.version,
      gitAvailable: this.gitAvailable,
    }
  }

  async checkpoint({ sessionId, turn = null, kind, phase, label, force = false, signal }) {
    await this.init()
    const config = this.config()
    if (kind === 'auto' && !config.auto) return { skipped: 'disabled' }
    const started = Date.now()
    const combined = combinedSignal(signal, this.lifetime.signal)
    throwIfAborted(combined)
    await ensureShadowRepo(this.binding, { git: this.git, excludes: config.excludes, signal: combined })
    const snapshot = await snapshotTree(this.binding, {
      git: this.git,
      signal: combined,
      timeoutMs: config.timeoutMs,
    })
    const previous = this.store.latest()
    if (!force && previous !== undefined && previous.tree === snapshot.tree) {
      return { skipped: 'unchanged', checkpoint: publicCheckpoint(previous, 0) }
    }
    const result = await this.appendCheckpoint({
      tree: snapshot.tree,
      sessionId,
      turn,
      kind,
      phase,
      label,
      force,
      warnings: snapshot.warnings,
      durationMs: Date.now() - started,
      signal: combined,
    })
    this.lastError = null
    return result
  }

  async appendCheckpoint({
    tree,
    commit,
    sessionId,
    turn = null,
    kind,
    phase,
    label,
    force = false,
    warnings = [],
    durationMs,
    signal,
  }) {
    const config = this.config()
    const previous = this.store.latest()
    if (!force && previous !== undefined && previous.tree === tree) {
      return { skipped: 'unchanged', checkpoint: publicCheckpoint(previous, 0) }
    }
    const id = makeCheckpointId()
    const createdAt = nowIso()
    const effectiveCommit = commit ?? await commitTree(this.binding, {
      git: this.git,
      tree,
      message: `time-machine ${id} ${kind}/${phase}${turn === null ? '' : ` turn=${String(turn)}`}`,
      date: new Date(createdAt),
      signal,
      timeoutMs: config.timeoutMs,
    })
    let stats
    try {
      stats = await this.statsAgainst(previous, tree, signal, config)
    } catch (error) {
      warnings = [...warnings, `统计差异失败：${formatError(error)}`]
      stats = { files: 0, added: 0, deleted: 0 }
    }
    await updateRef(this.binding, {
      git: this.git,
      ref: checkpointRef(id),
      commit: effectiveCommit,
      signal,
    })
    const checkpoint = {
      id,
      kind,
      phase,
      sessionId,
      turn,
      label,
      createdAt,
      commit: effectiveCommit,
      tree,
      previousId: previous?.id,
      stats,
      durationMs,
      warnings: warnings.length === 0 ? undefined : warnings,
    }
    let removed
    try {
      const appended = await this.store.append(checkpoint, {
        maxCheckpoints: config.maxCheckpoints,
        maxAgeDays: config.maxAgeDays,
        protectedIds: this.protectedIds(),
      })
      removed = appended.removed
    } catch (error) {
      await deleteRef(this.binding, { git: this.git, ref: checkpointRef(id), signal }).catch(() => {})
      throw error
    }
    await this.deleteRefs(removed, signal)
    this.maybeGc(removed.length)
    return { checkpoint: publicCheckpoint(checkpoint, 0) }
  }

  async statsAgainst(previous, tree, signal, config) {
    if (previous === undefined || previous.tree === undefined) {
      return { files: 0, added: 0, deleted: 0, initial: true }
    }
    if (previous.tree === tree) return { files: 0, added: 0, deleted: 0 }
    const entries = await diffNumstat(this.binding, {
      git: this.git,
      from: previous.tree,
      to: tree,
      signal,
      timeoutMs: config.timeoutMs,
    })
    let added = 0
    let deleted = 0
    for (const stat of entries.values()) {
      added += stat.added
      deleted += stat.deleted
    }
    return { files: entries.size, added, deleted }
  }

  protectedIds() {
    const ids = new Set(this.protected)
    for (const plan of this.plans.values()) ids.add(plan.targetId)
    return ids
  }

  async deleteRefs(entries, signal) {
    for (const entry of entries) {
      await deleteRef(this.binding, {
        git: this.git,
        ref: checkpointRef(entry.id),
        signal,
      }).catch((error) => {
        this.logger?.warn?.(`dsh-time-machine: 清理旧还原点引用失败：${formatError(error)}`)
      })
    }
  }

  maybeGc(removedCount) {
    const config = this.config()
    if (!config.autoGc || removedCount < 10 || this.isBusy()) return
    const last = this.store.get().lastGcAt
    if (last !== undefined && Date.now() - Date.parse(last) < 60 * 60 * 1000) return
    const gc = this.chain.then(async () => {
      if (this.disposed || this.isBusy()) return
      try {
        const ok = await runGc(this.binding, { git: this.git, signal: this.lifetime.signal })
        if (ok) await this.store.markGc()
      } catch (error) {
        this.logger?.warn?.(`dsh-time-machine: 自动整理快照失败：${formatError(error)}`)
      }
    })
    this.chain = gc.then(() => undefined, () => undefined)
  }

  async manualSnapshot(sessionId, label) {
    return this.enqueue((signal) => this.checkpoint({
      sessionId,
      kind: 'manual',
      phase: 'after',
      label,
      force: true,
      signal,
    }))
  }

  async planRestore({ sessionId, checkpointId, mode, signal, allowActiveSession = false }) {
    if (!RESTORE_MODES.includes(mode)) throw new EngineError(ERROR_CODES.badRequest, '恢复模式无效')
    if (this.isBusyFor(sessionId, allowActiveSession)) {
      throw new EngineError(ERROR_CODES.sessionBusy, '会话正在运行。请先停止当前轮次，再恢复到旧版本。')
    }
    return this.enqueue(async (lifeSignal) => {
      const combined = combinedSignal(signal, lifeSignal)
      throwIfAborted(combined)
      if (this.isBusyFor(sessionId, allowActiveSession)) {
        throw new EngineError(ERROR_CODES.sessionBusy, '会话正在运行。请先停止当前轮次，再恢复到旧版本。')
      }
      await this.init()
      const target = this.store.find(checkpointId)
      if (target === undefined) throw new EngineError(ERROR_CODES.checkpointNotFound, '找不到这个还原点')
      if (!(await verifyCommit(this.binding, { git: this.git, commit: target.commit, signal: combined }))) {
        throw new EngineError(ERROR_CODES.checkpointNotFound, '这个还原点的快照对象已经被清理')
      }
      const config = this.config()
      const started = Date.now()
      await ensureShadowRepo(this.binding, { git: this.git, excludes: config.excludes, signal: combined })
      const snapshot = await snapshotTree(this.binding, {
        git: this.git,
        signal: combined,
        timeoutMs: config.timeoutMs,
      })
      const planId = makePlanId()
      let currentCommit = this.store.get().lastCommit
      if (snapshot.tree !== this.store.get().lastTree || currentCommit === undefined) {
        currentCommit = await commitTree(this.binding, {
          git: this.git,
          tree: snapshot.tree,
          message: `time-machine plan ${planId}`,
          signal: combined,
          timeoutMs: config.timeoutMs,
        })
      }
      await updateRef(this.binding, {
        git: this.git,
        ref: planRef(planId),
        commit: currentCommit,
        signal: combined,
      })
      try {
        const summary = await buildRestorePlan({
          binding: this.binding,
          git: this.git,
          currentCommit,
          currentTree: snapshot.tree,
          target,
          mode,
          maxFileBytes: config.maxRestoreFileBytes,
          signal: combined,
          timeoutMs: config.restoreTimeoutMs,
        })
        const plan = {
          ...summary,
          planId,
          sessionId,
          targetId: target.id,
          targetCommit: target.commit,
          targetTree: target.tree,
          currentCommit,
          currentTree: snapshot.tree,
          workspacePath: this.binding.workspacePath,
          createdAt: nowIso(),
          expiresAt: Date.now() + PLAN_TTL_MS,
          durationMs: Date.now() - started,
        }
        this.plans.set(planId, plan)
        this.protected.add(target.id)
        await this.cleanupPlans()
        return planSummary(plan)
      } catch (error) {
        await deleteRef(this.binding, { git: this.git, ref: planRef(planId), signal: combined }).catch(() => {})
        throw error
      }
    }).catch((error) => {
      this.recordError(error, '生成恢复计划')
      throw error
    })
  }

  async applyRestore({ sessionId, planId, confirm, signal, allowActiveSession = false }) {
    if (confirm !== CONFIRM_PHRASE) {
      throw new EngineError(ERROR_CODES.confirmRequired, `需要确认短语 ${CONFIRM_PHRASE}`)
    }
    const plan = this.plans.get(planId)
    if (plan === undefined) throw new EngineError(ERROR_CODES.planNotFound, '恢复计划不存在或已失效')
    if (plan.sessionId !== sessionId) throw new EngineError(ERROR_CODES.forbidden, '恢复计划属于另一个会话')
    if (Date.now() > plan.expiresAt) {
      await this.discardPlan(planId)
      throw new EngineError(ERROR_CODES.planExpired, '恢复计划已过期，请重新预览')
    }
    if (this.isBusyFor(sessionId, allowActiveSession)) {
      throw new EngineError(ERROR_CODES.sessionBusy, '会话正在运行。请先停止当前轮次，再执行恢复。')
    }
    return this.enqueue(async (lifeSignal) => {
      const combined = combinedSignal(signal, lifeSignal)
      throwIfAborted(combined)
      if (this.isBusyFor(sessionId, allowActiveSession)) {
        throw new EngineError(ERROR_CODES.sessionBusy, '会话正在运行。请先停止当前轮次，再执行恢复。')
      }
      const stillThere = this.plans.get(planId)
      if (stillThere === undefined) throw new EngineError(ERROR_CODES.planNotFound, '恢复计划不存在或已失效')
      if (Date.now() > stillThere.expiresAt) {
        await this.discardPlan(planId)
        throw new EngineError(ERROR_CODES.planExpired, '恢复计划已过期，请重新预览')
      }
      const config = this.config()
      await this.init()
      const fresh = await snapshotTree(this.binding, {
        git: this.git,
        signal: combined,
        timeoutMs: config.timeoutMs,
      })
      if (fresh.tree !== plan.currentTree) {
        await this.discardPlan(planId)
        throw new EngineError(ERROR_CODES.workspaceChanged, '工作区在预览之后发生了改动，请重新预览恢复影响')
      }

      const safety = await this.appendCheckpoint({
        tree: plan.currentTree,
        commit: plan.currentCommit,
        sessionId,
        kind: 'safety',
        phase: 'after',
        force: true,
        warnings: [],
        durationMs: 0,
        signal: combined,
      })
      const safetyCheckpoint = this.store.find(safety.checkpoint.id)
      if (safetyCheckpoint === undefined) throw new EngineError(ERROR_CODES.snapshotFailed, '安全点创建失败')
      this.protected.add(safetyCheckpoint.id)

      const journalPath = journalFile(this.binding, planId)
      const journal = {
        version: 1,
        planId,
        sessionId,
        workspacePath: this.binding.workspacePath,
        workTree: this.binding.workTree,
        prefix: this.binding.prefix,
        createdAt: nowIso(),
        safetyId: safetyCheckpoint.id,
        safetyCommit: safetyCheckpoint.commit,
        safetyTree: safetyCheckpoint.tree,
        targetId: plan.targetId,
        targetCommit: plan.targetCommit,
        targetTree: plan.targetTree,
        mode: plan.mode,
        entries: plan.entries.map(({ path, status, mode: entryMode, oid, size }) => ({
          path,
          status,
          mode: entryMode,
          oid,
          size,
        })),
      }
      await writeJsonAtomic(journalPath, journal)

      try {
        await applyEntries({
          binding: this.binding,
          git: this.git,
          entries: plan.entries,
          maxFileBytes: config.maxRestoreFileBytes,
          signal: combined,
          timeoutMs: config.restoreTimeoutMs,
        })
        const post = await snapshotTree(this.binding, {
          git: this.git,
          signal: combined,
          timeoutMs: config.timeoutMs,
        })
        const postEntries = await treeEntries(this.binding, {
          git: this.git,
          commit: post.tree,
          signal: combined,
          timeoutMs: config.timeoutMs,
        })
        const mismatches = verifyRestoredEntries({ plan, postEntries })
        if (mismatches.length > 0) {
          throw new RestoreError('VERIFY_FAILED', `恢复后校验失败：${mismatches.slice(0, 5).map((item) => item.path).join(', ')}`, { mismatches })
        }
        const restored = await this.appendCheckpoint({
          tree: post.tree,
          sessionId,
          kind: 'restore',
          phase: 'after',
          force: true,
          warnings: plan.warnings.length === 0 ? [] : plan.warnings,
          durationMs: 0,
          signal: combined,
        })
        await rm(journalPath, { force: true })
        await this.discardPlan(planId)
        this.protected.delete(safetyCheckpoint.id)
        this.lastError = null
        return {
          restored: true,
          targetId: plan.targetId,
          safetyId: safetyCheckpoint.id,
          checkpointId: restored.checkpoint.id,
          mode: plan.mode,
          files: plan.entries.length,
          writes: plan.writes,
          deletes: plan.deletes,
          addedLines: plan.addedLines,
          deletedLines: plan.deletedLines,
          warnings: plan.warnings,
          sample: plan.sample,
          truncatedSample: plan.truncatedSample,
        }
      } catch (error) {
        const rollbackSignal = AbortSignal.timeout(config.restoreTimeoutMs)
        try {
          await rollbackToSafety({
            binding: this.binding,
            git: this.git,
            safetyCommit: safetyCheckpoint.commit,
            planEntries: plan.entries,
            maxFileBytes: config.maxRestoreFileBytes,
            signal: rollbackSignal,
            timeoutMs: config.restoreTimeoutMs,
          })
          const rolled = await snapshotTree(this.binding, {
            git: this.git,
            signal: rollbackSignal,
            timeoutMs: config.timeoutMs,
          })
          if (rolled.tree !== safetyCheckpoint.tree) {
            throw new Error('回滚后的快照与安全点不一致')
          }
          await rm(journalPath, { force: true })
          await this.discardPlan(planId)
          this.protected.delete(safetyCheckpoint.id)
          this.recordError(error, '恢复工作区')
          throw new EngineError(
            ERROR_CODES.restoreRolledBack,
            `恢复失败，已自动回滚到安全点 ${safetyCheckpoint.id}：${formatError(error)}`,
            { safetyId: safetyCheckpoint.id, rolledBack: true, cause: formatError(error) },
          )
        } catch (rollbackError) {
          if (rollbackError instanceof EngineError) throw rollbackError
          await this.discardPlan(planId)
          this.recordError(rollbackError, '自动回滚')
          throw new EngineError(
            ERROR_CODES.rollbackFailed,
            `恢复失败，且自动回滚没有完成。安全点 ${safetyCheckpoint.id} 仍保留，恢复日志在 ${journalPath}：${formatError(rollbackError)}`,
            { safetyId: safetyCheckpoint.id, journal: journalPath, cause: formatError(error) },
          )
        }
      }
    })
  }

  async restoreNow({ sessionId, checkpointId, mode, signal, allowActiveSession = false }) {
    const plan = await this.planRestore({ sessionId, checkpointId, mode, signal, allowActiveSession })
    return this.applyRestore({
      sessionId,
      planId: plan.planId,
      confirm: CONFIRM_PHRASE,
      signal,
      allowActiveSession,
    })
  }

  async discardPlan(planId) {
    const plan = this.plans.get(planId)
    this.plans.delete(planId)
    if (plan === undefined) return
    try {
      await deleteRef(this.binding, {
        git: this.git,
        ref: planRef(planId),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (error) {
      this.logger?.warn?.(`dsh-time-machine: 释放恢复计划引用失败：${formatError(error)}`)
    }
    if (![...this.plans.values()].some((other) => other.targetId === plan.targetId)) {
      this.protected.delete(plan.targetId)
    }
  }

  async cleanupPlans() {
    const now = Date.now()
    for (const [planId, plan] of this.plans) {
      if (now > plan.expiresAt) await this.discardPlan(planId)
    }
    if (this.plans.size > 20) {
      const oldest = [...this.plans.entries()].sort((left, right) => left[1].createdAt.localeCompare(right[1].createdAt))
      for (const [planId] of oldest.slice(0, this.plans.size - 20)) await this.discardPlan(planId)
    }
  }

  async listJournals() {
    await this.init()
    if (Date.now() - this.journalCache.at < 2000) return this.journalCache.entries
    const entries = []
    let files = []
    try {
      files = await readdir(this.binding.journalDir)
    } catch {
      files = []
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const value = JSON.parse(await readFile(join(this.binding.journalDir, file), 'utf8'))
        if (value !== null && typeof value === 'object' && typeof value.planId === 'string') entries.push(value)
      } catch {
        /* skip unreadable journal */
      }
    }
    this.journalCache = { at: Date.now(), entries }
    return entries
  }

  async recoverJournal(planId, { signal } = {}) {
    return this.enqueue(async (lifeSignal) => {
      const combined = combinedSignal(signal, lifeSignal)
      await this.init()
      const journals = await this.listJournals()
      const journal = journals.find((entry) => entry.planId === planId)
      if (journal === undefined) throw new EngineError(ERROR_CODES.notFound, '恢复日志不存在')
      const config = this.config()
      await rollbackToSafety({
        binding: this.binding,
        git: this.git,
        safetyCommit: journal.safetyCommit,
        planEntries: journal.entries,
        maxFileBytes: config.maxRestoreFileBytes,
        signal: combined,
        timeoutMs: config.restoreTimeoutMs,
      })
      const snapshot = await snapshotTree(this.binding, {
        git: this.git,
        signal: combined,
        timeoutMs: config.timeoutMs,
      })
      if (snapshot.tree !== journal.safetyTree) {
        throw new EngineError(ERROR_CODES.rollbackFailed, '回滚后的快照与安全点不一致，恢复日志已保留')
      }
      await rm(journalFile(this.binding, planId), { force: true })
      this.journalCache.at = 0
      return { recovered: true, planId, safetyId: journal.safetyId }
    })
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.lifetime.abort(abortError('time-machine disposed'))
    await this.chain
    for (const planId of [...this.plans.keys()]) {
      try {
        await deleteRef(this.binding, {
          git: this.git,
          ref: planRef(planId),
          signal: AbortSignal.timeout(10_000),
        })
      } catch {
        /* best effort */
      }
    }
    this.plans.clear()
    this.activeTurns.clear()
  }
}

export { checkpointRef, planRef }
