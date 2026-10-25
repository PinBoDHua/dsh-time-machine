import {
  CONTROL_HEADER,
  CONFIRM_PHRASE,
  ROUTES,
} from '../../shared/protocol.js'

export class ApiError extends Error {
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
export function createApi() {
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
