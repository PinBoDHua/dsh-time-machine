#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIRM_PHRASE } from '../shared/protocol.js'
import { ConfigStore } from './config.js'
import { EngineError, TimeMachineEngine } from './engine.js'
import { createBinding, GitRunner, repoStats, runGc, verifyCommit } from './git.js'
import { formatError, readJsonSafe } from './util.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const logger = {
  info(message) {
    console.log(message)
  },
  warn(message) {
    console.warn(message)
  },
  debug() {},
}

function dataDir() {
  const override = process.env.DSH_TIME_MACHINE_DATA_DIR
  if (typeof override === 'string' && override.trim() !== '') return resolve(override.trim())
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, '.dsh-time-machine')
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--')) {
      const equals = token.indexOf('=')
      if (equals >= 0) {
        args[token.slice(2, equals)] = token.slice(equals + 1)
        continue
      }
      const name = token.slice(2)
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('--')) {
        args[name] = next
        index += 1
      } else {
        args[name] = true
      }
    } else {
      args._.push(token)
    }
  }
  return args
}

function usage() {
  console.log(`dsh-time-machine v${pkg.version}

用法：
  dsh-time-machine status
  dsh-time-machine list --workspace <dir> [--limit 20]
  dsh-time-machine snapshot --workspace <dir> [--label <text>]
  dsh-time-machine restore --workspace <dir> --checkpoint <id> [--mode overwrite|exact] [--yes]
  dsh-time-machine recover [--workspace <dir> --plan <planId> --yes]
  dsh-time-machine gc --workspace <dir>
  dsh-time-machine doctor

环境变量：
  DSH_HOME                         默认 ~/.dsh，数据目录在其下
  DSH_TIME_MACHINE_DATA_DIR        覆盖数据目录
  DSH_TIME_MACHINE_DISABLE         非空时关闭自动快照

数据目录：${dataDir()}`)
}

function formatTime(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return String(iso)
  return date.toLocaleString('zh-CN', { hour12: false })
}

function printCheckpoint(entry, index) {
  const stats = entry.stats?.initial
    ? '初始快照'
    : `${String(entry.stats?.files ?? 0)} 文件 +${String(entry.stats?.added ?? 0)} −${String(entry.stats?.deleted ?? 0)}`
  const turn = entry.turn === null || entry.turn === undefined ? '' : ` 第 ${String(entry.turn)} 轮`
  const label = typeof entry.label === 'string' && entry.label !== '' ? `  ${entry.label}` : ''
  console.log(`${String(index + 1).padStart(2, ' ')}  ${entry.id}  ${formatTime(entry.createdAt)}  ${entry.kind}/${entry.phase}${turn}${label}  ${stats}`)
}

async function makeEngine(cwd) {
  const git = new GitRunner()
  await git.version()
  const configStore = new ConfigStore({ dataDir: dataDir(), logger })
  await configStore.load()
  const binding = await createBinding({ cwd, dataDir: dataDir(), git })
  const engine = new TimeMachineEngine({
    binding,
    configStore,
    git,
    logger,
    version: pkg.version,
  })
  await engine.init()
  return { engine, git, binding }
}

async function metadataFiles() {
  const directory = join(dataDir(), 'workspaces')
  try {
    return (await readdir(directory)).filter((file) => file.endsWith('.json')).map((file) => join(directory, file))
  } catch {
    return []
  }
}

async function commandStatus() {
  console.log(`dsh-time-machine v${pkg.version}`)
  console.log(`数据目录：${dataDir()}`)
  let gitLine
  try {
    gitLine = await new GitRunner().version()
  } catch (error) {
    gitLine = `不可用（${formatError(error)}）`
  }
  console.log(`git：${gitLine}`)
  const files = await metadataFiles()
  console.log(`工作区记录：${String(files.length)}`)
  let total = 0
  let journals = 0
  for (const file of files) {
    const { value, error } = await readJsonSafe(file)
    if (error !== undefined || value === null || typeof value !== 'object') {
      console.log(`  ! ${file} 无法读取`)
      continue
    }
    const count = Array.isArray(value.checkpoints) ? value.checkpoints.length : 0
    total += count
    const latest = value.checkpoints?.[0]
    const workspace = value.workspacePath ?? '?'
    console.log(`  ${workspace}`)
    console.log(`    还原点 ${String(count)}${latest ? `，最新 ${latest.id}（${formatTime(latest.createdAt)}）` : ''}`)
  }
  for (const file of await metadataFiles()) {
    const { value } = await readJsonSafe(file)
    if (value?.workspacePath === undefined) continue
    try {
      const binding = await createBinding({ cwd: value.workspacePath, dataDir: dataDir(), git: new GitRunner() })
      journals += (await readdir(binding.journalDir)).filter((name) => name.endsWith('.json')).length
    } catch {
      /* workspace may be gone */
    }
  }
  if (journals > 0) console.log(`未完成的恢复日志：${String(journals)}（运行 dsh-time-machine recover 查看）`)
  console.log(`合计还原点：${String(total)}`)
}

