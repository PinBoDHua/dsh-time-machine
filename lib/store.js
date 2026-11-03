import { rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { CHECKPOINT_ID_RE, CHECKPOINT_KINDS, CHECKPOINT_PHASES, CONFIG_LIMITS } from '../shared/protocol.js'
import {
  ensureDir,
  nowIso,
  readJsonSafe,
  sanitizeLabel,
  writeJsonAtomic,
} from './util.js'

export const STORE_VERSION = 1
export const MIN_KEEP = 5
// 必须与 CONFIG_LIMITS.maxCheckpoints 的上限一致。此前这里硬编码 500，
// 而配置允许 1000：重启后超过 500 条的元数据会被静默截断，对应 refs 却仍
// 留在磁盘上，既丢时间线又让对象无法回收。
export const MAX_STORED_CHECKPOINTS = CONFIG_LIMITS.maxCheckpoints[1]

function isHex(value) {
  return typeof value === 'string' && /^[0-9a-f]{40,64}$/.test(value)
}

export function isValidCheckpoint(value) {
  if (value === null || typeof value !== 'object') return false
  if (typeof value.id !== 'string' || !CHECKPOINT_ID_RE.test(value.id)) return false
  if (!CHECKPOINT_KINDS.includes(value.kind)) return false
  if (!CHECKPOINT_PHASES.includes(value.phase)) return false
  if (!isHex(value.commit) || !isHex(value.tree)) return false
  if (typeof value.sessionId !== 'string' || value.sessionId === '') return false
  if (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) return false
  if (value.stats === null || typeof value.stats !== 'object') return false
  return true
}


function normalizeCheckpoint(value) {
  return {
    id: value.id,
    kind: value.kind,
    phase: value.phase,
    sessionId: value.sessionId,
    turn: Number.isInteger(value.turn) ? value.turn : null,
    label: sanitizeLabel(value.label),
    createdAt: value.createdAt,
    commit: value.commit,
    tree: value.tree,
    previousId: typeof value.previousId === 'string' ? value.previousId : undefined,
    stats: {
      files: Number.isFinite(value.stats.files) ? value.stats.files : 0,
      added: Number.isFinite(value.stats.added) ? value.stats.added : 0,
      deleted: Number.isFinite(value.stats.deleted) ? value.stats.deleted : 0,
      initial: value.stats.initial === true || undefined,
    },
    durationMs: Number.isFinite(value.durationMs) ? value.durationMs : undefined,
    warnings: Array.isArray(value.warnings) ? value.warnings.filter((item) => typeof item === 'string').slice(0, 8) : undefined,
  }
}

export class CheckpointStore {
  constructor({ binding, logger }) {
    this.binding = binding
    this.logger = logger
    this.state = {
      version: STORE_VERSION,
      workspacePath: binding.workspacePath,
      workTree: binding.workTree,
      prefix: binding.prefix,
      checkpoints: [],
      lastCheckpointId: undefined,
      lastCommit: undefined,
      lastTree: undefined,
      lastGcAt: undefined,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.loaded = false
    this.loadIssues = []
  }

  async load() {
    if (this.loaded) return this.state
    await ensureDir(this.binding.dataDir)
    await ensureDir(dirname(this.binding.metadataFile))
    const { value, error } = await readJsonSafe(this.binding.metadataFile)
    if (error !== undefined) {
      this.loadIssues.push(`索引读取失败：${error.message}`)
      try {
        await rename(this.binding.metadataFile, `${this.binding.metadataFile}.corrupt-${Date.now()}`)
      } catch {
        /* keep going with a fresh index */
      }
    } else if (value !== undefined) {
      if (value === null || typeof value !== 'object' || !Array.isArray(value.checkpoints)) {
        this.loadIssues.push('索引结构无效，已重建')
        try {
          await rename(this.binding.metadataFile, `${this.binding.metadataFile}.corrupt-${Date.now()}`)
        } catch {
          /* ignore */
        }
      } else {
        const rawCheckpoints = value.checkpoints
        const checkpoints = rawCheckpoints
          .filter((entry) => {
            if (isValidCheckpoint(entry)) return true
            this.loadIssues.push('索引中有一条记录无效，已丢弃')
            return false
          })
          .map(normalizeCheckpoint)
          .slice(0, MAX_STORED_CHECKPOINTS)
        if (rawCheckpoints.length > MAX_STORED_CHECKPOINTS) {
          this.loadIssues.push(`索引超过 ${MAX_STORED_CHECKPOINTS} 条上限，已只保留最新的 ${MAX_STORED_CHECKPOINTS} 条`)
        }
        this.state = {
          ...this.state,
          ...value,
          checkpoints,
          version: STORE_VERSION,
          workspacePath: this.binding.workspacePath,
          workTree: this.binding.workTree,
          prefix: this.binding.prefix,
          createdAt: typeof value.createdAt === 'string' ? value.createdAt : this.state.createdAt,
        }
        if (this.state.workTree !== value.workTree || this.state.prefix !== value.prefix) {
          this.loadIssues.push('工作区位置发生变化，快照范围已更新')
        }
        const first = checkpoints[0]
        if (first !== undefined) {
          this.state.lastCheckpointId = first.id
          this.state.lastCommit = first.commit
          this.state.lastTree = first.tree
        } else {
          this.state.lastCheckpointId = undefined
          this.state.lastCommit = undefined
          this.state.lastTree = undefined
        }
        if (this.loadIssues.length > 0) {
          this.logger?.warn?.(`dsh-time-machine: ${this.loadIssues.join('；')}`)
        }
      }
    }
    this.loaded = true
    return this.state
  }

  async save() {
    const previous = this.state.updatedAt
    this.state.updatedAt = nowIso()
    try {
      await writeJsonAtomic(this.binding.metadataFile, this.state)
    } catch (error) {
      this.state.updatedAt = previous
      throw error
    }
  }

  get() {
    return this.state
  }

  list(limit = 50) {
    return this.state.checkpoints.slice(0, Math.max(0, limit))
  }

  find(id) {
    return this.state.checkpoints.find((entry) => entry.id === id)
  }

  latest() {
    return this.state.checkpoints[0]
  }

  async append(checkpoint, { maxCheckpoints = 120, maxAgeDays = 14, protectedIds = new Set() } = {}) {
    // 元数据落盘成功之前不改内存状态：写盘失败（磁盘满、权限、杀毒软件占用）
    // 时时间线与引用必须一起回退，否则 latest() 会指向一个随后被删掉引用的点。
    const before = { ...this.state, checkpoints: this.state.checkpoints }
    const normalized = normalizeCheckpoint(checkpoint)
    this.state.checkpoints = [normalized, ...this.state.checkpoints.filter((entry) => entry.id !== normalized.id)]
    this.state.lastCheckpointId = normalized.id
    this.state.lastCommit = normalized.commit
    this.state.lastTree = normalized.tree
    const removed = pruneCheckpoints(this.state.checkpoints, {
      maxCheckpoints,
      maxAgeDays,
      protectedIds,
    })
    if (removed.length > 0) {
      const removedIds = new Set(removed.map((entry) => entry.id))
      this.state.checkpoints = this.state.checkpoints.filter((entry) => !removedIds.has(entry.id))
      const first = this.state.checkpoints[0]
      if (first !== undefined) {
        this.state.lastCheckpointId = first.id
        this.state.lastCommit = first.commit
        this.state.lastTree = first.tree
      }
    }
    try {
      await this.save()
    } catch (error) {
      this.state = before
      throw error
    }
    return { checkpoint: normalized, removed }
  }

  async markGc(at = nowIso()) {
    const previous = this.state.lastGcAt
    this.state.lastGcAt = at
    try {
      await this.save()
    } catch (error) {
      this.state.lastGcAt = previous
      throw error
    }
  }
}

export function pruneCheckpoints(checkpoints, { maxCheckpoints = 120, maxAgeDays = 14, protectedIds = new Set() } = {}) {
  const cutoff = Date.now() - Math.max(1, maxAgeDays) * 24 * 60 * 60 * 1000
  const removed = []
  const kept = []
  checkpoints.forEach((entry, index) => {
    const isNewest = index < MIN_KEEP
    const isProtected = protectedIds.has(entry.id)
    const tooMany = index >= Math.max(MIN_KEEP, maxCheckpoints)
    const tooOld = Date.parse(entry.createdAt) < cutoff
    if (!isNewest && !isProtected && (tooMany || tooOld)) removed.push(entry)
    else kept.push(entry)
  })
  return removed
}
