window.__ModuleLoader__.load({
	id: "dsh-time-machine",
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
		const React = require("react")
		const ReactDOM = require("react-dom")

// ---- shared/protocol.js --------------------------------------
/**
 * 宿主与浏览器共用的协议字面量。
 *
 * 这个文件会被两边同时加载：宿主直接 import，客户端由零依赖构建拼进
 * 经典脚本。因此这里不能出现任何 `node:` 导入或浏览器专属 API。
 */

const PLUGIN_ID = 'dsh-time-machine'
const API_BASE = '/plugins/dsh-time-machine'
const ROUTES = Object.freeze({
  status: `${API_BASE}/status`,
  checkpoint: `${API_BASE}/checkpoint`,
  plan: `${API_BASE}/plan`,
  restore: `${API_BASE}/restore`,
  config: `${API_BASE}/config`,
})
const CONTROL_HEADER = 'x-dsh-time-machine-key'
const CONFIRM_PHRASE = 'RESTORE'
const MAX_BODY_BYTES = 1024 * 1024
const PLAN_TTL_MS = 5 * 60 * 1000
const CHECKPOINT_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{4}$/
const PLAN_ID_RE = /^p-\d{8}-\d{6}-[0-9a-f]{6}$/
const MAX_LABEL_CHARS = 80
const STATUS_CHECKPOINT_LIMIT = 50
const MAX_SAMPLE_FILES = 30

const CHECKPOINT_KINDS = Object.freeze(['auto', 'manual', 'safety', 'restore'])
const CHECKPOINT_PHASES = Object.freeze(['before', 'after'])
const RESTORE_MODES = Object.freeze(['overwrite', 'exact'])

const SETTINGS_VERSION = 1
const DEFAULT_CONFIG = Object.freeze({
  version: SETTINGS_VERSION,
  auto: true,
  beforeTurn: true,
  afterTurn: true,
  maxCheckpoints: 120,
  maxAgeDays: 14,
  timeoutMs: 30000,
  restoreTimeoutMs: 120000,
  maxRestoreFileBytes: 64 * 1024 * 1024,
  autoGc: true,
  excludes: ['.git/', 'node_modules/', '.dsh-time-machine/'],
})

const CONFIG_LIMITS = Object.freeze({
  maxCheckpoints: [10, 1000],
  maxAgeDays: [1, 365],
  timeoutMs: [5000, 120000],
  restoreTimeoutMs: [10000, 600000],
  maxRestoreFileBytes: [1024 * 1024, 1024 * 1024 * 1024],
})

const ERROR_CODES = Object.freeze({
  badRequest: 'BAD_REQUEST',
  unauthorized: 'UNAUTHORIZED',
  forbidden: 'FORBIDDEN',
  notFound: 'NOT_FOUND',
  sessionNotFound: 'SESSION_NOT_FOUND',
  sessionUnsupported: 'SESSION_UNSUPPORTED',
  sessionBusy: 'SESSION_BUSY',
  workspaceChanged: 'WORKSPACE_CHANGED',
  planNotFound: 'PLAN_NOT_FOUND',
  planExpired: 'PLAN_EXPIRED',
  checkpointNotFound: 'CHECKPOINT_NOT_FOUND',
  nothingToRestore: 'NOTHING_TO_RESTORE',
  confirmRequired: 'CONFIRM_REQUIRED',
  gitUnavailable: 'GIT_UNAVAILABLE',
  snapshotFailed: 'SNAPSHOT_FAILED',
  restoreFailed: 'RESTORE_FAILED',
  restoreRolledBack: 'RESTORE_ROLLED_BACK',
  rollbackFailed: 'ROLLBACK_FAILED',
  configInvalid: 'CONFIG_INVALID',
  requestFailed: 'REQUEST_FAILED',
})

// ---- src/client/locales.js -----------------------------------
/**
 * 时光机中英文案。两套键集必须完全一致（构建期会检查）。
 */

const zh = {
  'action.label': '时光机',
  'action.aria': '打开时光机：查看和恢复工作区还原点',

  'panel.title': '时光机',
  'panel.close': '关闭',
  'panel.refresh': '刷新',
  'panel.retry': '重试',
  'panel.tabs.timeline': '时间线',
  'panel.tabs.settings': '设置',
  'panel.count': '共 {count} 个还原点',
  'panel.more': '仅显示最近 {count} 个',
  'panel.busy': '会话正在运行。恢复暂时锁定；自动快照仍在继续。',
  'panel.autoOff': '自动记录已关闭；仍可手动创建还原点并恢复。',
  'panel.journal': '发现 {count} 个未完成的恢复日志。请在终端运行 dsh-time-machine recover。',
  'panel.lastError': '上次错误：{message}',
  'panel.loading': '正在读取还原点…',
  'panel.empty.title': '还没有还原点',
  'panel.empty.body': '每个改变文件的轮次都会自动留下还原点；也可以现在手动创建一个。',
  'panel.empty.action': '创建第一个还原点',
  'panel.snapshot': '新建还原点',
  'panel.snapshotting': '创建中…',
  'panel.snapshotDone': '已创建 {id}',
  'panel.otherSession': '其他会话',
  'panel.current': '最新',
  'panel.restore': '恢复',
  'panel.restoreLocked': '会话运行中，暂停恢复',
  'panel.turn': '第 {turn} 轮',

  'panel.kind.auto': '自动',
  'panel.kind.manual': '手动',
  'panel.kind.safety': '安全点',
  'panel.kind.restore': '恢复后',
  'panel.phase.before': '轮前',
  'panel.phase.after': '轮后',
  'panel.initial': '初始快照',
  'panel.files': '{count} 个文件',
  'panel.lines': '+{added} −{deleted}',
  'panel.noChanges': '无文件变化',

  'panel.confirm.back': '返回时间线',
  'panel.confirm.title': '恢复到这个还原点',
  'panel.confirm.time': '{time} · {kind}',
  'panel.confirm.mode': '恢复方式',
  'panel.confirm.overwrite': '覆盖文件',
  'panel.confirm.overwriteHint': '把还原点中的文件写回工作区；不删除之后新增的文件。',
  'panel.confirm.exact': '精确还原',
  'panel.confirm.exactHint': '同时删除还原点之后新增的文件；忽略文件永远不动。',
  'panel.confirm.exactCheck': '我明白精确还原会删除部分文件',
  'panel.confirm.plan': '计算影响…',
  'panel.confirm.planFailed': '无法预览：{message}',
  'panel.confirm.summary': '将写入 {writes} 个文件，删除 {deletes} 个',
  'panel.confirm.diff': '+{added} −{deleted} 行',
  'panel.confirm.sample': '涉及文件',
  'panel.confirm.more': '另有 {count} 个文件',
  'panel.confirm.safety': '恢复前会自动创建安全点；如果恢复失败，会自动回滚。',
  'panel.confirm.cancel': '取消',
  'panel.confirm.apply': '确认恢复',
  'panel.confirm.applying': '正在恢复…',
  'panel.confirm.stale': '工作区在预览后发生了变化，请重新计算影响。',
  'panel.confirm.replan': '重新计算',
  'panel.confirm.write': '写入',
  'panel.confirm.delete': '删除',

  'panel.result.title': '恢复完成',
  'panel.result.summary': '写入 {writes} 个文件 · 删除 {deletes} 个',
  'panel.result.ids': '安全点 {safety} · 恢复后快照 {checkpoint}',
  'panel.result.target': '目标还原点 {target}',
  'panel.result.hint': '对话上下文保持不变。继续之前，请让 Agent 重新读取已回滚的文件。',
  'panel.result.done': '回到时间线',

  'panel.settings.title': '时光机设置',
  'panel.settings.global': '设置保存在宿主，所有会话共用。',
  'panel.settings.auto': '自动记录',
  'panel.settings.autoHint': '关闭后不再自动创建还原点；手动快照和恢复仍然可用。',
  'panel.settings.before': '轮次开始前',
  'panel.settings.after': '轮次完成后',
  'panel.settings.max': '每个工作区保留',
  'panel.settings.maxUnit': '个还原点',
  'panel.settings.age': '最长保留',
  'panel.settings.ageUnit': '天',
  'panel.settings.timeout': '单次快照超时',
  'panel.settings.timeoutUnit': '毫秒',
  'panel.settings.excludes': '额外排除',
  'panel.settings.excludesHint': '每行一个 gitignore 规则；默认排除 .git、node_modules 和插件数据目录。',
  'panel.settings.save': '保存',
  'panel.settings.saving': '保存中…',
  'panel.settings.saved': '已保存',
  'panel.settings.issue': '配置已修正：{issue}',
  'panel.settings.failed': '保存失败：{message}',

  'error.fetch': '读取失败：{message}',
  'error.plan': '预览失败：{message}',
  'error.restore': '恢复失败：{message}',
  'error.unauthorized': '控制密钥已失效，请关闭面板后重新打开。',
  'error.workspaceChanged': '工作区已变化，请重新预览。',
  'error.sessionBusy': '会话正在运行，请先停止当前轮次。',
  'error.gitUnavailable': '宿主上没有可用的 git，时光机不可用。',
  'error.sessionUnsupported': '当前会话不支持时光机（需要顶层会话与工作目录）。',
  'error.nothingToRestore': '当前工作区已经与这个还原点一致（按所选模式），无需恢复。',
  'error.planExpired': '恢复计划已过期，请重新预览。',
  'error.planNotFound': '恢复计划不存在或已失效，请重新预览。',
  'error.checkpointNotFound': '找不到这个还原点，或它的快照对象已经被清理。',

  'global.justNow': '刚刚',
  'global.secondsAgo': '{count} 秒前',
  'global.minutesAgo': '{count} 分钟前',
  'global.hoursAgo': '{count} 小时前',
  'global.daysAgo': '{count} 天前',
  'global.today': '今天',
  'global.yesterday': '昨天',
  'global.version': 'v{version}',
  'global.copy': '复制 id',
  'global.copied': '已复制',
}

const en = {
  'action.label': 'Time Machine',
  'action.aria': 'Open Time Machine: view and restore workspace checkpoints',

  'panel.title': 'Time Machine',
  'panel.close': 'Close',
  'panel.refresh': 'Refresh',
  'panel.retry': 'Retry',
  'panel.tabs.timeline': 'Timeline',
  'panel.tabs.settings': 'Settings',
  'panel.count': '{count} checkpoints',
  'panel.more': 'Showing the latest {count} only',
  'panel.busy': 'The session is running. Restore is locked until this turn stops; automatic checkpoints continue.',
  'panel.autoOff': 'Automatic checkpoints are off; manual checkpoints and restores still work.',
  'panel.journal': '{count} unfinished restore journal(s) found. Run dsh-time-machine recover in a terminal.',
  'panel.lastError': 'Last error: {message}',
  'panel.loading': 'Reading checkpoints…',
  'panel.empty.title': 'No checkpoints yet',
  'panel.empty.body': 'Every turn that changes files leaves a checkpoint. You can also create one now.',
  'panel.empty.action': 'Create the first checkpoint',
  'panel.snapshot': 'New checkpoint',
  'panel.snapshotting': 'Creating…',
  'panel.snapshotDone': 'Created {id}',
  'panel.otherSession': 'Other session',
  'panel.current': 'Latest',
  'panel.restore': 'Restore',
  'panel.restoreLocked': 'Session running; restore locked',
  'panel.turn': 'Turn {turn}',

  'panel.kind.auto': 'Auto',
  'panel.kind.manual': 'Manual',
  'panel.kind.safety': 'Safety',
  'panel.kind.restore': 'After restore',
  'panel.phase.before': 'before turn',
  'panel.phase.after': 'after turn',
  'panel.initial': 'Initial snapshot',
  'panel.files': '{count} files',
  'panel.lines': '+{added} −{deleted}',
  'panel.noChanges': 'No file changes',

  'panel.confirm.back': 'Back to timeline',
  'panel.confirm.title': 'Restore this checkpoint',
  'panel.confirm.time': '{time} · {kind}',
  'panel.confirm.mode': 'Restore mode',
  'panel.confirm.overwrite': 'Overwrite files',
  'panel.confirm.overwriteHint': 'Write checkpoint contents back; files added later are kept.',
  'panel.confirm.exact': 'Exact restore',
  'panel.confirm.exactHint': 'Also delete files added after the checkpoint; ignored files are never touched.',
  'panel.confirm.exactCheck': 'I understand exact restore deletes some files',
  'panel.confirm.plan': 'Calculating impact…',
  'panel.confirm.planFailed': 'Cannot preview: {message}',
  'panel.confirm.summary': 'Write {writes} files, delete {deletes}',
  'panel.confirm.diff': '+{added} −{deleted} lines',
  'panel.confirm.sample': 'Files',
  'panel.confirm.more': '{count} more files',
  'panel.confirm.safety': 'A safety checkpoint is created first; a failed restore rolls back automatically.',
  'panel.confirm.cancel': 'Cancel',
  'panel.confirm.apply': 'Restore now',
  'panel.confirm.applying': 'Restoring…',
  'panel.confirm.stale': 'The workspace changed after the preview. Recalculate the impact.',
  'panel.confirm.replan': 'Recalculate',
  'panel.confirm.write': 'write',
  'panel.confirm.delete': 'delete',

  'panel.result.title': 'Restore complete',
  'panel.result.summary': 'Wrote {writes} files · deleted {deletes}',
  'panel.result.ids': 'Safety {safety} · post-restore checkpoint {checkpoint}',
  'panel.result.target': 'Target checkpoint {target}',
  'panel.result.hint': 'Conversation context is unchanged. Ask the agent to re-read the restored files before continuing.',
  'panel.result.done': 'Back to timeline',

  'panel.settings.title': 'Time Machine settings',
  'panel.settings.global': 'Settings live on the host and apply to every session.',
  'panel.settings.auto': 'Automatic checkpoints',
  'panel.settings.autoHint': 'Off disables automatic checkpoints; manual snapshots and restores still work.',
  'panel.settings.before': 'Before each turn',
  'panel.settings.after': 'After each turn',
  'panel.settings.max': 'Keep per workspace',
  'panel.settings.maxUnit': 'checkpoints',
  'panel.settings.age': 'Retain for',
  'panel.settings.ageUnit': 'days',
  'panel.settings.timeout': 'Snapshot timeout',
  'panel.settings.timeoutUnit': 'ms',
  'panel.settings.excludes': 'Extra excludes',
  'panel.settings.excludesHint': 'One gitignore pattern per line; .git, node_modules and the plugin data directory are always excluded.',
  'panel.settings.save': 'Save',
  'panel.settings.saving': 'Saving…',
  'panel.settings.saved': 'Saved',
  'panel.settings.issue': 'Config corrected: {issue}',
  'panel.settings.failed': 'Save failed: {message}',

  'error.fetch': 'Load failed: {message}',
  'error.plan': 'Preview failed: {message}',
  'error.restore': 'Restore failed: {message}',
  'error.unauthorized': 'The control key expired. Close and reopen the panel.',
  'error.workspaceChanged': 'The workspace changed. Preview the restore again.',
  'error.sessionBusy': 'The session is running. Stop the current turn first.',
  'error.gitUnavailable': 'No usable git on the host; Time Machine is unavailable.',
  'error.sessionUnsupported': 'This session does not support Time Machine (a top-level session with a working directory is required).',
  'error.nothingToRestore': 'The workspace already matches this checkpoint for the selected mode; nothing to restore.',
  'error.planExpired': 'The restore plan expired. Preview the restore again.',
  'error.planNotFound': 'The restore plan no longer exists. Preview the restore again.',
  'error.checkpointNotFound': 'This checkpoint is missing, or its snapshot objects were already pruned.',

  'global.justNow': 'just now',
  'global.secondsAgo': '{count}s ago',
  'global.minutesAgo': '{count}m ago',
  'global.hoursAgo': '{count}h ago',
  'global.daysAgo': '{count}d ago',
  'global.today': 'Today',
  'global.yesterday': 'Yesterday',
  'global.version': 'v{version}',
  'global.copy': 'Copy id',
  'global.copied': 'Copied',
}

// ---- src/client/api.js ---------------------------------------
class ApiError extends Error {
  constructor(code, message, details, status) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.details = details
    this.status = status
  }
}

/**
 * 浏览器的同源 API 客户端。控制密钥从状态接口取得，之后的写请求带上它；
 * 宿主重启后旧密钥失效，面板下一次轮询会拿到新密钥。
 */
function createApi() {
  let controlKey

  async function send(method, path, { body, signal, timeoutMs = 60_000 } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const combined = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
    const headers = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (controlKey !== undefined) headers[CONTROL_HEADER] = controlKey
    let response
    try {
      response = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combined,
        cache: 'no-store',
        credentials: 'same-origin',
      })
    } catch (error) {
      clearTimeout(timer)
      if (controller.signal.aborted) throw new ApiError('TIMEOUT', '请求超时', undefined, undefined)
      if (signal?.aborted) throw new ApiError('ABORTED', '请求已取消', undefined, undefined)
      throw new ApiError('NETWORK', error instanceof Error ? error.message : String(error), undefined, undefined)
    }
    clearTimeout(timer)
    const text = await response.text()
    let payload
    try {
      payload = text === '' ? undefined : JSON.parse(text)
    } catch {
      throw new ApiError('BAD_RESPONSE', `宿主返回了非 JSON 响应（HTTP ${String(response.status)}）`, undefined, response.status)
    }
    if (payload?.key !== undefined) controlKey = payload.key
    if (!response.ok || payload?.ok === false) {
      const code = payload?.error?.code ?? `HTTP_${String(response.status)}`
      const message = payload?.error?.message ?? response.statusText ?? '请求失败'
      if (code === 'UNAUTHORIZED' || response.status === 403) controlKey = undefined
      throw new ApiError(code, message, payload?.error?.details, response.status)
    }
    return payload
  }

  return {
    get controlKey() {
      return controlKey
    },
    async status(sessionId, signal) {
      return send('GET', `${ROUTES.status}?sessionId=${encodeURIComponent(sessionId)}`, {
        signal,
        timeoutMs: 30_000,
      })
    },
    async checkpoint(sessionId, label, signal) {
      return send('POST', ROUTES.checkpoint, {
        body: { sessionId, label },
        signal,
        timeoutMs: 60_000,
      })
    },
    async plan(sessionId, checkpointId, mode, signal) {
      return send('POST', ROUTES.plan, {
        body: { sessionId, checkpointId, mode },
        signal,
        timeoutMs: 120_000,
      })
    },
    async restore(sessionId, planId, signal) {
      return send('POST', ROUTES.restore, {
        body: { sessionId, planId, confirm: CONFIRM_PHRASE },
        signal,
        timeoutMs: 300_000,
      })
    },
    async saveConfig(sessionId, config, signal) {
      return send('POST', ROUTES.config, {
        body: { sessionId, config },
        signal,
        timeoutMs: 30_000,
      })
    },
  }
}

