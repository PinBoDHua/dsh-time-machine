import { timingSafeEqual } from 'node:crypto'
import {
  CONTROL_HEADER,
  ERROR_CODES,
  MAX_BODY_BYTES,
  ROUTES,
} from '../shared/protocol.js'
import { EngineError } from './engine.js'
import { formatError } from './util.js'

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(payload)
}

function isLoopbackAddress(value) {
  const text = String(value).trim().toLowerCase()
  if (text === '::1' || text === 'localhost') return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(text)) return true
  return /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(text)
}

function loopbackRequest(req) {
  const remote = req.socket?.remoteAddress ?? req.connection?.remoteAddress
  if (typeof remote !== 'string' || remote === '' || !isLoopbackAddress(remote)) return false
  for (const header of ['via', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip']) {
    if (req.headers?.[header] !== undefined) return false
  }
  const host = String(req.headers.host ?? '')
  if (!/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(host)) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  return /^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(String(origin))
}

function keyMatches(given, expected) {
  if (typeof given !== 'string') return false
  const left = Buffer.from(given)
  const right = Buffer.from(expected)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0
    let settled = false
    let tooLarge = false
    const chunks = []
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const onData = (chunk) => {
      if (tooLarge) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        tooLarge = true
        chunks.length = 0
        req.resume()
        finish({ tooLarge: true })
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => finish(tooLarge ? { tooLarge: true } : { text: Buffer.concat(chunks).toString('utf8') })
    const timer = setTimeout(() => finish({ timeout: true }), 30_000)
    timer.unref?.()
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', () => finish({ aborted: true }))
    req.once('aborted', () => finish({ aborted: true }))
  })
}

function statusFor(error) {
  switch (error?.code) {
    case ERROR_CODES.badRequest:
    case ERROR_CODES.configInvalid:
    case ERROR_CODES.confirmRequired:
    case 'UNSUPPORTED_SYMLINK':
    case 'CASE_CONFLICT':
    case 'PATH_CONFLICT':
    case 'FILE_TOO_LARGE':
    case 'UNSAFE_PATH':
    case 'NOTHING_TO_RESTORE':
      return 400
    case ERROR_CODES.sessionUnsupported:
    case 'BAD_WORKSPACE':
    case 'NO_CWD':
    case ERROR_CODES.sessionNotFound:
    case ERROR_CODES.planNotFound:
    case ERROR_CODES.checkpointNotFound:
    case ERROR_CODES.notFound:
      return 404
    case ERROR_CODES.sessionBusy:
    case ERROR_CODES.workspaceChanged:
      return 409
    case ERROR_CODES.planExpired:
      return 410
    case ERROR_CODES.forbidden:
    case ERROR_CODES.unauthorized:
      return 403
    case ERROR_CODES.gitUnavailable:
      return 503
    default:
      return 500
  }
}

function normalizeError(error) {
  const code = typeof error?.code === 'string' ? error.code : ERROR_CODES.requestFailed
  return {
    code,
    message: error instanceof EngineError ? error.message : formatError(error),
    details: error?.details,
  }
}

