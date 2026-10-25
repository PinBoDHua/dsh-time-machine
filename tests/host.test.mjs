import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Readable } from 'node:stream'
import { apply } from '../lib/index.js'

function fakeCtx({ sessions, webServer }) {
  const handlers = new Map()
  const disposers = []
  const commands = []
  const tools = []
  const effects = []
  const logger = { info() {}, warn() {}, debug() {} }
  const ctx = {
    logger,
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
    },
    effect(fn, label) {
      const disposable = fn()
      effects.push({ label, disposable })
      if (typeof disposable === 'function') disposers.push(disposable)
      return disposable
    },
    inject(_names, callback) {
      if (webServer !== undefined) callback({ effect: ctx.effect, webServer })
      return { dispose() {} }
    },
    get(name) {
      if (name === 'profileContext') return undefined
      return undefined
    },
    sessions,
    commands: {
      register(definition) {
        commands.push(definition)
        return () => {}
      },
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
  }
  async function emit(event, ...args) {
    const list = handlers.get(event) ?? []
    // agent/turn-stopping is awaited; session/event is fire-and-forget.
    if (event === 'session/event') {
      for (const handler of list) handler(...args)
      return
    }
    for (const handler of list) await handler(...args)
  }
  async function preExecute(exec) {
    const list = handlers.get('tools/pre-execute') ?? []
    let index = 0
    const next = async () => {
      const handler = list[index]
      index += 1
      return handler === undefined ? undefined : handler(exec, next)
    }
    return next()
  }
  return { ctx, handlers, commands, tools, effects, disposers, emit, preExecute }
}