// ---- src/client/format.js ------------------------------------
/** 客户端展示格式化：时间、统计、类型标签。全部是纯函数。 */

function formatWhen(iso, locale, t, now = Date.now()) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return String(iso ?? '')
  const current = new Date(now)
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
  if (sameDay(date, current)) return time
  const yesterday = new Date(current)
  yesterday.setDate(current.getDate() - 1)
  if (sameDay(date, yesterday)) return `${t('global.yesterday')} ${time}`
  const day = new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }).format(date)
  return `${day} ${time}`
}

function formatFullTime(iso, locale) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return String(iso ?? '')
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

function sameDay(left, right) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

function formatAgo(iso, t, now = Date.now()) {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 10) return t('global.justNow')
  if (seconds < 60) return t('global.secondsAgo', { count: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('global.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('global.hoursAgo', { count: hours })
  return t('global.daysAgo', { count: Math.floor(hours / 24) })
}

function formatStats(entry, t) {
  const stats = entry?.stats ?? {}
  if (stats.initial === true) return t('panel.initial')
  const files = Number(stats.files ?? 0)
  if (files === 0) return t('panel.noChanges')
  const parts = [t('panel.files', { count: files })]
  if (Number(stats.added ?? 0) > 0 || Number(stats.deleted ?? 0) > 0) {
    parts.push(t('panel.lines', { added: stats.added ?? 0, deleted: stats.deleted ?? 0 }))
  }
  return parts.join(' · ')
}

function formatKind(entry, t) {
  if (entry?.kind === 'auto') {
    const phase = entry.phase === 'before' ? t('panel.phase.before') : t('panel.phase.after')
    return `${t('panel.kind.auto')} · ${phase}`
  }
  if (typeof entry?.label === 'string' && entry.label !== '') {
    if (entry.kind === 'safety' || entry.kind === 'restore') return entry.label
    return entry.label
  }
  return t(`panel.kind.${entry?.kind ?? 'manual'}`)
}

function formatTurn(entry, t) {
  return entry?.turn === null || entry?.turn === undefined ? '' : t('panel.turn', { turn: entry.turn })
}

function shortCheckpointId(id) {
  if (typeof id !== 'string') return ''
  return id.length > 9 ? id.slice(9) : id
}

function formatListLine(entry, t) {
  const bits = [formatKind(entry, t)]
  const turn = formatTurn(entry, t)
  if (turn !== '') bits.push(turn)
  bits.push(formatStats(entry, t))
  return bits.join(' · ')
}

function statusMessage(error, t) {
  const code = error?.code
  if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') return t('error.unauthorized')
  if (code === 'WORKSPACE_CHANGED') return t('error.workspaceChanged')
  if (code === 'SESSION_BUSY') return t('error.sessionBusy')
  if (code === 'GIT_UNAVAILABLE') return t('error.gitUnavailable')
  if (code === 'SESSION_UNSUPPORTED') return t('error.sessionUnsupported')
  if (code === 'NOTHING_TO_RESTORE') return t('error.nothingToRestore')
  if (code === 'PLAN_EXPIRED') return t('error.planExpired')
  if (code === 'PLAN_NOT_FOUND') return t('error.planNotFound')
  if (code === 'CHECKPOINT_NOT_FOUND') return t('error.checkpointNotFound')
  return error?.message ?? String(error)
}

// ---- src/client/icons.js -------------------------------------
/** 时光机图标：全部是 currentColor 的内联 SVG，不引入图标包。 */

function iconProps(size) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  }
}

function IconHistory(props) {
  const size = props?.size ?? 16
  return React.createElement(
    'svg',
    { ...iconProps(size), className: props?.className },
    React.createElement('path', { d: 'M3.5 12a8.5 8.5 0 1 0 2.2-5.7' }),
    React.createElement('path', { d: 'M3.5 4.8v4.4h4.4' }),
    React.createElement('path', { d: 'M12 7.5V12l3.2 2' })
  )
}

function IconClose(props) {
  const size = props?.size ?? 15
  return React.createElement(
    'svg',
    { ...iconProps(size), className: props?.className },
    React.createElement('path', { d: 'M6 6l12 12M18 6L6 18' })
  )
}

function IconRefresh(props) {
  const size = props?.size ?? 14
  return React.createElement(
    'svg',
    { ...iconProps(size), className: props?.className },
    React.createElement('path', { d: 'M20 12a8 8 0 0 1-13.7 5.6' }),
    React.createElement('path', { d: 'M4.3 21v-3.4h3.4' }),
    React.createElement('path', { d: 'M4 12a8 8 0 0 1 13.7-5.6' }),
    React.createElement('path', { d: 'M19.7 3v3.4h-3.4' })
  )
}

function IconTune(props) {
  const size = props?.size ?? 14
  return React.createElement(
    'svg',
    { ...iconProps(size), className: props?.className },
    React.createElement('path', { d: 'M4 7h16M4 12h16M4 17h16' }),
    React.createElement('circle', { cx: 9, cy: 7, r: 1.8, fill: 'currentColor', stroke: 'none' }),
    React.createElement('circle', { cx: 15, cy: 12, r: 1.8, fill: 'currentColor', stroke: 'none' }),
    React.createElement('circle', { cx: 8, cy: 17, r: 1.8, fill: 'currentColor', stroke: 'none' })
  )
}

