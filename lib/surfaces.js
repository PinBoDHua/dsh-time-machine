import { CHECKPOINT_ID_RE } from '../shared/protocol.js'
import { EngineError } from './engine.js'
import { formatError } from './util.js'

const KIND_LABELS = {
  auto: '自动',
  manual: '手动',
  safety: '安全点',
  restore: '恢复后',
}

const PHASE_LABELS = {
  before: '轮前',
  after: '轮后',
}

const USAGE = [
  '用法：',
  '  /rewind                       列出最近还原点',
  '  /rewind snapshot [备注]       立即创建一个还原点',
  '  /rewind restore <id>          覆盖恢复（不删除新增文件）',
  '  /rewind restore <id> --exact  精确恢复（同时删除此后新增的文件）',
  '  /rewind recover [planId]      查看或执行未完成恢复的回滚',
].join('\n')

function formatTime(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { hour12: false })
}

function kindOf(entry) {
  if (entry.kind === 'auto') return `${entry.label ?? KIND_LABELS.auto}${PHASE_LABELS[entry.phase] ? ` · ${PHASE_LABELS[entry.phase]}` : ''}`
  return entry.label ?? KIND_LABELS[entry.kind] ?? entry.kind
}

function statsOf(entry) {
  const stats = entry.stats ?? {}
  if (stats.initial) return '初始快照'
  const files = Number(stats.files ?? 0)
  const added = Number(stats.added ?? 0)
  const deleted = Number(stats.deleted ?? 0)
  return `${String(files)} 个文件 +${String(added)} −${String(deleted)}`
}

function renderList(status) {
  if (status.checkpoints.length === 0) {
    return [
      `时光机 · ${status.workspacePath}`,
      '还没有还原点。每次对话开始/结束时会自动记录；也可以现在运行 /rewind snapshot 创建一个。',
    ].join('\n')
  }
  const lines = [
    `时光机 · ${status.workspacePath}`,
    `共 ${String(status.total)} 个还原点${status.busy ? '（会话正在运行，恢复已暂时锁定）' : ''}`,
  ]
  for (const entry of status.checkpoints.slice(0, 10)) {
    const turn = entry.turn === null || entry.turn === undefined ? '' : `第 ${String(entry.turn)} 轮`
    lines.push(`${entry.id}  ${formatTime(entry.createdAt)}  ${kindOf(entry)}${turn === '' ? '' : ` ${turn}`}  ${statsOf(entry)}`)
  }
  if (status.total > 10) lines.push(`…… 还有 ${String(status.total - 10)} 个，可在会话标题栏的时光机面板中查看`)
  if (status.journals.length > 0) {
    lines.push(`⚠ 有 ${String(status.journals.length)} 个未完成的恢复日志；运行 /rewind recover 查看`)
  }
  lines.push('恢复：/rewind restore <id> [--exact]')
  return lines.join('\n')
}

function asError(error) {
  const message = error instanceof EngineError ? error.message : formatError(error)
  return { kind: 'error', text: `时光机：${message}` }
}

