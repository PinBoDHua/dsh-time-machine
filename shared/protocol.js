/**
 * 宿主与浏览器共用的协议字面量。
 *
 * 这个文件会被两边同时加载：宿主直接 import，客户端由零依赖构建拼进
 * 经典脚本。因此这里不能出现任何 `node:` 导入或浏览器专属 API。
 */

export const PLUGIN_ID = 'dsh-time-machine'
export const API_BASE = '/plugins/dsh-time-machine'
export const ROUTES = Object.freeze({
  status: `${API_BASE}/status`,
  checkpoint: `${API_BASE}/checkpoint`,
  plan: `${API_BASE}/plan`,
  restore: `${API_BASE}/restore`,
  config: `${API_BASE}/config`,
})
export const CONTROL_HEADER = 'x-dsh-time-machine-key'
export const CONFIRM_PHRASE = 'RESTORE'
export const MAX_BODY_BYTES = 1024 * 1024
export const PLAN_TTL_MS = 5 * 60 * 1000
export const CHECKPOINT_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{4}$/
export const PLAN_ID_RE = /^p-\d{8}-\d{6}-[0-9a-f]{6}$/
export const MAX_LABEL_CHARS = 80
export const STATUS_CHECKPOINT_LIMIT = 50
export const MAX_SAMPLE_FILES = 30

export const CHECKPOINT_KINDS = Object.freeze(['auto', 'manual', 'safety', 'restore'])
export const CHECKPOINT_PHASES = Object.freeze(['before', 'after'])
export const RESTORE_MODES = Object.freeze(['overwrite', 'exact'])

export const SETTINGS_VERSION = 1
export const DEFAULT_CONFIG = Object.freeze({
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

export const CONFIG_LIMITS = Object.freeze({
  maxCheckpoints: [10, 1000],
  maxAgeDays: [1, 365],
  timeoutMs: [5000, 120000],
  restoreTimeoutMs: [10000, 600000],
  maxRestoreFileBytes: [1024 * 1024, 1024 * 1024 * 1024],
})

export const ERROR_CODES = Object.freeze({
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