function IconCameraPlus(props) {
  const size = props?.size ?? 15
  return React.createElement(
    'svg',
    { ...iconProps(size), className: props?.className },
    React.createElement('path', { d: 'M4 8.5h3l1.4-2h7.2L17 8.5h3v10H4z' }),
    React.createElement('circle', { cx: 12, cy: 13.2, r: 3.2 }),
    React.createElement('path', { d: 'M12 10v6.4M8.8 13.2h6.4' })
  )
}

function IconShield(props) {
  const size = props?.size ?? 15
  return React.createElement(
    'svg',
    { ...iconProps(size), className: props?.className },
    React.createElement('path', { d: 'M12 3.5l7 2.6v5.3c0 4.5-3 7.6-7 9.1-4-1.5-7-4.6-7-9.1V6.1z' }),
    React.createElement('path', { d: 'M8.8 12.2l2.1 2.1 4.3-4.5' })
  )
}

function IconWarning(props) {
  const size = props?.size ?? 14
  return React.createElement(
    'svg',
    { ...iconProps(size), className: props?.className },
    React.createElement('path', { d: 'M12 3.8l9 16.2H3z' }),
    React.createElement('path', { d: 'M12 9.5v4.6M12 17.2v.2' })
  )
}

function IconArrowLeft(props) {
  const size = props?.size ?? 14
  return React.createElement(
    'svg',
    { ...iconProps(size), className: props?.className },
    React.createElement('path', { d: 'M19 12H5M11 6l-6 6 6 6' })
  )
}

function IconChevronRight(props) {
  const size = props?.size ?? 14
  return React.createElement(
    'svg',
    { ...iconProps(size), className: props?.className },
    React.createElement('path', { d: 'M9 5l7 7-7 7' })
  )
}

function IconCheck(props) {
  const size = props?.size ?? 16
  return React.createElement(
    'svg',
    { ...iconProps(size), className: props?.className },
    React.createElement('path', { d: 'M4.5 12.5l5 5L19.5 6.8' })
  )
}

function IconDot(props) {
  const size = props?.size ?? 7
  return React.createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 8 8',
      fill: 'currentColor',
      'aria-hidden': 'true',
      focusable: 'false',
      className: props?.className,
    },
    React.createElement('circle', { cx: 4, cy: 4, r: 4 })
  )
}

function IconSpinner(props) {
  const size = props?.size ?? 14
  return React.createElement(
    'svg',
    {
      ...iconProps(size),
      className: `dtm_spin ${props?.className ?? ''}`.trim(),
    },
    React.createElement('path', { d: 'M12 3.5a8.5 8.5 0 1 1-6 2.5' })
  )
}

// ---- src/client/ui.js ----------------------------------------
/** 客户端小部件：按钮、横幅、加载态。用 h() 而不是 JSX，构建器无需转译。 */

const h = React.createElement

function DtmBanner(props) {
  return h(
    'div',
    { className: 'dtm_banner', 'data-kind': props.kind ?? 'info', role: props.role ?? 'status' },
    h('span', { className: 'dtm_bannerText' }, props.children),
    props.action ?? null
  )
}

function DtmButton(props) {
  return h(
    'button',
    {
      type: props.type ?? 'button',
      className: `dtm_button ${props.className ?? ''}`.trim(),
      'data-variant': props.variant ?? 'ghost',
      'data-size': props.size ?? 'md',
      disabled: props.disabled === true,
      onClick: props.disabled === true ? undefined : props.onClick,
      title: props.title,
      'aria-label': props.ariaLabel,
    },
    props.children
  )
}

function DtmIconButton(props) {
  return h(
    'button',
    {
      type: 'button',
      className: `dtm_iconButton ${props.className ?? ''}`.trim(),
      'aria-label': props.label,
      title: props.label,
      disabled: props.disabled === true,
      onClick: props.disabled === true ? undefined : props.onClick,
    },
    props.children
  )
}

function DtmSpinner(props) {
  return h(
    'span',
    { className: 'dtm_loading', role: 'status' },
    h('span', { className: 'dtm_spinner', 'aria-hidden': 'true' }),
    props.label === undefined ? null : h('span', null, props.label)
  )
}

// ---- src/client/settings.js ----------------------------------
function settingsDraftOf(settings) {
  const source = settings ?? DEFAULT_CONFIG
  return {
    auto: source.auto !== false,
    beforeTurn: source.beforeTurn !== false,
    afterTurn: source.afterTurn !== false,
    maxCheckpoints: String(source.maxCheckpoints ?? DEFAULT_CONFIG.maxCheckpoints),
    maxAgeDays: String(source.maxAgeDays ?? DEFAULT_CONFIG.maxAgeDays),
    timeoutMs: String(source.timeoutMs ?? DEFAULT_CONFIG.timeoutMs),
    excludesText: Array.isArray(source.excludes) ? source.excludes.join('\n') : DEFAULT_CONFIG.excludes.join('\n'),
  }
}

function settingsPayloadOf(draft) {
  return {
    auto: draft.auto === true,
    beforeTurn: draft.beforeTurn === true,
    afterTurn: draft.afterTurn === true,
    maxCheckpoints: Number(draft.maxCheckpoints),
    maxAgeDays: Number(draft.maxAgeDays),
    timeoutMs: Number(draft.timeoutMs),
    excludes: String(draft.excludesText ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#')),
  }
}

function DtmSwitch(props) {
  return h(
    'button',
    {
      type: 'button',
      role: 'switch',
      className: 'dtm_switch',
      'aria-checked': props.checked === true,
      'aria-label': props.label,
      'data-on': props.checked === true ? 'true' : 'false',
      disabled: props.disabled === true,
      onClick: () => {
        if (props.disabled !== true) props.onChange(props.checked !== true)
      },
    },
    h('span', { className: 'dtm_switchThumb', 'aria-hidden': 'true' })
  )
}

function DtmField(props) {
  return h(
    'div',
    { className: 'dtm_field', 'data-field': props.name },
    h(
      'div',
      { className: 'dtm_fieldCopy' },
      h('div', { className: 'dtm_fieldTitle' }, props.title),
      h('div', { className: 'dtm_fieldHint' }, props.hint)
    ),
    h('div', { className: 'dtm_fieldControl' }, props.children)
  )
}

function DtmNumberInput(props) {
  return h('input', {
    type: 'number',
    className: 'dtm_input',
    value: props.value,
    min: props.min,
    max: props.max,
    step: props.step ?? 1,
    'aria-label': props.label,
    onChange: (event) => props.onChange(event.target.value),
  })
}

function SettingsView(props) {
  const { t, draft, saving, issues, error, onChange, onSave } = props
  if (draft === null || draft === undefined) {
    return h('div', { className: 'dtm_view' }, h(DtmSpinner, { label: t('panel.loading') }))
  }
  return h(
    'div',
    { className: 'dtm_view dtm_settings' },
    h('div', { className: 'dtm_viewTitle', style: { marginBottom: '2px' } }, t('panel.settings.title')),
    h('p', { className: 'dtm_viewHint' }, t('panel.settings.global')),
    error === null || error === undefined ? null : h(DtmBanner, { kind: 'error' }, error),
    issues !== undefined && issues.length > 0
      ? h(
          DtmBanner,
          { kind: 'warning' },
          h(
            'span',
            null,
            issues.map((issue, index) => h('span', { key: `${String(index)}:${issue}` }, t('panel.settings.issue', { issue }), index < issues.length - 1 ? ' ' : ''))
          )
        )
      : null,

    h(
      DtmField,
      { name: 'auto', title: t('panel.settings.auto'), hint: t('panel.settings.autoHint') },
      h(DtmSwitch, {
        checked: draft.auto,
        label: t('panel.settings.auto'),
        onChange: (value) => onChange({ ...draft, auto: value }),
      })
    ),
    h(
      'div',
      { className: 'dtm_fieldGroup', 'data-disabled': draft.auto ? 'false' : 'true' },
      h(
        DtmField,
        { name: 'before', title: t('panel.settings.before'), hint: '' },
        h(DtmSwitch, {
          checked: draft.beforeTurn,
          label: t('panel.settings.before'),
          disabled: !draft.auto,
          onChange: (value) => onChange({ ...draft, beforeTurn: value }),
        })
      ),
      h(
        DtmField,
        { name: 'after', title: t('panel.settings.after'), hint: '' },
        h(DtmSwitch, {
          checked: draft.afterTurn,
          label: t('panel.settings.after'),
          disabled: !draft.auto,
          onChange: (value) => onChange({ ...draft, afterTurn: value }),
        })
      )
    ),
    h(
      DtmField,
      { name: 'max', title: t('panel.settings.max'), hint: t('panel.settings.maxUnit') },
      h(DtmNumberInput, {
        value: draft.maxCheckpoints,
        min: 10,
        max: 1000,
        label: t('panel.settings.max'),
        onChange: (value) => onChange({ ...draft, maxCheckpoints: value }),
      })
    ),
    h(
      DtmField,
      { name: 'age', title: t('panel.settings.age'), hint: t('panel.settings.ageUnit') },
      h(DtmNumberInput, {
        value: draft.maxAgeDays,
        min: 1,
        max: 365,
        label: t('panel.settings.age'),
        onChange: (value) => onChange({ ...draft, maxAgeDays: value }),
      })
    ),
    h(
      DtmField,
      { name: 'timeout', title: t('panel.settings.timeout'), hint: t('panel.settings.timeoutUnit') },
      h(DtmNumberInput, {
        value: draft.timeoutMs,
        min: 5000,
        max: 120000,
        step: 1000,
        label: t('panel.settings.timeout'),
        onChange: (value) => onChange({ ...draft, timeoutMs: value }),
      })
    ),
    h(
      'div',
      { className: 'dtm_field dtm_fieldBlock', 'data-field': 'excludes' },
      h(
        'div',
        { className: 'dtm_fieldCopy' },
        h('div', { className: 'dtm_fieldTitle' }, t('panel.settings.excludes')),
        h('div', { className: 'dtm_fieldHint' }, t('panel.settings.excludesHint'))
      ),
      h('textarea', {
        className: 'dtm_textarea',
        rows: 5,
        value: draft.excludesText,
        'aria-label': t('panel.settings.excludes'),
        spellCheck: false,
        onChange: (event) => onChange({ ...draft, excludesText: event.target.value }),
      })
    ),
    h(
      'div',
      { className: 'dtm_actions' },
      h(
        DtmButton,
        {
          variant: 'primary',
          disabled: saving,
          onClick: () => onSave(settingsPayloadOf(draft)),
        },
        saving ? h(React.Fragment, null, h(DtmSpinner, null), t('panel.settings.saving')) : t('panel.settings.save')
      )
    )
  )
}

// ---- src/client/panel.js -------------------------------------
const DTM_PANEL_WIDTH = 420
const DTM_PANEL_GAP = 8

function activeLocale() {
  if (typeof document !== 'undefined' && typeof document.documentElement?.lang === 'string' && document.documentElement.lang !== '') {
    return document.documentElement.lang
  }
  if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') return navigator.language
  return 'zh-CN'
}

function useStableApi() {
  const ref = React.useRef(null)
  if (ref.current === null) ref.current = createApi()
  return ref.current
}

function useAnchorPosition(rootRef, open) {
  const [style, setStyle] = React.useState(null)
  const measure = React.useCallback(() => {
    const node = rootRef.current
    if (node === null || typeof window === 'undefined') return
    const rect = node.getBoundingClientRect()
    const width = Math.min(DTM_PANEL_WIDTH, window.innerWidth - DTM_PANEL_GAP * 2)
    const maxLeft = Math.max(DTM_PANEL_GAP, window.innerWidth - width - DTM_PANEL_GAP)
    // 会话标题栏的动作靠近标题左侧；按右边缘对齐会把 420px 面板推到侧栏上。
    // 左边缘对齐按钮，再夹进视口，面板落在对话区内。
    const left = Math.min(Math.max(DTM_PANEL_GAP, rect.left), maxLeft)
    const top = Math.max(DTM_PANEL_GAP, rect.bottom + DTM_PANEL_GAP)
    const maxHeight = Math.max(160, window.innerHeight - top - DTM_PANEL_GAP)
    setStyle({
      left: `${Math.round(left)}px`,
      top: `${Math.round(top)}px`,
      width: `${Math.round(width)}px`,
      maxHeight: `${Math.round(maxHeight)}px`,
    })
  }, [rootRef])

  React.useEffect(() => {
    if (open !== true) {
      setStyle(null)
      return undefined
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [measure, open])
  return style
}

function errorMessageOf(error, t) {
  return statusMessage(error, t)
}

function PanelHeader(props) {
  const { t, status, view, loading, restoring, onRefresh, onClose, onTimeline, onSettings, onBack } = props
  const canSettings = status !== null && status !== undefined
  const showBack = view === 'confirm' || view === 'result'
  return h(
    'div',
    { className: 'dtm_panelHead' },
    h(
      'div',
      { className: 'dtm_brand' },
      h('span', { className: 'dtm_brandIcon', 'aria-hidden': 'true' }, h(IconHistory, { size: 19 })),
      h(
        'div',
        { className: 'dtm_brandCopy' },
        h(
          'div',
          { className: 'dtm_brandTitle' },
          h('span', null, t('panel.title')),
          status?.version ? h('span', { className: 'dtm_version' }, t('global.version', { version: status.version })) : null
        ),
        h('div', { className: 'dtm_path', title: status?.workspacePath ?? '' }, status?.workspacePath ?? '—')
      )
    ),
    h(
      'div',
      { className: 'dtm_headActions' },
      h(
        DtmIconButton,
        {
          label: t('panel.refresh'),
          disabled: loading || restoring,
          onClick: onRefresh,
        },
        loading ? h('span', { className: 'dtm_spinner', 'aria-hidden': 'true' }) : h(IconRefresh, { size: 14 })
      ),
      h(
        DtmIconButton,
        {
          label: t('panel.close'),
          disabled: restoring,
          onClick: onClose,
        },
        h(IconClose, { size: 15 })
      )
    ),
    showBack
      ? h(
          'div',
          { className: 'dtm_subBar' },
          h(
            'button',
            { type: 'button', className: 'dtm_back', onClick: onBack, disabled: restoring },
            h(IconArrowLeft, { size: 13 }),
            h('span', null, t('panel.confirm.back'))
          )
        )
      : h(
          'div',
          { className: 'dtm_tabs', role: 'tablist' },
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              className: 'dtm_tab',
              'aria-selected': view === 'timeline',
              'data-active': view === 'timeline' ? 'true' : 'false',
              onClick: onTimeline,
              disabled: restoring,
            },
            h(IconHistory, { size: 13 }),
            h('span', null, t('panel.tabs.timeline'))
          ),
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              className: 'dtm_tab',
              'aria-selected': view === 'settings',
              'data-active': view === 'settings' ? 'true' : 'false',
              onClick: onSettings,
              disabled: !canSettings || restoring,
            },
            h(IconTune, { size: 13 }),
            h('span', null, t('panel.tabs.settings'))
          )
        )
  )
}

