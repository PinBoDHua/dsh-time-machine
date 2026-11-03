import { spawn } from 'node:child_process'
import { copyFile, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import {
  abortError,
  canonicalPath,
  ensureDir,
  exists,
  formatError,
  isInside,
  nowIso,
  toPosix,
  workspaceKey,
} from './util.js'

const DEFAULT_TIMEOUT_MS = 30_000
const STDERR_CAP = 64 * 1024
const TERMINATE_GRACE_MS = 1500
// 影子仓库的属性必须压过工作区里的 .gitattributes。否则 ident、clean filter、
// working-tree-encoding 等规则会在 git add 时改写 blob，恢复出来的就不是原始字节。
const SHADOW_ATTRIBUTES = '* -text -filter -ident -working-tree-encoding\n'

export class GitError extends Error {
  constructor(message, { code = 'GIT_FAILED', exitCode, stderr, args } = {}) {
    super(message)
    this.name = 'GitError'
    this.code = code
    if (exitCode !== undefined) this.exitCode = exitCode
    if (stderr !== undefined) this.stderr = stderr
    if (args !== undefined) this.args = args
  }
}

function scrubEnv() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (
      key === 'GIT_DIR' ||
      key === 'GIT_WORK_TREE' ||
      key === 'GIT_INDEX_FILE' ||
      key === 'GIT_OBJECT_DIRECTORY' ||
      key === 'GIT_ALTERNATE_OBJECT_DIRECTORIES' ||
      key === 'GIT_COMMON_DIR' ||
      key === 'GIT_NAMESPACE' ||
      key === 'GIT_PREFIX' ||
      key === 'GIT_QUARANTINE_PATH' ||
      key.startsWith('GIT_CONFIG_') ||
      key.startsWith('GIT_AUTHOR_') ||
      key.startsWith('GIT_COMMITTER_')
    ) {
      continue
    }
    env[key] = value
  }
  return env
}

/**
 * 一个只执行本地 plumbing 的 Git 运行器：无 shell、无终端提示、无系统/全局
 * 配置、超时与输出都有硬上限。所有参数都由本插件构造，不把用户输入拼进命令行。
 */
export class GitRunner {
  constructor({ executable = 'git', env = {} } = {}) {
    this.executable = executable
    this.baseEnv = { ...scrubEnv(), ...env }
  }

  async version(signal) {
    const result = await this.run(['--version'], { signal, timeoutMs: 10_000, maxBytes: 4096 })
    if (result.exitCode !== 0) throw new GitError(`git 不可用：${result.stderr.trim()}`, { code: 'GIT_UNAVAILABLE' })
    return result.stdout.trim()
  }

  async run(args, options = {}) {
    const {
      cwd,
      env = {},
      signal,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      maxBytes = 16 * 1024 * 1024,
      stdin,
      binary = false,
    } = options
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new TypeError('git arguments must be an array of strings')
    }
    if (signal?.aborted) throw abortError()

    const child = spawn(this.executable, args, {
      cwd,
      env: {
        ...this.baseEnv,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_ATTR_NOSYSTEM: '1',
        LC_ALL: 'C',
        LANG: 'C',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdoutLength = 0
    let stderrLength = 0
    const stdoutChunks = []
    const stderrChunks = []
    let overflow = false
    let timedOut = false
    let aborted = false
    let settled = false
    let graceTimer
    let timeoutTimer

    const kill = () => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      graceTimer ??= setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }, TERMINATE_GRACE_MS)
      graceTimer.unref?.()
    }

    const onAbort = () => {
      aborted = true
      kill()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    timeoutTimer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)
    timeoutTimer.unref?.()

    child.stdout.on('data', (chunk) => {
      if (overflow) return
      stdoutLength += chunk.length
      if (stdoutLength > maxBytes) {
        overflow = true
        kill()
        return
      }
      stdoutChunks.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      if (stderrLength >= STDERR_CAP) return
      const room = STDERR_CAP - stderrLength
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk
      stderrChunks.push(kept)
      stderrLength += kept.length
    })

