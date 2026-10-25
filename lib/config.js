import { join } from 'node:path'
import { rename } from 'node:fs/promises'
import {
  CONFIG_LIMITS,
  DEFAULT_CONFIG,
  SETTINGS_VERSION,
} from '../shared/protocol.js'
import {
  clampInt,
  ensureDir,
  nowIso,
  readJsonSafe,
  sanitizeExcludes,
  writeJsonAtomic,
} from './util.js'

export const SETTINGS_FILE = 'settings.json'

export function defaultConfig() {
  return { ...DEFAULT_CONFIG, excludes: [...DEFAULT_CONFIG.excludes] }
}

/**
 * 把任意输入收敛成合法配置。非法值不抛错，而是退回默认值并记一条 issue：
 * 一个损坏的字段不应该让整个插件拒绝启动。
 */
export function normalizeConfig(input, base = defaultConfig()) {
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const issues = []
  const config = { ...base, version: SETTINGS_VERSION }
  for (const key of ['auto', 'beforeTurn', 'afterTurn', 'autoGc']) {
    if (source[key] === undefined) continue
    if (typeof source[key] === 'boolean') config[key] = source[key]
    else issues.push(`${key} 必须是布尔值，已保留 ${String(base[key])}`)
  }
  for (const key of ['maxCheckpoints', 'maxAgeDays', 'timeoutMs', 'restoreTimeoutMs', 'maxRestoreFileBytes']) {
    if (source[key] === undefined) continue
    const value = Number(source[key])
    if (!Number.isFinite(value)) {
      issues.push(`${key} 必须是数字，已保留 ${String(base[key])}`)
      continue
    }
    const clamped = clampInt(value, CONFIG_LIMITS[key], base[key])
    if (clamped !== Math.trunc(value)) issues.push(`${key} 超出范围，已收敛到 ${clamped}`)
    config[key] = clamped
  }
  if (source.excludes !== undefined) {
    try {
      config.excludes = sanitizeExcludes(source.excludes)
    } catch (error) {
      issues.push(`excludes 无效：${error.message}`)
    }
  }
  return { config, issues }
}

export class ConfigStore {
  constructor({ dataDir, logger }) {
    this.dataDir = dataDir
    this.file = join(dataDir, SETTINGS_FILE)
    this.logger = logger
    this.config = defaultConfig()
    this.issues = []
    this.loaded = false
  }

  async load() {
    await ensureDir(this.dataDir)
    const { value, error } = await readJsonSafe(this.file)
    if (error !== undefined) {
      this.issues = [`settings.json 读取失败：${error.message}`]
      this.logger?.warn?.(`dsh-time-machine: settings.json 读取失败（${error.message}），已使用默认配置`)
      try {
        await rename(this.file, join(this.dataDir, `settings.corrupt-${Date.now()}.json`))
      } catch {
        /* 无法备份也继续用默认值 */
      }
    } else if (value !== undefined) {
      const normalized = normalizeConfig(value)
      this.config = normalized.config
      this.issues = normalized.issues
      if (normalized.issues.length > 0) {
        this.logger?.warn?.(`dsh-time-machine: settings.json 有 ${normalized.issues.length} 处无效字段，已使用修正后的值`)
      }
    }
    this.loaded = true
    return this.config
  }

  /**
   * 环境变量是部署级熔断：它只关掉自动快照，手动快照与恢复仍然可用。
   * 这样用户在 Agent 失控时可以先止血，而不必卸载插件。
   */
  get() {
    const config = this.config
    if (process.env.DSH_TIME_MACHINE_DISABLE !== undefined && process.env.DSH_TIME_MACHINE_DISABLE !== '') {
      return { ...config, auto: false }
    }
    return config
  }

  raw() {
    return this.config
  }

  async update(patch) {
    const normalized = normalizeConfig(patch, this.config)
    this.config = normalized.config
    await writeJsonAtomic(this.file, {
      ...this.config,
      updatedAt: nowIso(),
    })
    this.issues = normalized.issues
    return { config: this.config, issues: normalized.issues }
  }
}