function CommonBanners(props) {
  const { t, status, notice, error } = props
  const banners = []
  if (notice !== null && notice !== undefined && notice !== '') {
    banners.push(h(DtmBanner, { key: 'notice', kind: 'success' }, notice))
  }
  if (status?.busy === true) {
    banners.push(h(DtmBanner, { key: 'busy', kind: 'info' }, t('panel.busy')))
  }
  if (status?.settings?.auto === false) {
    banners.push(h(DtmBanner, { key: 'autoOff', kind: 'info' }, t('panel.autoOff')))
  }
  if (Array.isArray(status?.journals) && status.journals.length > 0) {
    banners.push(h(DtmBanner, { key: 'journals', kind: 'warning' }, t('panel.journal', { count: status.journals.length })))
  }
  if (status?.lastError !== null && status?.lastError !== undefined) {
    banners.push(
      h(
        DtmBanner,
        { key: 'lastError', kind: 'warning' },
        t('panel.lastError', { message: status.lastError.message })
      )
    )
  }
  if (error !== null && error !== undefined) {
    banners.push(
      h(
        DtmBanner,
        {
          key: 'error',
          kind: 'error',
          action: h(
            DtmButton,
            { variant: 'ghost', size: 'sm', onClick: props.onRetry },
            t('panel.retry')
          ),
        },
        errorMessageOf(error, t)
      )
    )
  }
  return banners.length === 0 ? null : h('div', { className: 'dtm_banners' }, banners)
}

function CheckpointRow(props) {
  const { t, entry, busy, locale, otherSession, onSelect } = props
  const title = entry.label || formatKind(entry, t)
  const kindLine = entry.label
    ? `${t(`panel.kind.${entry.kind}`)}${formatTurn(entry, t) ? ` · ${formatTurn(entry, t)}` : ''}`
    : formatTurn(entry, t)
  return h(
    'div',
    { className: 'dtm_row', 'data-kind': entry.kind, 'data-current': entry.current ? 'true' : 'false', role: 'listitem' },
    h('span', { className: 'dtm_rowDot', 'aria-hidden': 'true' }),
    h(
      'div',
      { className: 'dtm_rowBody' },
      h(
        'div',
        { className: 'dtm_rowTop' },
        h('span', { className: 'dtm_rowTitle', title: entry.id }, title),
        entry.current ? h('span', { className: 'dtm_badge', 'data-tone': 'current' }, t('panel.current')) : null,
        otherSession ? h('span', { className: 'dtm_badge' }, t('panel.otherSession')) : null,
        h(
          'span',
          { className: 'dtm_rowTime', title: `${formatFullTime(entry.createdAt, locale)} · ${formatAgo(entry.createdAt, t)}` },
          formatWhen(entry.createdAt, locale, t)
        )
      ),
      h(
        'div',
        { className: 'dtm_rowMeta' },
        kindLine === '' ? null : h('span', null, kindLine),
        kindLine === '' ? null : h('span', { className: 'dtm_sep', 'aria-hidden': 'true' }, '·'),
        h('span', null, formatStats(entry, t))
      )
    ),
    h(
      DtmButton,
      {
        variant: 'ghost',
        size: 'sm',
        disabled: busy,
        title: busy ? t('panel.restoreLocked') : undefined,
        onClick: () => onSelect(entry),
      },
      h('span', null, t('panel.restore')),
      h(IconChevronRight, { size: 12 })
    )
  )
}

function TimelineView(props) {
  const { t, status, locale, snapshotting, onSnapshot, onSelect, sessionId } = props
  if (status.checkpoints.length === 0) {
    return h(
      'div',
      { className: 'dtm_empty' },
      h('span', { className: 'dtm_emptyIcon', 'aria-hidden': 'true' }, h(IconCameraPlus, { size: 24 })),
      h('div', { className: 'dtm_emptyTitle' }, t('panel.empty.title')),
      h('p', { className: 'dtm_emptyBody' }, t('panel.empty.body')),
      h(
        DtmButton,
        { variant: 'primary', disabled: snapshotting, onClick: onSnapshot },
        snapshotting ? h(DtmSpinner, null) : h(IconCameraPlus, { size: 14 }),
        h('span', null, snapshotting ? t('panel.snapshotting') : t('panel.empty.action'))
      )
    )
  }
  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'dtm_list', role: 'list' },
      status.checkpoints.map((entry) =>
        h(CheckpointRow, {
          key: entry.id,
          t,
          entry,
          busy: status.busy,
          locale,
          otherSession: entry.sessionId !== sessionId,
          onSelect,
        })
      )
    ),
    h(
      'div',
      { className: 'dtm_listFoot' },
      h(
        'div',
        { className: 'dtm_listCount' },
        t('panel.count', { count: status.total }),
        status.total > status.checkpoints.length
          ? h('span', { className: 'dtm_listMore' }, t('panel.more', { count: status.checkpoints.length }))
          : null
      ),
      h(
        DtmButton,
        { variant: 'soft', size: 'sm', disabled: snapshotting, onClick: onSnapshot },
        snapshotting ? h(DtmSpinner, null) : h(IconCameraPlus, { size: 13 }),
        h('span', null, snapshotting ? t('panel.snapshotting') : t('panel.snapshot'))
      )
    )
  )
}

function ModeOption(props) {
  const { t, value, current, disabled, onChange } = props
  const selected = value === current
  return h(
    'button',
    {
      type: 'button',
      role: 'radio',
      'aria-checked': selected,
      className: 'dtm_mode',
      'data-selected': selected ? 'true' : 'false',
      'data-mode': value,
      disabled,
      onClick: () => onChange(value),
    },
    h('span', { className: 'dtm_modeRadio', 'aria-hidden': 'true' }, selected ? h('span', null) : null),
    h(
      'span',
      { className: 'dtm_modeCopy' },
      h('span', { className: 'dtm_modeTitle' }, value === 'overwrite' ? t('panel.confirm.overwrite') : t('panel.confirm.exact')),
      h('span', { className: 'dtm_modeHint' }, value === 'overwrite' ? t('panel.confirm.overwriteHint') : t('panel.confirm.exactHint'))
    )
  )
}

function PlanPreview(props) {
  const { t, plan, planning, planError, mode, onReplan, disabled } = props
  if (planning) {
    return h(
      'div',
      { className: 'dtm_planState' },
      h(DtmSpinner, { label: t('panel.confirm.plan') })
    )
  }
  if (planError !== null && planError !== undefined) {
    return h(
      React.Fragment,
      null,
      h(
        DtmBanner,
        { kind: 'error' },
        planError.code === 'WORKSPACE_CHANGED'
          ? t('panel.confirm.stale')
          : t('panel.confirm.planFailed', { message: errorMessageOf(planError, t) })
      ),
      h(
        DtmButton,
        { variant: 'soft', size: 'sm', disabled, onClick: onReplan },
        h(IconRefresh, { size: 13 }),
        h('span', null, t('panel.confirm.replan'))
      )
    )
  }
  if (plan === null || plan === undefined) return null
  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'dtm_planSummary' },
      h(
        'div',
        { className: 'dtm_planStat' },
        h('span', { className: 'dtm_planNumber' }, plan.writes),
        h('span', { className: 'dtm_planLabel' }, t('panel.confirm.write'))
      ),
      h(
        'div',
        { className: 'dtm_planStat', 'data-tone': 'danger' },
        h('span', { className: 'dtm_planNumber' }, plan.deletes),
        h('span', { className: 'dtm_planLabel' }, t('panel.confirm.delete'))
      ),
      h(
        'div',
        { className: 'dtm_planStat', 'data-tone': 'muted' },
        h('span', { className: 'dtm_planNumber' }, `+${String(plan.addedLines)}`),
        h('span', { className: 'dtm_planLabel' }, `−${String(plan.deletedLines)}`)
      )
    ),
    h('p', { className: 'dtm_summaryLine' }, t('panel.confirm.summary', { writes: plan.writes, deletes: plan.deletes })),
    plan.sample.length === 0
      ? null
      : h(
          'div',
          { className: 'dtm_sample' },
          h('div', { className: 'dtm_sampleTitle' }, t('panel.confirm.sample')),
          h(
            'div',
            { className: 'dtm_sampleList' },
            plan.sample.map((file) =>
              h(
                'div',
                { key: `${file.status}:${file.path}`, className: 'dtm_sampleRow' },
                h('span', { className: 'dtm_sampleBadge', 'data-status': file.status }, file.status === 'D' ? t('panel.confirm.delete') : t('panel.confirm.write')),
                h('span', { className: 'dtm_samplePath', title: file.path }, file.path)
              )
            )
          ),
          plan.truncatedSample > 0
            ? h('div', { className: 'dtm_sampleMore' }, t('panel.confirm.more', { count: plan.truncatedSample }))
            : null
        ),
    Array.isArray(plan.warnings) && plan.warnings.length > 0
      ? h(
          DtmBanner,
          { kind: 'warning' },
          h(
            'span',
            null,
            plan.warnings.map((warning, index) => h('div', { key: String(index) }, warning))
          )
        )
      : null
  )
}