async function commandList(args) {
  const cwd = args.workspace
  if (typeof cwd !== 'string') throw new Error('需要 --workspace <dir>')
  const { engine } = await makeEngine(cwd)
  try {
    const status = await engine.status()
    console.log(`工作区：${status.workspacePath}`)
    console.log(`共 ${String(status.total)} 个还原点${status.busy ? '（有会话正在运行）' : ''}`)
    for (const [index, entry] of status.checkpoints.slice(0, Number(args.limit ?? 20)).entries()) printCheckpoint(entry, index)
    if (status.journals.length > 0) {
      console.log(`\n未完成的恢复日志：`)
      for (const journal of status.journals) console.log(`  ${journal.planId}  ${formatTime(journal.createdAt)}  安全点 ${journal.safetyId}`)
    }
  } finally {
    await engine.dispose()
  }
}

async function commandSnapshot(args) {
  const cwd = args.workspace
  if (typeof cwd !== 'string') throw new Error('需要 --workspace <dir>')
  const { engine } = await makeEngine(cwd)
  try {
    const label = typeof args.label === 'string' ? args.label : 'CLI 手动还原点'
    const result = await engine.manualSnapshot('cli', label)
    console.log(`已创建还原点 ${result.checkpoint.id}（${result.checkpoint.stats?.initial ? '初始快照' : `${String(result.checkpoint.stats.files)} 个文件`}）`)
  } finally {
    await engine.dispose()
  }
}

async function commandRestore(args) {
  const cwd = args.workspace
  if (typeof cwd !== 'string') throw new Error('需要 --workspace <dir>')
  if (typeof args.checkpoint !== 'string') throw new Error('需要 --checkpoint <id>')
  const mode = args.mode ?? 'overwrite'
  if (!['overwrite', 'exact'].includes(mode)) throw new Error('--mode 只能是 overwrite 或 exact')
  const { engine } = await makeEngine(cwd)
  try {
    const plan = await engine.planRestore({
      sessionId: 'cli',
      checkpointId: args.checkpoint,
      mode,
    })
    console.log(`恢复计划：${plan.mode}，写入 ${String(plan.writes)}，删除 ${String(plan.deletes)}，+${String(plan.addedLines)} −${String(plan.deletedLines)}`)
    for (const file of plan.sample) console.log(`  ${file.status}  ${file.path}`)
    if (plan.truncatedSample > 0) console.log(`  … 另有 ${String(plan.truncatedSample)} 个文件`)
    for (const warning of plan.warnings) console.log(`  ⚠ ${warning}`)
    if (args.yes !== true) {
      console.error('\n未执行。确认后加 --yes 重跑；恢复前会自动创建安全点。')
      process.exitCode = 2
      return
    }
    const result = await engine.applyRestore({
      sessionId: 'cli',
      planId: plan.planId,
      confirm: CONFIRM_PHRASE,
    })
    console.log(`已恢复：写入 ${String(result.writes)}，删除 ${String(result.deletes)}；安全点 ${result.safetyId}；恢复后快照 ${result.checkpointId}`)
  } finally {
    await engine.dispose()
  }
}

async function commandRecover(args) {
  const workspaces = []
  if (typeof args.workspace === 'string') {
    workspaces.push(args.workspace)
  } else {
    for (const file of await metadataFiles()) {
      const { value } = await readJsonSafe(file)
      if (typeof value?.workspacePath === 'string') workspaces.push(value.workspacePath)
    }
  }
  let found = false
  for (const cwd of workspaces) {
    const { engine } = await makeEngine(cwd)
    try {
      const journals = await engine.listJournals()
      if (journals.length === 0) continue
      for (const journal of journals) {
        found = true
        if (typeof args.plan !== 'string' || args.plan !== journal.planId) {
          console.log(`工作区 ${cwd}\n  ${journal.planId}  ${formatTime(journal.createdAt)}  目标 ${journal.targetId}  安全点 ${journal.safetyId}`)
          continue
        }
        if (args.yes !== true) {
          console.error('未执行。确认后加 --yes 重跑。')
          process.exitCode = 2
          continue
        }
        const result = await engine.recoverJournal(journal.planId)
        console.log(`已按 ${result.planId} 回滚到安全点 ${result.safetyId}`)
      }
    } finally {
      await engine.dispose()
    }
  }
  if (!found) console.log('没有未完成的恢复日志。')
}