function fakeWebServer() {
  const routes = new Map()
  return {
    routes,
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
}

function request(url, { method = 'GET', key, body } = {}) {
  const headers = { host: 'localhost:1234' }
  if (key !== undefined) headers['x-dsh-time-machine-key'] = key
  if (body !== undefined) headers['content-type'] = 'application/json'
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  stream.method = method
  stream.url = url
  stream.headers = headers
  stream.socket = { remoteAddress: '127.0.0.1' }
  return stream
}

async function respond(handler, req) {
  let status
  let payload = ''
  const res = {
    writeHead(code) {
      status = code
    },
    end(chunk) {
      payload += chunk ?? ''
    },
  }
  await handler(req, res)
  return { status, body: payload === '' ? undefined : JSON.parse(payload) }
}

async function waitFor(predicate, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('timed out waiting for condition')
}

test('宿主接线：自动快照、面板接口、恢复与安全校验', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tm-host-'))
  const ws = join(root, 'ws')
  const data = join(root, 'data')
  await mkdir(ws, { recursive: true })
  await writeFile(join(ws, 'a.txt'), 'one\n')
  process.env.DSH_TIME_MACHINE_DATA_DIR = data
  t.after(async () => {
    delete process.env.DSH_TIME_MACHINE_DATA_DIR
    await rm(root, { recursive: true, force: true })
  })
  const session = {
    id: 's-home',
    header: { cwd: ws, origin: 'user', delegationDepth: 0 },
  }
  const sessions = {
    get(id) {
      return id === session.id ? session : undefined
    },
  }
  const webServer = fakeWebServer()
  const fake = fakeCtx({ sessions, webServer })
  await apply(fake.ctx)

  assert.equal(fake.commands.length, 1)
  assert.equal(fake.commands[0].name, 'rewind')
  assert.equal(fake.tools.length, 1)
  assert.equal(fake.tools[0].name, 'time_machine')
  const statusRoute = webServer.routes.get('/plugins/dsh-time-machine/status')
  const checkpointRoute = webServer.routes.get('/plugins/dsh-time-machine/checkpoint')
  const planRoute = webServer.routes.get('/plugins/dsh-time-machine/plan')
  const restoreRoute = webServer.routes.get('/plugins/dsh-time-machine/restore')
  const configRoute = webServer.routes.get('/plugins/dsh-time-machine/config')
  assert.ok(statusRoute && checkpointRoute && planRoute && restoreRoute && configRoute)

  // 无会话：接口返回 404，而不是崩掉
  const missing = await respond(statusRoute.handler, request('/plugins/dsh-time-machine/status'))
  assert.equal(missing.status, 400)

  await fake.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  await fake.preExecute({ agent: { session }, signal: new AbortController().signal, callId: 'c1' })
  await writeFile(join(ws, 'a.txt'), 'two\n')
  await writeFile(join(ws, 'new.txt'), 'new\n')
  await fake.emit('agent/turn-stopping', { agent: { session }, turn: 1 })
  await fake.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: 'completed' } })
  await waitFor(async () => {
    const response = await respond(statusRoute.handler, request('/plugins/dsh-time-machine/status?sessionId=s-home'))
    return response.body?.total >= 2
  })

  const status = await respond(statusRoute.handler, request('/plugins/dsh-time-machine/status?sessionId=s-home'))
  assert.equal(status.status, 200)
  assert.equal(status.body.ok, true)
  assert.equal(status.body.sessionId, 's-home')
  assert.ok(status.body.key)
  assert.equal(status.body.checkpoints[0].kind, 'auto')
  assert.equal(status.body.checkpoints[0].turn, 1)
  assert.equal(status.body.busy, false)
  const first = status.body.checkpoints[status.body.checkpoints.length - 1]

  const noKey = await respond(planRoute.handler, request('/plugins/dsh-time-machine/plan', {
    method: 'POST',
    body: { sessionId: 's-home', checkpointId: first.id, mode: 'overwrite' },
  }))
  assert.equal(noKey.status, 403)

  const plan = await respond(planRoute.handler, request('/plugins/dsh-time-machine/plan', {
    method: 'POST',
    key: status.body.key,
    body: { sessionId: 's-home', checkpointId: first.id, mode: 'overwrite' },
  }))
  assert.equal(plan.status, 200)
  assert.equal(plan.body.plan.mode, 'overwrite')

  const restored = await respond(restoreRoute.handler, request('/plugins/dsh-time-machine/restore', {
    method: 'POST',
    key: status.body.key,
    body: { sessionId: 's-home', planId: plan.body.plan.planId, confirm: 'RESTORE' },
  }))
  assert.equal(restored.status, 200)
  assert.equal(restored.body.result.restored, true)
  assert.equal(await readFile(join(ws, 'a.txt'), 'utf8'), 'one\n')

  const config = await respond(configRoute.handler, request('/plugins/dsh-time-machine/config', {
    method: 'POST',
    key: status.body.key,
    body: { config: { maxCheckpoints: 5, excludes: ['node_modules/', '.git/'] } },
  }))
  assert.equal(config.status, 200)
  assert.equal(config.body.config.maxCheckpoints, 10)

  const manifest = await respond(checkpointRoute.handler, request('/plugins/dsh-time-machine/checkpoint', {
    method: 'POST',
    key: status.body.key,
    body: { sessionId: 's-home', label: 'manual from panel' },
  }))
  assert.equal(manifest.status, 200)
  assert.equal(manifest.body.checkpoint.label, 'manual from panel')

  const command = fake.commands[0]
  const listed = await command.handler({
    agent: { session },
    rawInput: '',
    signal: new AbortController().signal,
    commandId: 'cmd1',
  })
  assert.equal(listed.kind, 'success')
  assert.match(listed.text, /共 \d+ 个还原点/)

  const tool = fake.tools[0]
  const toolList = await tool.execute({ action: 'list' }, {
    agent: { session },
    signal: new AbortController().signal,
    callId: 'tc1',
  })
  const parsed = JSON.parse(toolList)
  assert.ok(parsed.checkpoints.length >= 2)

  // 非回环请求被拒绝
  const remote = request('/plugins/dsh-time-machine/status?sessionId=s-home')
  remote.socket.remoteAddress = '10.0.0.8'
  const denied = await respond(statusRoute.handler, remote)
  assert.equal(denied.status, 403)

  // 卸载时释放引擎
  for (const { disposable } of fake.effects) {
    if (typeof disposable === 'function') await disposable()
  }
})