function ConfirmView(props) {
  const {
    t, locale, selected, mode, plan, planning, planError, restoring, exactAck, busy, onMode, onReplan, onExactAck, onCancel, onConfirm,
  } = props
  if (selected === null || selected === undefined) return null
  const needsAck = mode === 'exact'
  const canRestore = plan !== null && !planning && !restoring && !busy && (!needsAck || exactAck)
  return h(
    'div',
    { className: 'dtm_view dtm_confirm' },
    h(
      'div',
      { className: 'dtm_target' },
      h(
        'div',
        { className: 'dtm_targetTop' },
        h('span', { className: 'dtm_targetTitle' }, t('panel.confirm.title')),
        h('span', { className: 'dtm_targetTime', title: formatFullTime(selected.createdAt, locale) }, formatWhen(selected.createdAt, locale, t))
      ),
      h(
        'div',
        { className: 'dtm_targetMeta' },
        formatKind(selected, t),
        formatTurn(selected, t) === '' ? null : h('span', { className: 'dtm_sep' }, '·'),
        formatTurn(selected, t) === '' ? null : h('span', null, formatTurn(selected, t)),
        h('span', { className: 'dtm_sep' }, '·'),
        h('span', null, formatStats(selected, t))
      )
    ),
    h('div', { className: 'dtm_sectionLabel' }, t('panel.confirm.mode')),
    h(
      'div',
      { className: 'dtm_modes', role: 'radiogroup', 'aria-label': t('panel.confirm.mode') },
      h(ModeOption, {
        t,
        value: 'overwrite',
        current: mode,
        disabled: restoring || planning,
        onChange: onMode,
      }),
      h(ModeOption, {
        t,
        value: 'exact',
        current: mode,
        disabled: restoring || planning,
        onChange: onMode,
      })
    ),
    needsAck
      ? h(
          'label',
          { className: 'dtm_ack', 'data-checked': exactAck ? 'true' : 'false' },
          h('input', {
            type: 'checkbox',
            checked: exactAck,
            disabled: restoring,
            onChange: (event) => onExactAck(event.target.checked),
          }),
          h('span', null, t('panel.confirm.exactCheck'))
        )
      : null,
    h(PlanPreview, {
      t,
      plan,
      planning,
      planError,
      mode,
      disabled: restoring,
      onReplan,
    }),
    h(
      'div',
      { className: 'dtm_safetyNote' },
      h(IconShield, { size: 14 }),
      h('span', null, t('panel.confirm.safety'))
    ),
    h(
      'div',
      { className: 'dtm_actions' },
      h(DtmButton, { variant: 'ghost', disabled: restoring, onClick: onCancel }, t('panel.confirm.cancel')),
      h(
        DtmButton,
        {
          variant: needsAck ? 'danger' : 'primary',
          disabled: !canRestore,
          onClick: onConfirm,
        },
        restoring ? h(DtmSpinner, null) : h(IconHistory, { size: 14 }),
        h('span', null, restoring ? t('panel.confirm.applying') : t('panel.confirm.apply'))
      )
    )
  )
}

function ResultView(props) {
  const { t, result, onDone } = props
  return h(
    'div',
    { className: 'dtm_view dtm_result' },
    h('span', { className: 'dtm_resultIcon', 'aria-hidden': 'true' }, h(IconCheck, { size: 26 })),
    h('div', { className: 'dtm_resultTitle' }, t('panel.result.title')),
    h('p', { className: 'dtm_resultSummary' }, t('panel.result.summary', { writes: result.writes, deletes: result.deletes })),
    h(
      'div',
      { className: 'dtm_resultIds' },
      h('span', { title: result.safetyId }, `${t('panel.result.ids', { safety: shortCheckpointId(result.safetyId), checkpoint: shortCheckpointId(result.checkpointId) })}`),
      h('div', { className: 'dtm_resultTarget', title: result.targetId }, t('panel.result.target', { target: shortCheckpointId(result.targetId) }))
    ),
    h('p', { className: 'dtm_resultHint' }, t('panel.result.hint')),
    h(
      'div',
      { className: 'dtm_actions' },
      h(DtmButton, { variant: 'primary', onClick: onDone }, t('panel.result.done'))
    )
  )
}

function TimeMachinePanel(props) {
  const {
    t, status, loading, error, notice, view, selected, mode, plan, planError, planning, restoring, result, exactAck,
    snapshotting, draft, saving, issues, settingsError, locale, position, panelRef,
    onClose, onRefresh, onTimeline, onSettings, onBack, onSnapshot, onSelect, onMode, onReplan, onExactAck, onCancel, onConfirm,
    onDone, onDraft, onSaveSettings, sessionId,
  } = props
  const body = (() => {
    if (status === null || status === undefined) {
      if (loading) return h('div', { className: 'dtm_state' }, h(DtmSpinner, { label: t('panel.loading') }))
      if (error !== null && error !== undefined) {
        return h(
          'div',
          { className: 'dtm_state' },
          h(DtmBanner, { kind: 'error' }, errorMessageOf(error, t)),
          h(DtmButton, { variant: 'soft', onClick: onRefresh }, t('panel.retry'))
        )
      }
      return h('div', { className: 'dtm_state' }, h(DtmSpinner, { label: t('panel.loading') }))
    }
    if (view === 'settings') {
      return h(SettingsView, {
        t,
        draft,
        saving,
        issues,
        error: settingsError === null || settingsError === undefined ? undefined : errorMessageOf(settingsError, t),
        onChange: onDraft,
        onSave: onSaveSettings,
      })
    }
    if (view === 'confirm') {
      return h(ConfirmView, {
        t,
        locale,
        selected,
        mode,
        plan,
        planning,
        planError,
        restoring,
        exactAck,
        busy: status.busy,
        onMode,
        onReplan,
        onExactAck,
        onCancel,
        onConfirm,
      })
    }
    if (view === 'result') {
      return h(ResultView, { t, result, onDone })
    }
    return h(TimelineView, {
      t,
      status,
      locale,
      sessionId,
      snapshotting,
      onSnapshot,
      onSelect,
    })
  })()

  return h(
    'section',
    {
      className: 'dtm_panel',
      ref: panelRef,
      role: 'dialog',
      'aria-label': t('panel.title'),
      'aria-modal': 'false',
      'data-view': view,
      style: position ?? undefined,
    },
    h(PanelHeader, {
      t,
      status,
      view,
      loading,
      restoring,
      onRefresh,
      onClose,
      onTimeline,
      onSettings,
      onBack,
    }),
    h(
      'div',
      { className: 'dtm_panelBody' },
      h(CommonBanners, {
        t,
        status,
        notice,
        error,
        onRetry: onRefresh,
      }),
      body
    )
  )
}

function TimeMachineAction(props) {
  const t = typeof props.t === 'function' ? props.t : (key) => key
  const sessionId = props.sessionId
  const api = useStableApi()
  const [open, setOpen] = React.useState(false)
  const [status, setStatus] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [notice, setNotice] = React.useState(null)
  const [view, setView] = React.useState('timeline')
  const [selected, setSelected] = React.useState(null)
  const [mode, setMode] = React.useState('overwrite')
  const [plan, setPlan] = React.useState(null)
  const [planError, setPlanError] = React.useState(null)
  const [planning, setPlanning] = React.useState(false)
  const [restoring, setRestoring] = React.useState(false)
  const [result, setResult] = React.useState(null)
  const [exactAck, setExactAck] = React.useState(false)
  const [snapshotting, setSnapshotting] = React.useState(false)
  const [draft, setDraft] = React.useState(null)
  const [saving, setSaving] = React.useState(false)
  const [issues, setIssues] = React.useState([])
  const [settingsError, setSettingsError] = React.useState(null)
  const rootRef = React.useRef(null)
  const triggerRef = React.useRef(null)
  const panelRef = React.useRef(null)
  const position = useAnchorPosition(triggerRef, open)
  const refreshSeq = React.useRef(0)
  const planSeq = React.useRef(0)
  const locale = activeLocale()

  const refresh = React.useCallback(async (options = {}) => {
    if (sessionId === undefined || sessionId === null || sessionId === '') return
    const seq = refreshSeq.current + 1
    refreshSeq.current = seq
    if (options.quiet !== true) setLoading(true)
    try {
      const next = await api.status(sessionId)
      if (refreshSeq.current !== seq) return
      setStatus(next)
      setError(null)
    } catch (failure) {
      if (refreshSeq.current !== seq) return
      if (failure?.code !== 'ABORTED') setError(failure)
    } finally {
      if (refreshSeq.current === seq) setLoading(false)
    }
  }, [api, sessionId])

  React.useEffect(() => {
    // 会话切换：让仍在路上的 status/plan 请求失效，避免旧会话的响应写回新面板。
    refreshSeq.current += 1
    planSeq.current += 1
    setLoading(false)
    setPlanning(false)
    setOpen(false)
    setStatus(null)
    setError(null)
    setNotice(null)
    setView('timeline')
    setSelected(null)
    setPlan(null)
    setPlanError(null)
    setResult(null)
    setExactAck(false)
    setDraft(null)
    setIssues([])
    setSettingsError(null)
  }, [sessionId])

  React.useEffect(() => {
    if (open !== true) return undefined
    void refresh()
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void refresh({ quiet: true })
    }, 5000)
    return () => {
      clearInterval(timer)
    }
  }, [open, refresh])

  React.useEffect(() => {
    if (open !== true) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape' && restoring !== true) setOpen(false)
    }
    const onDown = (event) => {
      const target = event.target
      if (rootRef.current !== null && rootRef.current.contains(target)) return
      if (panelRef.current !== null && panelRef.current.contains(target)) return
      if (restoring !== true) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown, true)
    }
  }, [open, restoring])

  const loadPlan = React.useCallback(async (checkpointId, nextMode) => {
    const seq = planSeq.current + 1
    planSeq.current = seq
    setPlanning(true)
    setPlan(null)
    setPlanError(null)
    try {
      const payload = await api.plan(sessionId, checkpointId, nextMode)
      if (planSeq.current === seq) setPlan(payload.plan)
    } catch (failure) {
      if (planSeq.current === seq && failure?.code !== 'ABORTED') setPlanError(failure)
    } finally {
      if (planSeq.current === seq) setPlanning(false)
    }
  }, [api, sessionId])

  const selectCheckpoint = (entry) => {
    setSelected(entry)
    setView('confirm')
    setMode('overwrite')
    setExactAck(false)
    setResult(null)
    setNotice(null)
    void loadPlan(entry.id, 'overwrite')
  }

  const changeMode = (nextMode) => {
    if (nextMode === mode || planning || restoring) return
    setMode(nextMode)
    setExactAck(false)
    if (selected !== null) void loadPlan(selected.id, nextMode)
  }

  const replan = () => {
    if (selected !== null) void loadPlan(selected.id, mode)
  }

  const confirmRestore = async () => {
    if (plan === null || restoring || status?.busy === true) return
    if (mode === 'exact' && exactAck !== true) return
    setRestoring(true)
    setPlanError(null)
    try {
      const payload = await api.restore(sessionId, plan.planId)
      setResult(payload.result)
      setView('result')
      setPlan(null)
      setExactAck(false)
      setNotice(null)
      void refresh({ quiet: true })
    } catch (failure) {
      if (failure?.code !== 'ABORTED') {
        setPlanError(failure)
        setPlan(null)
      }
      void refresh({ quiet: true })
    } finally {
      setRestoring(false)
    }
  }

  const createSnapshot = async () => {
    if (snapshotting) return
    setSnapshotting(true)
    setNotice(null)
    try {
      const payload = await api.checkpoint(sessionId)
      setNotice(t('panel.snapshotDone', { id: shortCheckpointId(payload.checkpoint.id) }))
      await refresh({ quiet: true })
    } catch (failure) {
      if (failure?.code !== 'ABORTED') setError(failure)
    } finally {
      setSnapshotting(false)
    }
  }

  const openSettings = () => {
    if (status === null) return
    setDraft(settingsDraftOf(status.settings))
    setIssues([])
    setSettingsError(null)
    setNotice(null)
    setView('settings')
  }

  const saveSettings = async (config) => {
    if (saving) return
    setSaving(true)
    setSettingsError(null)
    setNotice(null)
    try {
      const payload = await api.saveConfig(sessionId, config)
      setDraft(settingsDraftOf(payload.config))
      setStatus((previous) => (previous === null ? previous : { ...previous, settings: payload.config }))
      setIssues(Array.isArray(payload.issues) ? payload.issues : [])
      setNotice(t('panel.settings.saved'))
    } catch (failure) {
      if (failure?.code !== 'ABORTED') setSettingsError(failure)
    } finally {
      setSaving(false)
    }
  }

  const backToTimeline = () => {
    if (restoring) return
    setView('timeline')
    setSelected(null)
    setPlan(null)
    setPlanError(null)
    setResult(null)
    setExactAck(false)
    setNotice(null)
    void refresh({ quiet: true })
  }

  const toggleOpen = () => {
    if (!open) {
      setView('timeline')
      setSelected(null)
      setPlan(null)
      setPlanError(null)
      setError(null)
      setNotice(null)
      setResult(null)
      setExactAck(false)
      setMode('overwrite')
    }
    setOpen((value) => !value)
  }

  const panel = open
    ? ReactDOM.createPortal(
        h(TimeMachinePanel, {
          t,
          status,
          loading,
          error,
          notice,
          view,
          selected,
          mode,
          plan,
          planError,
          planning,
          restoring,
          result,
          exactAck,
          snapshotting,
          draft,
          saving,
          issues,
          settingsError,
          locale,
          position,
          panelRef,
          sessionId,
          onClose: () => {
            if (!restoring) setOpen(false)
          },
          onRefresh: () => {
            void refresh()
          },
          onTimeline: backToTimeline,
          onSettings: openSettings,
          onBack: backToTimeline,
          onSnapshot: createSnapshot,
          onSelect: selectCheckpoint,
          onMode: changeMode,
          onReplan: replan,
          onExactAck: setExactAck,
          onCancel: backToTimeline,
          onConfirm: confirmRestore,
          onDone: backToTimeline,
          onDraft: setDraft,
          onSaveSettings: saveSettings,
        }),
        document.body
      )
    : null

  if (sessionId === undefined || sessionId === null || sessionId === '') return null

  return h(
    React.Fragment,
    null,
    h(
      'span',
      { className: 'dtm_root', ref: rootRef, 'data-time-machine': true },
      h(
        'button',
        {
          type: 'button',
          ref: triggerRef,
          className: 'dtm_trigger',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': t('action.aria'),
          title: t('action.aria'),
          onClick: toggleOpen,
        },
        h(IconHistory, { size: 14 }),
        h('span', { className: 'dtm_triggerText' }, t('action.label'))
      )
    ),
    panel
  )
}