export function attachRoutes({
  webCtx,
  getSession,
  engineFor,
  sessionCwd,
  eligible,
  configStore,
  controlKey,
  logger,
}) {
  const requireSession = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new EngineError(ERROR_CODES.badRequest, 'sessionId 是必需的')
    }
    const session = getSession(sessionId)
    if (session === undefined) throw new EngineError(ERROR_CODES.sessionNotFound, '会话不存在或已经结束')
    if (!eligible(session)) throw new EngineError(ERROR_CODES.sessionUnsupported, '时光机只记录顶层会话')
    const cwd = sessionCwd(session)
    if (cwd === undefined) throw new EngineError(ERROR_CODES.sessionUnsupported, '当前会话没有工作目录')
    return { session, cwd }
  }

  const requireAuth = (req) => {
    if (!keyMatches(req.headers?.[CONTROL_HEADER], controlKey)) {
      throw new EngineError(ERROR_CODES.unauthorized, '控制密钥无效，请刷新页面后重试')
    }
  }

  const parseBody = async (req) => {
    const body = await readBody(req)
    if (body.tooLarge) throw new EngineError(ERROR_CODES.badRequest, '请求体过大')
    if (body.aborted || body.timeout) throw new EngineError(ERROR_CODES.badRequest, '请求被中断')
    let value
    try {
      value = body.text === undefined || body.text === '' ? {} : JSON.parse(body.text)
    } catch {
      throw new EngineError(ERROR_CODES.badRequest, '请求体不是合法 JSON')
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new EngineError(ERROR_CODES.badRequest, '请求体必须是对象')
    }
    return value
  }

  const route = (path, handler) => webCtx.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (!loopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: { code: ERROR_CODES.forbidden, message: '只接受本机请求' } })
        return
      }
      try {
        await handler(req, res)
      } catch (error) {
        const normalized = normalizeError(error)
        if (normalized.code !== ERROR_CODES.sessionBusy) {
          logger?.warn?.(`dsh-time-machine: ${req.method ?? 'GET'} ${path} 失败：${normalized.message}`)
        }
        try {
          writeJson(res, statusFor(error), { ok: false, error: normalized })
        } catch {
          /* response already closed */
        }
      }
    },
  })

  const disposers = []

  disposers.push(route(ROUTES.status, async (req, res) => {
    if ((req.method ?? 'GET') !== 'GET') {
      writeJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'GET only' } })
      return
    }
    const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
    const { session, cwd } = requireSession(url.searchParams.get('sessionId') ?? '')
    const engine = await engineFor(cwd)
    const status = await engine.status(session.id)
    writeJson(res, 200, { ok: true, key: controlKey, sessionId: session.id, ...status })
  }))

  disposers.push(route(ROUTES.checkpoint, async (req, res) => {
    if ((req.method ?? 'GET') !== 'POST') {
      writeJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } })
      return
    }
    requireAuth(req)
    const body = await parseBody(req)
    const { session, cwd } = requireSession(body.sessionId)
    const engine = await engineFor(cwd)
    const result = await engine.manualSnapshot(session.id, body.label)
    writeJson(res, 200, { ok: true, checkpoint: result.checkpoint })
  }))

  disposers.push(route(ROUTES.plan, async (req, res) => {
    if ((req.method ?? 'GET') !== 'POST') {
      writeJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } })
      return
    }
    requireAuth(req)
    const body = await parseBody(req)
    const { session, cwd } = requireSession(body.sessionId)
    if (typeof body.checkpointId !== 'string' || typeof body.mode !== 'string') {
      throw new EngineError(ERROR_CODES.badRequest, 'checkpointId 与 mode 是必需的')
    }
    const engine = await engineFor(cwd)
    const plan = await engine.planRestore({
      sessionId: session.id,
      checkpointId: body.checkpointId,
      mode: body.mode,
    })
    writeJson(res, 200, { ok: true, plan })
  }))

  disposers.push(route(ROUTES.restore, async (req, res) => {
    if ((req.method ?? 'GET') !== 'POST') {
      writeJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } })
      return
    }
    requireAuth(req)
    const body = await parseBody(req)
    const { session, cwd } = requireSession(body.sessionId)
    if (typeof body.planId !== 'string' || typeof body.confirm !== 'string') {
      throw new EngineError(ERROR_CODES.badRequest, 'planId 与 confirm 是必需的')
    }
    const engine = await engineFor(cwd)
    const result = await engine.applyRestore({
      sessionId: session.id,
      planId: body.planId,
      confirm: body.confirm,
    })
    writeJson(res, 200, { ok: true, result })
  }))

  disposers.push(route(ROUTES.config, async (req, res) => {
    if ((req.method ?? 'GET') !== 'POST') {
      writeJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST only' } })
      return
    }
    requireAuth(req)
    const body = await parseBody(req)
    if (body.config === null || typeof body.config !== 'object' || Array.isArray(body.config)) {
      throw new EngineError(ERROR_CODES.configInvalid, 'config 必须是对象')
    }
    const updated = await configStore.update(body.config)
    writeJson(res, 200, { ok: true, config: updated.config, issues: updated.issues })
  }))

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* best effort */
      }
    }
  }
}