    const result = await new Promise((resolvePromise, reject) => {
      const settle = (fn) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutTimer)
        if (graceTimer !== undefined) clearTimeout(graceTimer)
        signal?.removeEventListener('abort', onAbort)
        fn()
      }
      child.on('error', (error) => {
        settle(() => reject(new GitError(`无法启动 git：${formatError(error)}`, { code: 'GIT_UNAVAILABLE', args })))
      })
      child.on('close', (code, closeSignal) => {
        settle(() => {
          if (aborted) return reject(abortError())
          if (timedOut) {
            return reject(new GitError(`git ${args[0]} 超时（${timeoutMs}ms）`, { code: 'GIT_TIMEOUT', args }))
          }
          if (overflow) {
            return reject(new GitError(`git ${args[0]} 输出超过 ${maxBytes} 字节上限`, { code: 'GIT_OUTPUT_LIMIT', args }))
          }
          const stdoutBuffer = Buffer.concat(stdoutChunks)
          const stderr = Buffer.concat(stderrChunks).toString('utf8')
          resolvePromise({
            exitCode: code,
            closeSignal,
            stdout: binary ? '' : stdoutBuffer.toString('utf8'),
            ...(binary ? { buffer: stdoutBuffer } : {}),
            stderr,
            args,
          })
        })
      })
      child.stdin.on('error', () => {
        /* EPIPE when git exits before consuming stdin */
      })
      if (stdin !== undefined) child.stdin.end(stdin)
      else child.stdin.end()
    })
    return result
  }

  async runBuffer(args, options = {}) {
    const result = await this.run(args, { ...options, binary: true })
    if (result.exitCode !== 0) {
      throw new GitError(`git ${args[0]} 失败：${result.stderr.trim() || `exit ${String(result.exitCode)}`}`, {
        exitCode: result.exitCode,
        stderr: result.stderr,
        args,
      })
    }
    return result
  }
}

export function expectOk(result, what) {
  if (result.exitCode === 0) return result
  throw new GitError(`${what} 失败：${result.stderr.trim() || `exit ${String(result.exitCode)}`}`, {
    exitCode: result.exitCode,
    stderr: result.stderr,
    args: result.args,
  })
}

function baseEnvFor(binding) {
  return {
    GIT_DIR: binding.gitDir,
    GIT_WORK_TREE: binding.workTree,
    GIT_CONFIG_GLOBAL: binding.emptyConfig,
  }
}

/**
 * 解析会话工作目录对应的快照范围。
 *
 * 工作区身份是会话自己的工作目录；如果它位于一个 Git 仓库内，快照的根取
 * 仓库根、只抓取工作目录子树，这样仓库根的 .gitignore 与嵌套忽略规则都仍然
 * 生效。仓库外则把工作目录本身当作根。
 */