// ---- src/client/styles.generated.js --------------------------
/**
 * 本文件由 scripts/build.mjs 生成，请勿手工编辑。
 */
const STYLES = "/*\n * 时光机 —— 与宿主同材质的面板。\n *\n * 入口是会话标题栏里的一个小胶囊，面板 portal 到 body。表面、阴影、边框与\n * 文字颜色全部读取宿主 --dsw-* 令牌，因此深浅色与字号设置自动跟随。\n */\n\n:root {\n  --dtm-blue: var(--dsw-alias-state-business-primary, #4176e6);\n  --dtm-teal: #1f9e99;\n  --dtm-amber: #c07a12;\n  --dtm-green: var(--dsw-alias-state-success-primary, #1f8f5f);\n  --dtm-red: var(--dsw-alias-state-error-primary, #d93a45);\n  --dtm-on-accent: #fff;\n  --dtm-row-hover: var(--dsw-alias-interactive-bg-hover, rgb(0 0 0 / 4%));\n  --dtm-soft: var(--dsw-alias-interactive-bg-hover-solid, rgb(0 0 0 / 6%));\n  --dtm-panel-fill: var(--dsw-specific-menu, #fff);\n  --dtm-panel-stroke: var(--dsw-alias-border-l1, rgb(0 0 0 / 8%));\n  --dtm-panel-shadow: var(--dsw-elevation-prominent, 0 16px 40px rgb(0 0 0 / 18%));\n}\n\nbody[data-ds-dark-theme] {\n  --dtm-teal: #5ad7cf;\n  --dtm-amber: #e2a13c;\n  --dtm-green: #4bbf8b;\n  --dtm-red: #f06a6a;\n  --dtm-on-accent: #071116;\n  --dtm-row-hover: var(--dsw-alias-interactive-bg-hover, rgb(255 255 255 / 6%));\n  --dtm-soft: var(--dsw-alias-interactive-bg-hover-solid, rgb(255 255 255 / 10%));\n  --dtm-panel-fill: var(--dsw-specific-menu, #1b1e22);\n  --dtm-panel-stroke: var(--dsw-alias-border-l1, rgb(255 255 255 / 10%));\n  --dtm-panel-shadow: var(--dsw-elevation-prominent, 0 18px 48px rgb(0 0 0 / 55%));\n}\n\n.dtm_root {\n  display: inline-flex;\n  align-items: center;\n  flex: none;\n}\n\n.dtm_trigger {\n  box-sizing: border-box;\n  display: inline-flex;\n  align-items: center;\n  gap: 5px;\n  height: 24px;\n  padding: 0 8px;\n  border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 12%));\n  border-radius: 999px;\n  background: transparent;\n  color: var(--dsw-alias-label-secondary, #555);\n  font-family: inherit;\n  font-size: 12px;\n  line-height: 22px;\n  white-space: nowrap;\n  cursor: pointer;\n  transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;\n}\n\n.dtm_trigger:hover,\n.dtm_trigger[aria-expanded='true'] {\n  background: var(--dtm-row-hover);\n  color: var(--dsw-alias-label-primary, #222);\n}\n\n.dtm_trigger:focus-visible {\n  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4176e6));\n  outline-offset: 1px;\n}\n\n.dtm_trigger svg {\n  flex: none;\n  color: var(--dtm-teal);\n}\n\n.dtm_triggerText {\n  font-weight: 500;\n  letter-spacing: 0.01em;\n}\n\n/* ---------------------------------------------------------------- 面板骨架 */\n\n.dtm_panel,\n.dtm_panel * {\n  box-sizing: border-box;\n}\n\n.dtm_panel {\n  position: fixed;\n  z-index: 1200;\n  display: flex;\n  flex-direction: column;\n  overflow: hidden;\n  border: 0;\n  border-radius: var(--dsw-radius-lg, 14px);\n  background: var(--dtm-panel-fill);\n  backdrop-filter: var(--dsw-menu-backdrop-filter, blur(20px));\n  --dsw-elevation-stroke-color: var(--dtm-panel-stroke);\n  box-shadow: var(--dtm-panel-shadow), inset 0 0 0 0.5px var(--dtm-panel-stroke);\n  color: var(--dsw-alias-label-secondary, #555);\n  font-family: inherit;\n  font-size: 12px;\n  line-height: 20px;\n  cursor: default;\n}\n\n.dtm_panelHead {\n  flex: none;\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  gap: 10px;\n  row-gap: 8px;\n  padding: 12px 14px 8px;\n}\n\n.dtm_brand {\n  display: flex;\n  align-items: center;\n  gap: 9px;\n  min-width: 0;\n  flex: 1 1 auto;\n}\n\n.dtm_brandIcon {\n  flex: none;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 32px;\n  height: 32px;\n  border-radius: 10px;\n  color: #d9fff8;\n  background:\n    radial-gradient(120% 120% at 20% 0%, rgb(141 232 212 / 38%) 0%, transparent 55%),\n    linear-gradient(145deg, #17434c 0%, #0c1c23 100%);\n  box-shadow: inset 0 0 0 0.5px rgb(255 255 255 / 14%);\n}\n\n.dtm_brandCopy {\n  min-width: 0;\n  display: flex;\n  flex-direction: column;\n  gap: 1px;\n}\n\n.dtm_brandTitle {\n  display: flex;\n  align-items: baseline;\n  gap: 6px;\n  color: var(--dsw-alias-label-primary, #1a1a1a);\n  font-size: 13.5px;\n  font-weight: 600;\n  line-height: 18px;\n}\n\n.dtm_version {\n  color: var(--dsw-alias-label-tertiary, #999);\n  font-size: 10px;\n  font-weight: 400;\n  font-variant-numeric: tabular-nums;\n}\n\n.dtm_path {\n  max-width: 100%;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  color: var(--dsw-alias-label-tertiary, #999);\n  font-size: 10.5px;\n  line-height: 15px;\n}\n\n.dtm_headActions {\n  flex: none;\n  display: flex;\n  align-items: center;\n  gap: 2px;\n}\n\n.dtm_tabs {\n  flex: 0 0 100%;\n  display: flex;\n  gap: 3px;\n  padding: 3px;\n  border-radius: 9px;\n  background: var(--dsw-alias-interactive-bg-hover, rgb(0 0 0 / 4%));\n}\n\n.dtm_tab {\n  flex: 1 1 0;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  gap: 5px;\n  height: 25px;\n  border: 0;\n  border-radius: 7px;\n  background: transparent;\n  color: var(--dsw-alias-label-tertiary, #888);\n  font-family: inherit;\n  font-size: 11.5px;\n  font-weight: 500;\n  cursor: pointer;\n}\n\n.dtm_tab:hover:not(:disabled) {\n  color: var(--dsw-alias-label-primary, #222);\n}\n\n.dtm_tab[data-active='true'] {\n  background: var(--dsw-alias-button-elevated-fill, var(--dsw-alias-bg-base, #fff));\n  color: var(--dsw-alias-label-primary, #222);\n  box-shadow: 0 1px 1px rgb(0 0 0 / 7%), inset 0 0 0 0.5px var(--dsw-alias-border-l1, rgb(0 0 0 / 8%));\n}\n\n.dtm_tab:focus-visible,\n.dtm_back:focus-visible {\n  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4176e6));\n  outline-offset: 0;\n}\n\n.dtm_tab:disabled {\n  opacity: 0.5;\n  cursor: default;\n}\n\n.dtm_subBar {\n  flex: 0 0 100%;\n  display: flex;\n}\n\n.dtm_back {\n  display: inline-flex;\n  align-items: center;\n  gap: 5px;\n  height: 24px;\n  padding: 0 7px;\n  border: 0;\n  border-radius: 7px;\n  background: transparent;\n  color: var(--dsw-alias-label-tertiary, #888);\n  font-family: inherit;\n  font-size: 11.5px;\n  cursor: pointer;\n}\n\n.dtm_back:hover:not(:disabled) {\n  background: var(--dtm-row-hover);\n  color: var(--dsw-alias-label-primary, #222);\n}\n\n.dtm_back:disabled {\n  opacity: 0.5;\n}\n\n.dtm_panelBody {\n  min-height: 0;\n  overflow-y: auto;\n  overscroll-behavior: contain;\n  padding: 2px 14px 14px;\n  scrollbar-width: thin;\n  scrollbar-color: var(--dsw-alias-scrollbar-thumb, rgb(0 0 0 / 20%)) transparent;\n}\n\n.dtm_panelBody::-webkit-scrollbar {\n  width: 5px;\n}\n\n.dtm_panelBody::-webkit-scrollbar-thumb {\n  border-radius: 999px;\n  background: var(--dsw-alias-scrollbar-thumb, rgb(0 0 0 / 20%));\n}\n\n/* ---------------------------------------------------------------- 控件 */\n\n.dtm_iconButton {\n  box-sizing: border-box;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 24px;\n  height: 24px;\n  padding: 0;\n  border: 0;\n  border-radius: 7px;\n  background: transparent;\n  color: var(--dsw-alias-label-tertiary, #888);\n  cursor: pointer;\n}\n\n.dtm_iconButton:hover:not(:disabled) {\n  background: var(--dtm-row-hover);\n  color: var(--dsw-alias-label-primary, #222);\n}\n\n.dtm_iconButton:disabled {\n  opacity: 0.45;\n  cursor: default;\n}\n\n.dtm_iconButton:focus-visible,\n.dtm_button:focus-visible,\n.dtm_mode:focus-visible,\n.dtm_switch:focus-visible,\n.dtm_ack input:focus-visible,\n.dtm_input:focus-visible,\n.dtm_textarea:focus-visible {\n  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4176e6));\n  outline-offset: 1px;\n}\n\n.dtm_button {\n  box-sizing: border-box;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  gap: 6px;\n  height: 29px;\n  padding: 0 12px;\n  border: 0.5px solid transparent;\n  border-radius: 8px;\n  font-family: inherit;\n  font-size: 12px;\n  font-weight: 500;\n  white-space: nowrap;\n  cursor: pointer;\n  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;\n}\n\n.dtm_button[data-size='sm'] {\n  height: 25px;\n  padding: 0 8px;\n  font-size: 11.5px;\n  border-radius: 7px;\n}\n\n.dtm_button[data-variant='primary'] {\n  background: var(--dtm-blue);\n  color: var(--dtm-on-accent);\n}\n\n.dtm_button[data-variant='primary']:hover:not(:disabled) {\n  background: color-mix(in srgb, var(--dtm-blue) 88%, #000);\n}\n\n.dtm_button[data-variant='danger'] {\n  background: var(--dtm-red);\n  color: #fff;\n}\n\n.dtm_button[data-variant='danger']:hover:not(:disabled) {\n  background: color-mix(in srgb, var(--dtm-red) 86%, #000);\n}\n\n.dtm_button[data-variant='ghost'] {\n  border-color: var(--dsw-alias-border-l2, rgb(0 0 0 / 12%));\n  background: transparent;\n  color: var(--dsw-alias-label-secondary, #555);\n}\n\n.dtm_button[data-variant='ghost']:hover:not(:disabled) {\n  background: var(--dtm-row-hover);\n  color: var(--dsw-alias-label-primary, #222);\n}\n\n.dtm_button[data-variant='soft'] {\n  background: var(--dtm-row-hover);\n  color: var(--dsw-alias-label-primary, #222);\n}\n\n.dtm_button[data-variant='soft']:hover:not(:disabled) {\n  background: var(--dtm-soft);\n}\n\n.dtm_button:disabled {\n  opacity: 0.48;\n  cursor: default;\n}\n\n.dtm_button svg {\n  flex: none;\n}\n\n.dtm_spinner {\n  display: inline-block;\n  width: 13px;\n  height: 13px;\n  border: 1.7px solid color-mix(in srgb, currentColor 24%, transparent);\n  border-top-color: currentColor;\n  border-radius: 50%;\n  animation: dtm_spin 0.8s linear infinite;\n  vertical-align: -2px;\n}\n\n.dtm_spin {\n  animation: dtm_spin 0.8s linear infinite;\n}\n\n@keyframes dtm_spin {\n  to {\n    transform: rotate(360deg);\n  }\n}\n\n.dtm_loading {\n  display: inline-flex;\n  align-items: center;\n  gap: 7px;\n  color: var(--dsw-alias-label-tertiary, #888);\n}\n\n.dtm_state {\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  gap: 10px;\n  padding: 28px 8px;\n}\n\n/* ---------------------------------------------------------------- 横幅 */\n\n.dtm_banners {\n  display: flex;\n  flex-direction: column;\n  gap: 6px;\n  margin-bottom: 10px;\n}\n\n.dtm_banner {\n  display: flex;\n  align-items: flex-start;\n  gap: 8px;\n  padding: 7px 9px;\n  border-radius: 8px;\n  font-size: 11.5px;\n  line-height: 17px;\n}\n\n.dtm_bannerText {\n  flex: 1 1 auto;\n  min-width: 0;\n}\n\n.dtm_banner[data-kind='info'] {\n  background: color-mix(in srgb, var(--dtm-blue) 10%, transparent);\n  color: var(--dsw-alias-label-secondary, #555);\n}\n\n.dtm_banner[data-kind='success'] {\n  background: color-mix(in srgb, var(--dtm-green) 12%, transparent);\n  color: var(--dtm-green);\n}\n\n.dtm_banner[data-kind='warning'] {\n  background: color-mix(in srgb, var(--dtm-amber) 13%, transparent);\n  color: var(--dtm-amber);\n}\n\n.dtm_banner[data-kind='error'] {\n  background: color-mix(in srgb, var(--dtm-red) 12%, transparent);\n  color: var(--dtm-red);\n}\n\n.dtm_banner .dtm_button {\n  flex: none;\n}\n\n/* ---------------------------------------------------------------- 时间线 */\n\n.dtm_view {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n}\n\n.dtm_viewTitle {\n  color: var(--dsw-alias-label-primary, #1a1a1a);\n  font-size: 13px;\n  font-weight: 600;\n}\n\n.dtm_viewHint {\n  margin: -2px 0 2px;\n  color: var(--dsw-alias-label-tertiary, #888);\n  font-size: 11.5px;\n}\n\n.dtm_list {\n  display: flex;\n  flex-direction: column;\n  gap: 5px;\n}\n\n.dtm_row {\n  display: flex;\n  align-items: center;\n  gap: 9px;\n  padding: 8px 9px;\n  border: 0.5px solid var(--dsw-alias-border-l1, rgb(0 0 0 / 7%));\n  border-radius: 10px;\n  background: transparent;\n  transition: background-color 0.14s ease, border-color 0.14s ease;\n}\n\n.dtm_row:hover {\n  background: var(--dtm-row-hover);\n  border-color: var(--dsw-alias-border-l2, rgb(0 0 0 / 12%));\n}\n\n.dtm_row[data-current='true'] {\n  background: color-mix(in srgb, var(--dtm-green) 5%, transparent);\n  border-color: color-mix(in srgb, var(--dtm-green) 22%, var(--dsw-alias-border-l1, transparent));\n}\n\n.dtm_rowDot {\n  flex: none;\n  width: 7px;\n  height: 7px;\n  border-radius: 50%;\n  background: var(--dtm-blue);\n  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dtm-blue) 12%, transparent);\n}\n\n.dtm_row[data-kind='manual'] .dtm_rowDot {\n  background: var(--dtm-teal);\n  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dtm-teal) 12%, transparent);\n}\n\n.dtm_row[data-kind='safety'] .dtm_rowDot {\n  background: var(--dtm-amber);\n  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dtm-amber) 14%, transparent);\n}\n\n.dtm_row[data-kind='restore'] .dtm_rowDot {\n  background: var(--dtm-green);\n  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dtm-green) 14%, transparent);\n}\n\n.dtm_rowBody {\n  flex: 1 1 auto;\n  min-width: 0;\n  display: flex;\n  flex-direction: column;\n  gap: 1px;\n}\n\n.dtm_rowTop {\n  display: flex;\n  align-items: center;\n  gap: 5px;\n  min-width: 0;\n}\n\n.dtm_rowTitle {\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  color: var(--dsw-alias-label-primary, #1a1a1a);\n  font-size: 12.5px;\n  font-weight: 500;\n}\n\n.dtm_badge {\n  flex: none;\n  padding: 0 5px;\n  border-radius: 999px;\n  background: var(--dtm-soft);\n  color: var(--dsw-alias-label-tertiary, #888);\n  font-size: 9.5px;\n  line-height: 15px;\n  font-weight: 500;\n}\n\n.dtm_badge[data-tone='current'] {\n  background: color-mix(in srgb, var(--dtm-green) 14%, transparent);\n  color: var(--dtm-green);\n}\n\n.dtm_rowTime {\n  flex: none;\n  margin-left: auto;\n  color: var(--dsw-alias-label-tertiary, #999);\n  font-size: 10.5px;\n  font-variant-numeric: tabular-nums;\n  white-space: nowrap;\n}\n\n.dtm_rowMeta {\n  display: flex;\n  align-items: center;\n  gap: 4px;\n  min-width: 0;\n  overflow: hidden;\n  color: var(--dsw-alias-label-tertiary, #888);\n  font-size: 10.5px;\n  white-space: nowrap;\n}\n\n.dtm_sep {\n  opacity: 0.55;\n}\n\n.dtm_rowId {\n  margin-left: 2px;\n  color: var(--dsw-alias-label-tertiary, #aaa);\n  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n  font-size: 9.5px;\n  letter-spacing: -0.02em;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.dtm_row .dtm_button {\n  flex: none;\n}\n\n.dtm_listFoot {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  padding-top: 4px;\n}\n\n.dtm_listCount {\n  flex: 1 1 auto;\n  min-width: 0;\n  display: flex;\n  flex-direction: column;\n  color: var(--dsw-alias-label-tertiary, #888);\n  font-size: 10.5px;\n  line-height: 15px;\n}\n\n.dtm_listMore {\n  color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary, #aaa));\n}\n\n.dtm_empty {\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  text-align: center;\n  gap: 6px;\n  padding: 26px 18px 22px;\n}\n\n.dtm_emptyIcon {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 46px;\n  height: 46px;\n  margin-bottom: 2px;\n  border-radius: 14px;\n  background: color-mix(in srgb, var(--dtm-teal) 10%, transparent);\n  color: var(--dtm-teal);\n}\n\n.dtm_emptyTitle {\n  color: var(--dsw-alias-label-primary, #1a1a1a);\n  font-size: 13px;\n  font-weight: 600;\n}\n\n.dtm_emptyBody {\n  max-width: 290px;\n  margin: 0 0 6px;\n  color: var(--dsw-alias-label-tertiary, #888);\n  font-size: 11.5px;\n  line-height: 17px;\n}\n\n/* ---------------------------------------------------------------- 恢复确认 */\n\n.dtm_target {\n  padding: 9px 10px;\n  border: 0.5px solid var(--dsw-alias-border-l1, rgb(0 0 0 / 7%));\n  border-radius: 10px;\n  background: var(--dtm-row-hover);\n}\n\n.dtm_targetTop {\n  display: flex;\n  align-items: baseline;\n  gap: 8px;\n}\n\n.dtm_targetTitle {\n  flex: 1 1 auto;\n  min-width: 0;\n  color: var(--dsw-alias-label-primary, #1a1a1a);\n  font-size: 12.5px;\n  font-weight: 600;\n}\n\n.dtm_targetTime {\n  flex: none;\n  color: var(--dsw-alias-label-tertiary, #888);\n  font-size: 10.5px;\n  font-variant-numeric: tabular-nums;\n}\n\n.dtm_targetMeta {\n  display: flex;\n  align-items: center;\n  gap: 4px;\n  margin-top: 1px;\n  color: var(--dsw-alias-label-tertiary, #888);\n  font-size: 10.5px;\n}\n\n.dtm_sectionLabel {\n  margin-top: 2px;\n  color: var(--dsw-alias-label-tertiary, #888);\n  font-size: 10.5px;\n  font-weight: 500;\n  letter-spacing: 0.02em;\n}\n\n.dtm_modes {\n  display: flex;\n  flex-direction: column;\n  gap: 5px;\n}\n\n.dtm_mode {\n  display: flex;\n  align-items: flex-start;\n  gap: 8px;\n  width: 100%;\n  padding: 8px 9px;\n  border: 0.5px solid var(--dsw-alias-border-l1, rgb(0 0 0 / 8%));\n  border-radius: 9px;\n  background: transparent;\n  text-align: left;\n  font-family: inherit;\n  color: inherit;\n  cursor: pointer;\n}\n\n.dtm_mode:hover:not(:disabled) {\n  border-color: var(--dsw-alias-border-l2, rgb(0 0 0 / 14%));\n  background: var(--dtm-row-hover);\n}\n\n.dtm_mode[data-selected='true'] {\n  border-color: color-mix(in srgb, var(--dtm-blue) 55%, transparent);\n  background: color-mix(in srgb, var(--dtm-blue) 6%, transparent);\n}\n\n.dtm_mode[data-mode='exact'][data-selected='true'] {\n  border-color: color-mix(in srgb, var(--dtm-red) 50%, transparent);\n  background: color-mix(in srgb, var(--dtm-red) 6%, transparent);\n}\n\n.dtm_mode:disabled {\n  opacity: 0.6;\n  cursor: default;\n}\n\n.dtm_modeRadio {\n  flex: none;\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 13px;\n  height: 13px;\n  margin-top: 2px;\n  border: 1.5px solid var(--dsw-alias-border-l3, rgb(0 0 0 / 25%));\n  border-radius: 50%;\n}\n\n.dtm_modeRadio > span {\n  width: 7px;\n  height: 7px;\n  border-radius: 50%;\n  background: var(--dtm-blue);\n}\n\n.dtm_mode[data-mode='exact'] .dtm_modeRadio > span {\n  background: var(--dtm-red);\n}\n\n.dtm_modeCopy {\n  display: flex;\n  flex-direction: column;\n  gap: 1px;\n  min-width: 0;\n}\n\n.dtm_modeTitle {\n  color: var(--dsw-alias-label-primary, #1a1a1a);\n  font-size: 11.5px;\n  font-weight: 500;\n}\n\n.dtm_modeHint {\n  color: var(--dsw-alias-label-tertiary, #888);\n  font-size: 10.5px;\n  line-height: 15px;\n}\n\n.dtm_ack {\n  display: flex;\n  align-items: center;\n  gap: 7px;\n  padding: 7px 9px;\n  border-radius: 8px;\n  background: color-mix(in srgb, var(--dtm-red) 8%, transparent);\n  color: var(--dtm-red);\n  font-size: 11px;\n  cursor: pointer;\n}\n\n.dtm_ack input {\n  width: 13px;\n  height: 13px;\n  accent-color: var(--dtm-red);\n  cursor: pointer;\n}\n\n.dtm_planState {\n  padding: 10px 2px;\n}\n\n.dtm_planSummary {\n  display: grid;\n  grid-template-columns: repeat(3, 1fr);\n  gap: 5px;\n}\n\n.dtm_planStat {\n  display: flex;\n  flex-direction: column;\n  gap: 1px;\n  padding: 7px 8px;\n  border-radius: 9px;\n  background: var(--dtm-row-hover);\n}\n\n.dtm_planNumber {\n  color: var(--dsw-alias-label-primary, #1a1a1a);\n  font-size: 16px;\n  font-weight: 600;\n  line-height: 20px;\n  font-variant-numeric: tabular-nums;\n}\n\n.dtm_planStat[data-tone='danger'] .dtm_planNumber {\n  color: var(--dtm-red);\n}\n\n.dtm_planStat[data-tone='muted'] .dtm_planNumber {\n  color: var(--dsw-alias-label-secondary, #666);\n  font-size: 13px;\n}\n\n.dtm_planLabel {\n  color: var(--dsw-alias-label-tertiary, #888);\n  font-size: 10px;\n}\n\n.dtm_summaryLine {\n  margin: 0;\n  color: var(--dsw-alias-label-secondary, #555);\n  font-size: 11px;\n}\n\n.dtm_sample {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n}\n\n.dtm_sampleTitle {\n  color: var(--dsw-alias-label-tertiary, #888);\n  font-size: 10px;\n  font-weight: 500;\n}\n\n.dtm_sampleList {\n  max-height: 132px;\n  overflow-y: auto;\n  display: flex;\n  flex-direction: column;\n  gap: 1px;\n  padding: 3px;\n  border-radius: 8px;\n  background: var(--dtm-row-hover);\n}\n\n.dtm_sampleRow {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  min-width: 0;\n  padding: 1px 3px;\n  font-size: 10.5px;\n}\n\n.dtm_sampleBadge {\n  flex: none;\n  min-width: 30px;\n  padding: 0 4px;\n  border-radius: 5px;\n  background: color-mix(in srgb, var(--dtm-blue) 12%, transparent);\n  color: var(--dtm-blue);\n  font-size: 9px;\n  line-height: 14px;\n  text-align: center;\n}\n\n.dtm_sampleBadge[data-status='D'] {\n  background: color-mix(in srgb, var(--dtm-red) 12%, transparent);\n  color: var(--dtm-red);\n}\n\n.dtm_samplePath {\n  min-width: 0;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  color: var(--dsw-alias-label-secondary, #555);\n  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n  font-size: 10px;\n}\n\n.dtm_sampleMore {\n  color: var(--dsw-alias-label-tertiary, #888);\n  font-size: 10px;\n  padding-left: 3px;\n}\n\n.dtm_safetyNote {\n  display: flex;\n  align-items: flex-start;\n  gap: 6px;\n  color: var(--dsw-alias-label-tertiary, #888);\n  font-size: 10.5px;\n  line-height: 15px;\n}\n\n.dtm_safetyNote svg {\n  flex: none;\n  margin-top: 1px;\n  color: var(--dtm-teal);\n}\n\n.dtm_actions {\n  display: flex;\n  justify-content: flex-end;\n  gap: 6px;\n  padding-top: 4px;\n}\n\n/* ---------------------------------------------------------------- 结果 */\n\n.dtm_result {\n  align-items: center;\n  text-align: center;\n  padding: 14px 6px 6px;\n}\n\n.dtm_resultIcon {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  width: 52px;\n  height: 52px;\n  border-radius: 50%;\n  background: color-mix(in srgb, var(--dtm-green) 14%, transparent);\n  color: var(--dtm-green);\n}\n\n.dtm_resultTitle {\n  color: var(--dsw-alias-label-primary, #1a1a1a);\n  font-size: 14px;\n  font-weight: 600;\n}\n\n.dtm_resultSummary {\n  margin: 0;\n  color: var(--dsw-alias-label-secondary, #555);\n  font-size: 11.5px;\n}\n\n.dtm_resultIds {\n  display: flex;\n  flex-direction: column;\n  gap: 1px;\n  max-width: 100%;\n  color: var(--dsw-alias-label-tertiary, #888);\n  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n  font-size: 10px;\n  line-height: 16px;\n  word-break: break-all;\n}\n\n.dtm_resultTarget {\n  color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary, #999));\n  font-size: 10px;\n}\n\n.dtm_resultHint {\n  max-width: 340px;\n  margin: 2px 0 4px;\n  color: var(--dsw-alias-label-tertiary, #888);\n  font-size: 11px;\n  line-height: 17px;\n}\n\n.dtm_result .dtm_actions {\n  justify-content: center;\n  width: 100%;\n}\n\n/* ---------------------------------------------------------------- 设置 */\n\n.dtm_settings {\n  gap: 2px;\n}\n\n.dtm_field {\n  display: flex;\n  align-items: center;\n  gap: 12px;\n  padding: 8px 0;\n  border-bottom: 0.5px solid var(--dsw-alias-border-l1, rgb(0 0 0 / 7%));\n}\n\n.dtm_field:last-of-type {\n  border-bottom: 0;\n}\n\n.dtm_fieldCopy {\n  flex: 1 1 auto;\n  min-width: 0;\n}\n\n.dtm_fieldTitle {\n  color: var(--dsw-alias-label-primary, #1a1a1a);\n  font-size: 11.5px;\n  font-weight: 500;\n}\n\n.dtm_fieldHint {\n  color: var(--dsw-alias-label-tertiary, #888);\n  font-size: 10.5px;\n  line-height: 15px;\n}\n\n.dtm_fieldControl {\n  flex: none;\n  display: flex;\n  align-items: center;\n  gap: 6px;\n}\n\n.dtm_fieldGroup {\n  display: flex;\n  flex-direction: column;\n  padding-left: 8px;\n  border-left: 1.5px solid var(--dsw-alias-border-l1, rgb(0 0 0 / 8%));\n  margin-left: 1px;\n}\n\n.dtm_fieldGroup[data-disabled='true'] {\n  opacity: 0.55;\n}\n\n.dtm_fieldBlock {\n  flex-direction: column;\n  align-items: stretch;\n  gap: 6px;\n}\n\n.dtm_input {\n  box-sizing: border-box;\n  width: 88px;\n  height: 26px;\n  padding: 0 7px;\n  border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 14%));\n  border-radius: 7px;\n  background: var(--dsw-alias-bg-base, transparent);\n  color: var(--dsw-alias-label-primary, #222);\n  font-family: inherit;\n  font-size: 11.5px;\n  font-variant-numeric: tabular-nums;\n}\n\n.dtm_textarea {\n  box-sizing: border-box;\n  width: 100%;\n  min-height: 88px;\n  padding: 7px 8px;\n  resize: vertical;\n  border: 0.5px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 14%));\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-base, transparent);\n  color: var(--dsw-alias-label-secondary, #555);\n  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n  font-size: 10.5px;\n  line-height: 16px;\n}\n\n.dtm_switch {\n  box-sizing: border-box;\n  position: relative;\n  width: 34px;\n  height: 20px;\n  padding: 0;\n  border: 0;\n  border-radius: 999px;\n  background: var(--dsw-alias-border-l3, rgb(0 0 0 / 22%));\n  cursor: pointer;\n  transition: background-color 0.15s ease;\n}\n\n.dtm_switch[data-on='true'] {\n  background: var(--dtm-green);\n}\n\n.dtm_switch:disabled {\n  opacity: 0.5;\n  cursor: default;\n}\n\n.dtm_switchThumb {\n  position: absolute;\n  top: 2px;\n  left: 2px;\n  width: 16px;\n  height: 16px;\n  border-radius: 50%;\n  background: var(--dsw-alias-switch-thumb, #fff);\n  box-shadow: 0 1px 2px rgb(0 0 0 / 22%);\n  transition: transform 0.15s ease;\n}\n\n.dtm_switch[data-on='true'] .dtm_switchThumb {\n  transform: translateX(14px);\n}\n\n/* ---------------------------------------------------------------- 窄屏 */\n\n@media (max-width: 760px) {\n  .dtm_triggerText {\n    display: none;\n  }\n\n  .dtm_trigger {\n    width: 24px;\n    padding: 0;\n    justify-content: center;\n    border-color: transparent;\n  }\n}\n\n@media (prefers-reduced-motion: reduce) {\n  .dtm_spinner,\n  .dtm_spin {\n    animation-duration: 2s;\n  }\n\n  .dtm_trigger,\n  .dtm_button,\n  .dtm_row,\n  .dtm_switch,\n  .dtm_switchThumb {\n    transition: none;\n  }\n}\n"