async function commandGc(args) {
  const cwd = args.workspace
  if (typeof cwd !== 'string') throw new Error('需要 --workspace <dir>')
  const { engine, git, binding } = await makeEngine(cwd)
  try {
    const before = await repoStats(binding, { git })
    const ok = await runGc(binding, { git, timeoutMs: 300_000 })
    const after = await repoStats(binding, { git })
    console.log(`gc ${ok ? '完成' : '失败'}：对象 ${String(before.objects ?? '?')} → ${String(after.objects ?? '?')}，大小 ${String(before.bytes ?? '?')} → ${String(after.bytes ?? '?')} 字节`)
  } finally {
    await engine.dispose()
  }
}

async function commandDoctor() {
  console.log(`dsh-time-machine v${pkg.version} doctor`)
  console.log(`数据目录：${dataDir()}`)
  try {
    const exists = await stat(dataDir())
    console.log(`数据目录状态：${exists.isDirectory() ? 'ok' : '不是目录'}`)
  } catch {
    console.log('数据目录状态：尚未创建')
  }
  let version
  try {
    version = await new GitRunner().version()
    console.log(`git：${version}`)
  } catch (error) {
    console.log(`git：不可用（${formatError(error)}）`)
  }
  const files = await metadataFiles()
  if (files.length === 0) {
    console.log('工作区记录：0（还没有快照）')
    return
  }
  const git = new GitRunner()
  for (const file of files) {
    const { value, error } = await readJsonSafe(file)
    if (error !== undefined || value === null || typeof value !== 'object') {
      console.log(`  ✖ ${file}: 无法读取（${formatError(error)}）`)
      continue
    }
    let binding
    try {
      binding = await createBinding({ cwd: value.workspacePath, dataDir: dataDir(), git })
    } catch (failure) {
      console.log(`  ✖ ${value.workspacePath}: 工作区不可用（${formatError(failure)}）`)
      continue
    }
    const checkpoints = Array.isArray(value.checkpoints) ? value.checkpoints : []
    let missing = 0
    for (const entry of checkpoints.slice(0, 100)) {
      if (!(await verifyCommit(binding, { git, commit: entry.commit }))) missing += 1
    }
    const stats = await repoStats(binding, { git })
    let journals = 0
    try {
      journals = (await readdir(binding.journalDir)).filter((name) => name.endsWith('.json')).length
    } catch {
      journals = 0
    }
    console.log(`  ${missing === 0 ? '✔' : '✖'} ${value.workspacePath}`)
    console.log(`    还原点 ${String(checkpoints.length)}，缺失对象 ${String(missing)}，恢复日志 ${String(journals)}，对象 ${String(stats.objects ?? '?')}，约 ${String(stats.bytes ?? '?')} 字节`)
    try {
      const tempFiles = await readdir(binding.tmpDir)
      const stale = []
      for (const name of tempFiles) {
        const info = await stat(join(binding.tmpDir, name))
        if (Date.now() - info.mtimeMs > 24 * 60 * 60 * 1000) stale.push(name)
      }
      if (stale.length > 0) console.log(`    临时索引：${String(stale.length)} 个超过 24 小时`)
    } catch {
      /* no temp dir */
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0] ?? 'help'
  if (command === 'help' || command === '--help' || command === '-h') return usage()
  if (command === 'version') return console.log(pkg.version)
  if (command === 'status') return commandStatus()
  if (command === 'list') return commandList(args)
  if (command === 'snapshot') return commandSnapshot(args)
  if (command === 'restore') return commandRestore(args)
  if (command === 'recover') return commandRecover(args)
  if (command === 'gc') return commandGc(args)
  if (command === 'doctor') return commandDoctor()
  usage()
  process.exitCode = 2
}

main().catch((error) => {
  if (error instanceof EngineError) {
    console.error(`错误：${error.message}`)
  } else {
    console.error(`错误：${formatError(error)}`)
  }
  process.exitCode = 1
})