export async function createBinding({ cwd, dataDir, git }) {
  if (typeof cwd !== 'string' || cwd.trim() === '') throw new GitError('会话没有工作目录', { code: 'NO_CWD' })
  let workspacePath
  try {
    workspacePath = await canonicalPath(cwd)
    if (!(await stat(workspacePath)).isDirectory()) throw new Error('not a directory')
  } catch (error) {
    throw new GitError(`工作目录不可用：${formatError(error)}`, { code: 'BAD_WORKSPACE' })
  }
  // 数据目录可能通过符号链接/交汇点指向工作区内部。先把真实路径收敛，再做
  // 范围比较与排除，否则影子仓库会把自己也拍进快照。
  const canonicalDataDir = await canonicalPath(dataDir)

  let workTree = workspacePath
  const found = await git.run(['rev-parse', '--show-toplevel'], {
    cwd: workspacePath,
    signal: undefined,
    timeoutMs: 10_000,
    maxBytes: 64 * 1024,
  })
  if (found.exitCode === 0) {
    const root = found.stdout.trim().replace(/\r?\n$/, '')
    if (root !== '') {
      const canonicalRoot = await canonicalPath(root)
      if (isInside(canonicalRoot, workspacePath)) workTree = canonicalRoot
    }
  } else if (!/not a git repository/i.test(found.stderr)) {
    expectOk(found, 'git rev-parse')
  }

  let prefix = toPosix(relative(workTree, workspacePath))
  if (prefix === '.') prefix = ''
  if (prefix.startsWith('..')) {
    workTree = workspacePath
    prefix = ''
  }
  // 数据目录与快照根完全重合时无法只排除“插件自己的文件”而不误伤用户文件；
  // 这种情况会让每轮快照都包含临时 index 和元数据，必须显式拒绝。
  const samePath = (left, right) =>
    process.platform === 'win32' || process.platform === 'darwin'
      ? left.toLowerCase() === right.toLowerCase()
      : left === right
  if (samePath(canonicalDataDir, workTree)) {
    throw new GitError(
      `数据目录不能与会话快照根相同（${workTree}）。请把 DSH_TIME_MACHINE_DATA_DIR 指向独立目录，或使用默认的 $DSH_HOME/.dsh-time-machine。`,
      { code: 'BAD_DATA_DIR' },
    )
  }
  // 快照范围（workTree + prefix）是时间线的一部分：如果工作区后来被
  // git init、移动或变成另一个仓库的子目录，旧路径语义不再成立。用新的 key
  // 开一条新时间线，旧数据保留但不复用，避免错误恢复。
  const key = workspaceKey(`${workspacePath}\u0000${workTree}\u0000${prefix}`)
  const repoDir = join(canonicalDataDir, 'repos', key)
  const shadowDir = join(repoDir, 'repo')
  const binding = {
    workspacePath,
    workTree,
    prefix,
    // 前缀可能含 *、?、[ 等 Git pathspec 通配字符；会话目录叫 star* 时，
    // 普通 pathspec 会把兄弟目录 starA 也拍进来。:(literal) 强制按字面路径匹配。
    scopePathspec: prefix === '' ? '.' : `:(literal)${prefix}`,
    workspaceKey: key,
    dataDir: canonicalDataDir,
    repoDir,
    shadowDir,
    gitDir: join(shadowDir, '.git'),
    emptyConfig: join(repoDir, 'empty.gitconfig'),
    metadataFile: join(canonicalDataDir, 'workspaces', `${key}.json`),
    journalDir: join(repoDir, 'journals'),
    tmpDir: join(repoDir, 'tmp'),
    bindingFile: join(repoDir, 'binding.json'),
  }
  return binding
}

export async function ensureShadowRepo(binding, { git, excludes, signal }) {
  await ensureDir(binding.repoDir)
  await ensureDir(binding.tmpDir)
  await ensureDir(binding.journalDir)
  if (!(await exists(binding.emptyConfig))) await writeFile(binding.emptyConfig, '', 'utf8')
  const hadRepo = await exists(binding.gitDir)
  if (!hadRepo) {
    await ensureDir(binding.shadowDir)
    const init = await git.run(['init', '--quiet', '--', binding.shadowDir], {
      cwd: binding.repoDir,
      signal,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    })
    expectOk(init, '初始化时光机仓库')
    for (const [key, value] of [
      ['core.autocrlf', 'false'],
      ['core.safecrlf', 'false'],
      ['core.quotepath', 'false'],
      ['core.fsmonitor', 'false'],
      ['core.untrackedCache', 'false'],
      ['core.logAllRefUpdates', 'false'],
      ['gc.auto', '0'],
      ['commit.gpgsign', 'false'],
      ['tag.gpgsign', 'false'],
      ['core.hooksPath', join(binding.shadowDir, '.hooks-disabled')],
    ]) {
      const set = await git.run(['config', key, value], { cwd: binding.shadowDir, signal, timeoutMs: 10_000 })
      expectOk(set, `配置时光机仓库 ${key}`)
    }
  }
  // 不只在首次 init 时写：属性文件被误删/清空后，下一次快照仍必须禁用
  // 工作区 .gitattributes 的 ident/filter/encoding 改写。
  await ensureDir(join(binding.gitDir, 'info'))
  await writeFile(join(binding.gitDir, 'info', 'attributes'), SHADOW_ATTRIBUTES, 'utf8')
  await writeExcludes(binding, excludes)
  await writeFile(
    binding.bindingFile,
    `${JSON.stringify({
      version: 1,
      workspacePath: binding.workspacePath,
      workTree: binding.workTree,
      prefix: binding.prefix,
      createdAt: hadRepo ? undefined : nowIso(),
      seenAt: nowIso(),
    }, null, 2)}\n`,
    'utf8',
  )
}

