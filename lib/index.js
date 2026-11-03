import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_ID } from '../shared/protocol.js'
import { ConfigStore } from './config.js'
import { EngineError, TimeMachineEngine } from './engine.js'
import { createBinding, GitRunner } from './git.js'
import { attachRoutes } from './server.js'
import { registerCommand, registerTool } from './surfaces.js'
import { canonicalPath, formatError } from './util.js'

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))

export const name = PLUGIN_ID
export const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0'
export const inject = ['commands', 'tools', 'sessions']

function dataDirOf(_ctx) {
  const override = process.env.DSH_TIME_MACHINE_DATA_DIR
  if (typeof override === 'string' && override.trim() !== '') return resolve(override.trim())
  // 还原点是工作区级而非 profile 级的：桌面端、Web 端和 CLI 必须看到同一份
  // 时间线，因此默认落在 DSH_HOME，而不是某个 profile 目录下。
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, '.dsh-time-machine')
}

function cacheKeyOf(cwd) {
  const resolved = resolve(cwd)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * 宿主侧入口：会话事件 → 自动还原点；命令/工具/HTTP → 人工快照与恢复。
 * 所有工作区引擎共享同一份配置，但各自拥有独立的影子仓库与串行链。
 */
export async function apply(ctx) {
  const configuredDataDir = dataDirOf(ctx)
  await mkdir(configuredDataDir, { recursive: true })
  // 环境变量可能指向符号链接/交汇点。先收敛成真实路径，否则“数据目录位于
  // 工作区内”的排除规则可能看不出来，影子仓库会把自己拍进快照。
  const dataDir = await canonicalPath(configuredDataDir)
  const configStore = new ConfigStore({ dataDir, logger: ctx.logger })
  await configStore.load()
  const git = new GitRunner()
  let gitVersion
  let gitError
  try {
    gitVersion = await git.version()
  } catch (error) {
    gitError = formatError(error)
    ctx.logger?.warn?.(`dsh-time-machine: ${gitError}；自动快照与恢复会保持不可用`)
  }
  const gitAvailable = gitVersion !== undefined
  const controlKey = randomBytes(24).toString('hex')

  const engines = new Map()
  const sessionCwd = new Map()
  const turnEngines = new Map()
  const pendingPre = new Map()

  const engineFor = async (cwd) => {
    if (!gitAvailable) {
      throw new EngineError('GIT_UNAVAILABLE', `找不到可用的 git（${gitError ?? 'unknown'}），时光机暂不可用`)
    }
    // 同一个工作区可能通过 C:\ws、C:\ws-link（交汇点）或不同大小写到达。
    // createBinding 会 canonicalPath，但缓存键必须也用同一个真实路径，否则会
    // 建出两个引擎写同一份元数据，面板看到的时间线会分叉。
    const canonicalCwd = await canonicalPath(cwd)
    const key = cacheKeyOf(canonicalCwd)
    const existing = engines.get(key)
    if (existing !== undefined) return existing
    const created = (async () => {
      const binding = await createBinding({ cwd: canonicalCwd, dataDir, git })
      const engine = new TimeMachineEngine({
        binding,
        configStore,
        git,
        logger: ctx.logger,
        version,
        gitAvailable,
      })
      await engine.init()
      return engine
    })()
    engines.set(key, created)
    created.catch(() => {
      if (engines.get(key) === created) engines.delete(key)
    })
    return created
  }

  // workingDirectory 服务是会话有效目录的权威来源；Session.header.cwd 只是
  // 原始项目目录，可能为空（例如从默认目录启动的会话）。这里用可选查找，
  // 不把插件强制绑定到某个 DSH 版本。
  let workingDirectory
  try {
    workingDirectory = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
  } catch {
    workingDirectory = undefined
  }
  const cwdOf = (session) => {
    const overridden = sessionCwd.get(session.id)
    if (typeof overridden === 'string' && overridden !== '') return overridden
    try {
      const effective = workingDirectory?.get?.(session)
      if (typeof effective === 'string' && effective !== '') return effective
    } catch {
      /* fall back to the immutable header */
    }
    const original = session.header?.cwd
    return typeof original === 'string' && original !== '' ? original : undefined
  }

  const eligible = (session) => {
    const header = session?.header
    if (header === undefined || header === null) return false
    if (header.origin === 'subagent') return false
    if ((header.delegationDepth ?? 0) > 0) return false
    return cwdOf(session) !== undefined
  }

  const beginTurn = (session, turn) => {
    const cwd = cwdOf(session)
    if (cwd === undefined) return
    const enginePromise = engineFor(cwd)
    const pending = enginePromise.then((engine) => engine.startTurn(session.id, turn))
    turnEngines.set(session.id, { turn, enginePromise })
    pendingPre.set(session.id, pending)
    pending.catch((error) => {
      ctx.logger?.warn?.(`dsh-time-machine: 缓存轮次开始状态失败：${formatError(error)}`)
    }).finally(() => {
      if (pendingPre.get(session.id) === pending) pendingPre.delete(session.id)
    })
  }

  const endTurn = (session, turn) => {
    const entry = turnEngines.get(session.id)
    if (entry !== undefined && entry.turn === turn) turnEngines.delete(session.id)
    pendingPre.delete(session.id)
    const cwd = cwdOf(session)
    if (cwd === undefined) return
    // 必须用轮次开始时对应的那个引擎收尾。会话在轮次中切换工作目录后，
    // cwdOf(session) 已指向新目录；若在这里重新 engineFor，旧引擎的
    // activeTurns 永远清不掉，整个旧工作区会一直显示“会话运行中”。
    const enginePromise = entry?.turn === turn ? entry.enginePromise : engineFor(cwd)
    void enginePromise.then((engine) => engine.endTurn(session.id, turn)).catch((error) => {
      ctx.logger?.warn?.(`dsh-time-machine: 缓存轮次结束状态失败：${formatError(error)}`)
    })
  }

  const stopping = async (session, turn) => {
    const cwd = cwdOf(session)
    if (cwd === undefined) return
    const entry = turnEngines.get(session.id)
    const enginePromise = entry?.turn === turn ? entry.enginePromise : engineFor(cwd)
    const engine = await enginePromise
    await engine.stopping(session.id, turn)
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'working-directory/change') {
      const cwd = event.data?.cwd
      if (typeof cwd === 'string' && cwd !== '') sessionCwd.set(session.id, cwd)
      return
    }
    if (event.type === 'turn/start') {
      if (eligible(session)) beginTurn(session, event.data.turn)
      return
    }
    if (event.type === 'turn/end') {
      if (eligible(session)) endTurn(session, event.data.turn)
    }
  })

  ctx.on('session/disposed', (session) => {
    sessionCwd.delete(session.id)
    turnEngines.delete(session.id)
    pendingPre.delete(session.id)
    // 会话可能已经换过工作目录，旧引擎不在当前 cwd 上；逐个通知所有已建
    // 引擎，避免旧引擎的 activeTurns/afterAttempts 永久残留。
    const pending = [...engines.values()]
    void Promise.allSettled(pending).then((settled) => {
      for (const result of settled) {
        if (result.status === 'fulfilled') result.value.forgetSession(session.id)
      }
    })
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    if (agent?.session === undefined) return
    if (!eligible(agent.session)) return
    // 快照失败只影响还原点，绝不能让 Agent 的回合以插件错误结束。
    try {
      await stopping(agent.session, turn)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-time-machine: 轮次收尾快照失败：${formatError(error)}`)
    }
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const session = exec.agent?.session
    if (session !== undefined) {
      const pending = pendingPre.get(session.id)
      if (pending !== undefined) {
        // 快照失败不应阻断工具；错误已经由 startTurn 记录到面板。
        await pending.catch(() => undefined)
      }
    }
    return next()
  })

  const surfaces = { engineFor, sessionCwd: cwdOf, eligible, logger: ctx.logger }
  ctx.effect(() => registerCommand(ctx, surfaces), 'dsh-time-machine /rewind')
  ctx.effect(() => registerTool(ctx, surfaces), 'dsh-time-machine time_machine tool')

  try {
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => attachRoutes({
        webCtx,
        getSession: (sessionId) => ctx.sessions.get(sessionId),
        engineFor,
        sessionCwd: cwdOf,
        eligible,
        configStore,
        controlKey,
        logger: ctx.logger,
      }), 'dsh-time-machine routes')
    })
  } catch (error) {
    ctx.logger?.warn?.(`dsh-time-machine: 无法挂载面板接口（没有 webServer）：${formatError(error)}`)
  }

  ctx.effect(() => async () => {
    const settled = await Promise.allSettled([...engines.values()])
    for (const result of settled) {
      if (result.status === 'fulfilled') await result.value.dispose()
    }
    engines.clear()
    sessionCwd.clear()
    turnEngines.clear()
    pendingPre.clear()
  }, 'dsh-time-machine engines')

  ctx.logger?.info?.(
    `dsh-time-machine v${version}: ${gitAvailable ? `影子快照已就绪（${gitVersion}）` : 'git 不可用'}，数据目录 ${dataDir}`,
  )
}