export function registerCommand(ctx, surfaces) {
  const { engineFor, sessionCwd, eligible } = surfaces
  const handler = async (invocation) => {
    const session = invocation?.agent?.session
    if (session === undefined) return { kind: 'error', text: '时光机命令需要绑定到一个会话。' }
    if (!eligible(session)) return { kind: 'error', text: '时光机只记录顶层会话，子代理不能操作还原点。' }
    const cwd = sessionCwd(session)
    if (cwd === undefined) return { kind: 'error', text: '当前会话没有工作目录。' }
    const input = String(invocation.rawInput ?? '').trim()
    const [action = 'list', ...rest] = input === '' ? [] : input.split(/\s+/u)
    try {
      const engine = await engineFor(cwd)
      if (action === 'list' || action === '') {
        const status = await engine.status(session.id)
        return { kind: 'success', text: renderList(status) }
      }
      if (action === 'help' || action === '--help' || action === '-h') {
        return { kind: 'success', text: USAGE }
      }
      if (action === 'snapshot') {
        const label = rest.join(' ').trim() || '手动还原点'
        const result = await engine.manualSnapshot(session.id, label)
        return {
          kind: 'success',
          text: `已创建还原点 ${result.checkpoint.id}（${statsOf(result.checkpoint)}）。`,
        }
      }
      if (action === 'restore') {
        const id = rest[0]
        const flags = new Set(rest.slice(1))
        if (id === undefined || !CHECKPOINT_ID_RE.test(id)) {
          return { kind: 'error', text: `需要一个合法的还原点 id。\n${USAGE}` }
        }
        const unknown = [...flags].filter((flag) => flag !== '--exact')
        if (unknown.length > 0) return { kind: 'error', text: `不认识的参数：${unknown.join(' ')}\n${USAGE}` }
        const mode = flags.has('--exact') ? 'exact' : 'overwrite'
        const result = await engine.restoreNow({
          sessionId: session.id,
          checkpointId: id,
          mode,
          signal: invocation.signal,
        })
        return {
          kind: 'success',
          text: [
            `已恢复到 ${result.targetId}（${result.mode === 'exact' ? '精确恢复' : '覆盖恢复'}）。`,
            `写入 ${String(result.writes)} 个文件，删除 ${String(result.deletes)} 个，+${String(result.addedLines)} −${String(result.deletedLines)}。`,
            `恢复前安全点：${result.safetyId}；恢复后快照：${result.checkpointId}。`,
            '对话上下文没有被改写；继续工作前请让 Agent 重新读取已回滚的文件。',
          ].join('\n'),
        }
      }
      if (action === 'recover') {
        const engineStatus = await engine.status(session.id)
        if (rest.length === 0) {
          if (engineStatus.journals.length === 0) return { kind: 'success', text: '没有未完成的恢复日志。' }
          return {
            kind: 'success',
            text: ['未完成的恢复日志：', ...engineStatus.journals.map((entry) => `${entry.planId}  ${formatTime(entry.createdAt)}  安全点 ${entry.safetyId}`), '运行 /rewind recover <planId> 回滚到安全点。'].join('\n'),
          }
        }
        const result = await engine.recoverJournal(rest[0], { signal: invocation.signal })
        return { kind: 'success', text: `已按恢复日志 ${result.planId} 回到安全点 ${result.safetyId}。` }
      }
      return { kind: 'error', text: `不认识的操作“${action}”。\n${USAGE}` }
    } catch (error) {
      surfaces.logger?.warn?.(`dsh-time-machine: /rewind ${input} 失败：${formatError(error)}`)
      return asError(error)
    }
  }
  return ctx.commands.register({
    name: 'rewind',
    description: '查看、创建或恢复工作区还原点（时光机）',
    input: { hint: '[list|snapshot|restore <id> [--exact]|recover]' },
    handler,
  })
}

export function registerTool(ctx, surfaces) {
  const { engineFor, sessionCwd, eligible } = surfaces
  const tool = {
    name: 'time_machine',
    description:
      'List, create, or restore workspace checkpoints recorded automatically by the DSH Time Machine plugin. Use restore ONLY when the user explicitly asks to undo or roll back file changes; never on your own initiative. The default restore mode overwrites files to their checkpoint contents but does not delete files added later, and always creates a safety checkpoint first. Exact mode (with deletions) is human-only and not exposed here. Returns JSON.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'snapshot', 'restore'],
          description: 'list recent checkpoints, create a manual checkpoint, or restore one.',
        },
        checkpointId: {
          type: 'string',
          description: 'Required for restore: the checkpoint id from list.',
        },
        label: {
          type: 'string',
          description: 'Optional short label for a manual snapshot.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 300_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) throw new Error('time_machine requires an owning top-level agent session')
      if (!eligible(session)) throw new Error('time_machine only works in a top-level session; subagents must ask their parent')
      const cwd = sessionCwd(session)
      if (cwd === undefined) throw new Error('this session has no working directory')
      const engine = await engineFor(cwd)
      if (args.action === 'list') {
        const status = await engine.status(session.id)
        return JSON.stringify({
          workspace: status.workspacePath,
          busy: status.busy,
          total: status.total,
          checkpoints: status.checkpoints.slice(0, 10),
        })
      }
      if (args.action === 'snapshot') {
        const result = await engine.manualSnapshot(session.id, args.label || 'manual checkpoint')
        return JSON.stringify(result)
      }
      if (args.action === 'restore') {
        if (typeof args.checkpointId !== 'string' || args.checkpointId === '') {
          throw new Error('checkpointId is required for restore')
        }
        const result = await engine.restoreNow({
          sessionId: session.id,
          checkpointId: args.checkpointId,
          mode: 'overwrite',
          signal: exec.signal,
          allowActiveSession: true,
        })
        return JSON.stringify(result)
      }
      throw new Error(`unknown action: ${String(args.action)}`)
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.action === 'restore' ? 'Restore workspace checkpoint' : 'Time Machine',
      kind: 'other',
      rawInput: args,
    }),
  }
  return ctx.tools.register(tool)
}