/**
 * 把任意路径写成 gitignore 的字面模式。以 `/` 开头可以避免目录名以 `!`
 * 或 `#` 开头时被解释成否定/注释；通配字符需要转义，否则数据目录 `[x]`
 * 只能匹配到名为 `x` 的目录，影子仓库仍会拍到自己。
 */
function literalIgnoreDirectory(relativePath) {
  const escaped = relativePath.replace(/\\/g, '\\\\').replace(/([*?[\]])/g, '\\$1')
  return `/${escaped}/`
}

/**
 * 写影子仓库的 info/exclude。
 *
 * 强制排除项必须排在用户规则之后：gitignore 的“后匹配者胜”，这样即使用户
 * 写了 `!` 否定规则，也无法把 `.git/` 或插件数据目录重新纳入快照。数据目录
 * 位于工作区内时（DSH_TIME_MACHINE_DATA_DIR 被指到工作区），还要按真实相对
 * 路径排除它，否则影子仓库会快照自己，形成每轮都变化的自我引用。
 */
export async function writeExcludes(binding, excludes) {
  const cleanPattern = (pattern) => String(pattern).replace(/[\r\n\u0000]/g, '').trim()
  const mandatory = []
  if (isInside(binding.workTree, binding.dataDir)) {
    const relativeData = toPosix(relative(binding.workTree, binding.dataDir)).replace(/\/+$/, '')
    if (relativeData !== '') mandatory.push(literalIgnoreDirectory(relativeData))
  }
  mandatory.push('.git/', '.dsh-time-machine/')
  const patterns = []
  for (const pattern of excludes ?? []) {
    const line = cleanPattern(pattern)
    if (line === '' || mandatory.includes(line) || patterns.includes(line)) continue
    patterns.push(line)
  }
  for (const line of mandatory) {
    if (!patterns.includes(line)) patterns.push(line)
  }
  const file = join(binding.gitDir, 'info', 'exclude')
  await ensureDir(join(binding.gitDir, 'info'))
  const temp = `${file}.tmp-${process.pid}`
  try {
    await writeFile(temp, `${patterns.join('\n')}\n`, 'utf8')
    await rename(temp, file).catch(async (error) => {
      if (error?.code !== 'EPERM' && error?.code !== 'EEXIST') throw error
      await rm(file, { force: true })
      await rename(temp, file)
    })
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

async function seedIndex(binding, tempIndex) {
  try {
    await copyFile(join(binding.gitDir, 'index'), tempIndex)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

/**
 * 把工作区当前内容写成 Git tree。持久 index 只作为 stat 缓存：每次操作复制
 * 一份临时 index，成功后才替换；失败的快照不会污染下一次。
 */
export async function snapshotTree(binding, { git, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  await ensureDir(binding.tmpDir)
  const tempIndex = join(binding.tmpDir, `index-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const env = {
    ...baseEnvFor(binding),
    GIT_INDEX_FILE: tempIndex,
  }
  const warnings = []
  const cleanupIndex = async () => {
    await rm(tempIndex, { force: true }).catch(() => {})
    await rm(`${tempIndex}.lock`, { force: true }).catch(() => {})
  }
  const attempt = async (seed) => {
    if (seed) await seedIndex(binding, tempIndex)
    else await cleanupIndex()
    const add = await git.run(
      ['add', '--all', '--ignore-errors', '--', binding.scopePathspec],
      {
        cwd: binding.workTree,
        env,
        signal,
        timeoutMs,
        maxBytes: 8 * 1024 * 1024,
      },
    )
    if (add.exitCode !== 0 && add.exitCode !== 1) {
      throw new GitError(`快照 git add 失败：${add.stderr.trim() || `exit ${String(add.exitCode)}`}`, {
        code: /index.f(ile|ile) (is )?corrupt|index file smaller/i.test(add.stderr) ? 'GIT_INDEX_CORRUPT' : 'SNAPSHOT_FAILED',
        exitCode: add.exitCode,
        stderr: add.stderr,
      })
    }
    if (add.exitCode === 1) warnings.push('部分文件不可读，已跳过')
    if (/adding embedded git repository/i.test(add.stderr)) warnings.push('嵌套仓库按 gitlink 记录，内部内容不纳入快照')
    // 持久 index 是 stat 缓存，会保留上一轮已跟踪的条目。若本轮新增了 exclude
    // 或 .gitignore（或数据目录被放进工作区），git add 不会自动移除“以前跟踪、
    // 现在被忽略”的条目，write-tree 仍会把它们写进快照。先删掉这些缓存条目，
    // 才能保证“忽略的文件不被记录、也不会在恢复时被改写”。
    const ignored = await git.run(
      ['ls-files', '-z', '-ci', '--exclude-standard', '--', binding.scopePathspec],
      {
        cwd: binding.workTree,
        env,
        signal,
        timeoutMs,
        maxBytes: 16 * 1024 * 1024,
      },
    )
    expectOk(ignored, '读取忽略文件索引')
    if (ignored.stdout !== '') {
      const removed = await git.run(['update-index', '-z', '--force-remove', '--stdin'], {
        cwd: binding.workTree,
        env,
        signal,
        timeoutMs,
        stdin: ignored.stdout,
        maxBytes: 1024 * 1024,
      })
      expectOk(removed, '从快照索引移除忽略文件')
    }
    const written = await git.run(['write-tree'], {
      cwd: binding.workTree,
      env,
      signal,
      timeoutMs,
      maxBytes: 1024 * 1024,
    })
    expectOk(written, '快照 write-tree')
    return written.stdout.trim()
  }

  let tree
  try {
    tree = await attempt(true)
  } catch (error) {
    if (error?.code !== 'GIT_INDEX_CORRUPT') {
      await cleanupIndex()
      throw error
    }
    warnings.push('快照索引损坏，已重建索引')
    try {
      tree = await attempt(false)
    } catch (retryError) {
      await cleanupIndex()
      throw retryError
    }
  }
  try {
    await rm(join(binding.gitDir, 'index'), { force: true })
    await rename(tempIndex, join(binding.gitDir, 'index'))
  } catch {
    await cleanupIndex()
  }
  return { tree, warnings }
}

export async function commitTree(binding, { git, tree, message, date = new Date(), signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const iso = date.toISOString()
  const result = await git.run(['commit-tree', tree, '-m', message], {
    cwd: binding.workTree,
    env: {
      ...baseEnvFor(binding),
      GIT_AUTHOR_NAME: 'DSH Time Machine',
      GIT_AUTHOR_EMAIL: 'time-machine@dsh.local',
      GIT_COMMITTER_NAME: 'DSH Time Machine',
      GIT_COMMITTER_EMAIL: 'time-machine@dsh.local',
      GIT_AUTHOR_DATE: iso,
      GIT_COMMITTER_DATE: iso,
    },
    signal,
    timeoutMs,
    maxBytes: 1024 * 1024,
  })
  expectOk(result, '创建快照提交')
  return result.stdout.trim()
}

export async function updateRef(binding, { git, ref, commit, signal }) {
  const result = await git.run(['update-ref', ref, commit], {
    cwd: binding.workTree,
    env: baseEnvFor(binding),
    signal,
    timeoutMs: 10_000,
    maxBytes: 4096,
  })
  expectOk(result, `写入引用 ${ref}`)
}

export async function deleteRef(binding, { git, ref, signal }) {
  const result = await git.run(['update-ref', '-d', ref], {
    cwd: binding.workTree,
    env: baseEnvFor(binding),
    signal,
    timeoutMs: 10_000,
    maxBytes: 4096,
  })
  if (result.exitCode !== 0 && !/unable to resolve|not a valid ref|reference does not exist/i.test(result.stderr)) {
    throw new GitError(`删除引用 ${ref} 失败：${result.stderr.trim()}`, { exitCode: result.exitCode, stderr: result.stderr })
  }
}

/**
 * 列出某个命名空间下的引用。仅用于启动时清理已经失效的 plan 引用；
 * 调用方必须只传内部构造的前缀。
 */
export async function listRefs(binding, { git, prefix, signal }) {
  const result = await git.run(['for-each-ref', '--format=%(refname)', prefix], {
    cwd: binding.workTree,
    env: baseEnvFor(binding),
    signal,
    timeoutMs: 15_000,
    maxBytes: 4 * 1024 * 1024,
  })
  expectOk(result, '列出时光机引用')
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

export async function resolveRef(binding, { git, ref, signal }) {
  const result = await git.run(['rev-parse', '--verify', '--quiet', ref], {
    cwd: binding.workTree,
    env: baseEnvFor(binding),
    signal,
    timeoutMs: 10_000,
    maxBytes: 4096,
  })
  if (result.exitCode !== 0) return undefined
  return result.stdout.trim() || undefined
}

export async function verifyCommit(binding, { git, commit, signal }) {
  const result = await git.run(['cat-file', '-e', `${commit}^{commit}`], {
    cwd: binding.workTree,
    env: baseEnvFor(binding),
    signal,
    timeoutMs: 10_000,
    maxBytes: 4096,
  })
  return result.exitCode === 0
}

/**
 * 读取 tree/commit 下的全部文件条目。路径是 Git 相对仓库根的路径。
 * @returns Map<path, {mode, type, oid, size}>
 */
export async function treeEntries(binding, { git, commit, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const result = await git.run(['ls-tree', '-r', '-z', '-l', commit], {
    cwd: binding.workTree,
    env: baseEnvFor(binding),
    signal,
    timeoutMs,
    maxBytes: 64 * 1024 * 1024,
  })
  expectOk(result, '读取快照目录')
  const entries = new Map()
  for (const record of result.stdout.split('\0')) {
    if (record === '') continue
    const match = /^(\d{6}) (\w+) ([0-9a-f]+) +(\d+|-)\t(.*)$/s.exec(record)
    if (match === null) continue
    entries.set(match[5], {
      mode: match[1],
      type: match[2],
      oid: match[3],
      size: match[4] === '-' ? null : Number(match[4]),
    })
  }
  return entries
}

export async function diffNameStatus(binding, { git, from, to, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const result = await git.run(['diff-tree', '-r', '-z', '--no-commit-id', '--no-renames', '--name-status', from, to], {
    cwd: binding.workTree,
    env: baseEnvFor(binding),
    signal,
    timeoutMs,
    maxBytes: 16 * 1024 * 1024,
  })
  expectOk(result, '比较快照')
  const parts = result.stdout.split('\0')
  const entries = []
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const status = parts[index]?.trim()
    const path = parts[index + 1]
    if (status === '' || status === undefined || path === undefined || path === '') continue
    entries.push({ status: status[0], path })
  }
  return entries
}

export async function diffNumstat(binding, { git, from, to, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const result = await git.run(['diff-tree', '-r', '-z', '--no-commit-id', '--no-renames', '--numstat', from, to], {
    cwd: binding.workTree,
    env: baseEnvFor(binding),
    signal,
    timeoutMs,
    maxBytes: 16 * 1024 * 1024,
  })
  expectOk(result, '统计快照差异')
  const entries = new Map()
  for (const record of result.stdout.split('\0')) {
    if (record === '') continue
    const first = record.indexOf('\t')
    const second = first < 0 ? -1 : record.indexOf('\t', first + 1)
    if (second < 0) continue
    const added = record.slice(0, first)
    const deleted = record.slice(first + 1, second)
    const path = record.slice(second + 1)
    const binary = added === '-' || deleted === '-'
    entries.set(path, {
      added: binary ? 0 : Number(added) || 0,
      deleted: binary ? 0 : Number(deleted) || 0,
      binary,
    })
  }
  return entries
}

/**
 * 返回当前 exclude/.gitignore 规则命中的路径集合。恢复计划必须用它过滤，
 * 否则还原一个“排除规则生效之前”的旧快照时，会把已经排除的文件重新写回工作区。
 * `--no-index` 让已缓存的路径也按工作区规则判断。
 */
export async function ignoredPaths(binding, { git, paths, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!Array.isArray(paths) || paths.length === 0) return new Set()
  const result = await git.run(['check-ignore', '--no-index', '-z', '--stdin'], {
    cwd: binding.workTree,
    env: baseEnvFor(binding),
    signal,
    timeoutMs,
    stdin: `${paths.join('\0')}\0`,
    maxBytes: 16 * 1024 * 1024,
  })
  // 0 = 至少一个命中，1 = 一个都没有；>=2 才是真正的错误。
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new GitError(`检查忽略规则失败：${result.stderr.trim() || `exit ${String(result.exitCode)}`}`, {
      exitCode: result.exitCode,
      stderr: result.stderr,
      args: result.args,
    })
  }
  return new Set(result.stdout.split('\0').filter((path) => path !== ''))
}

export async function readBlob(binding, { git, oid, maxBytes, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const result = await git.runBuffer(['cat-file', 'blob', oid], {
    cwd: binding.workTree,
    env: baseEnvFor(binding),
    signal,
    timeoutMs,
    maxBytes,
  })
  return result.buffer
}

export async function repoStats(binding, { git, signal }) {
  try {
    const info = await stat(binding.shadowDir)
    if (!info.isDirectory()) return { bytes: null, objects: null }
  } catch {
    return { bytes: null, objects: null }
  }
  const result = await git.run(['count-objects', '-v'], {
    cwd: binding.shadowDir,
    env: baseEnvFor(binding),
    signal,
    timeoutMs: 20_000,
    maxBytes: 1024 * 1024,
  })
  if (result.exitCode !== 0) return { bytes: null, objects: null }
  const values = {}
  for (const line of result.stdout.split('\n')) {
    const [key, value] = line.split(':')
    if (key !== undefined && value !== undefined) values[key.trim()] = value.trim()
  }
  const loose = Number(values.size ?? 0)
  const packed = Number(values['size-pack'] ?? 0)
  const bytes = Number.isFinite(loose + packed) ? (loose + packed) * 1024 : null
  const objects = Number(values.count ?? 0) + Number(values['in-pack'] ?? 0)
  return { bytes, objects: Number.isFinite(objects) ? objects : null }
}

export async function runGc(binding, { git, signal, timeoutMs = 120_000 }) {
  try {
    const info = await stat(binding.shadowDir)
    if (!info.isDirectory()) return false
  } catch {
    return false
  }
  const result = await git.run(['gc', '--prune=now', '--quiet'], {
    cwd: binding.shadowDir,
    env: baseEnvFor(binding),
    signal,
    timeoutMs,
    maxBytes: 4 * 1024 * 1024,
  })
  return result.exitCode === 0
}

export async function readBlobFile(path, maxBytes) {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (info.size > maxBytes) throw new GitError(`文件超过 ${maxBytes} 字节`, { code: 'FILE_TOO_LARGE' })
    const buffer = Buffer.alloc(info.size)
    let offset = 0
    while (offset < info.size) {
      const { bytesRead } = await handle.read(buffer, offset, info.size - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return buffer.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

export async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function readTextFile(path) {
  return readFile(path, 'utf8')
}

export { TERMINATE_GRACE_MS }