// ---- src/client/index.js -------------------------------------
const name = PLUGIN_ID
const inject = ['slots', 'locale']

const STYLE_TAG_ID = `${PLUGIN_ID}/client.css`
const HEADER_SLOT = 'conversation.session.header.actions'

function mountStyles() {
  if (typeof document === 'undefined') return false
  const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`)
  if (existing !== null) return false
  const tag = document.createElement('style')
  tag.dataset.plugin = PLUGIN_ID
  tag.dataset.pluginCss = STYLE_TAG_ID
  tag.textContent = STYLES
  document.head.appendChild(tag)
  return true
}

function apply(ctx) {
  ctx.effect(() => {
    const created = mountStyles()
    return () => {
      if (!created || typeof document === 'undefined') return
      const tag = document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`)
      if (tag !== null) tag.remove()
    }
  }, `${PLUGIN_ID}: styles`)

  ctx.effect(() => ctx.locale.register(PLUGIN_ID, { zh, en }), `${PLUGIN_ID}: locale`)

  ctx.slots.inject(HEADER_SLOT, () =>
    ctx.slots.register(
      {
        name: HEADER_SLOT,
        id: PLUGIN_ID,
        order: 40,
        locale: PLUGIN_ID,
      },
      TimeMachineAction
    )
  )
}

		exports.apply = apply
		exports.inject = inject
		exports.name = name
		return module.exports
	}
})
