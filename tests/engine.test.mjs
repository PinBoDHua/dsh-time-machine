import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { GitRunner } from '../lib/git.js'
import { createBinding } from '../lib/git.js'
import { ConfigStore, normalizeConfig } from '../lib/config.js'
import { TimeMachineEngine } from '../lib/engine.js'
import { snapshotTree, ensureShadowRepo } from '../lib/git.js'
import { insidePath } from '../lib/util.js'

const quietLogger = { info() {}, warn() {}, debug() {} }

async function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const hasGit = await gitAvailable()
const testWithGit = (name, fn) => test(name, { skip: hasGit ? false : 'git is unavailable' }, fn)

async function world(t, { repo = false, subdir = false, files = {}, gitignore = 'ignored/\n*.log\n' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tm-test-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const project = join(root, repo ? 'repo' : 'ws')
  const cwd = subdir ? join(project, 'packages', 'app') : project
  await mkdir(join(cwd, 'sub'), { recursive: true })
  if (gitignore !== null) await writeFile(join(project, '.gitignore'), gitignore)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(cwd, path, '..'), { recursive: true })
    await writeFile(join(cwd, path), content)
  }
  if (repo) {
    execFileSync('git', ['-c', 'core.autocrlf=false', 'init', '-q'], { cwd: project })
    execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '-A'], { cwd: project })
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init'],
      { cwd: project },
    )
  }
  const data = join(root, 'data')
  await mkdir(data, { recursive: true })
  const logger = quietLogger
  const configStore = new ConfigStore({ dataDir: data, logger })
  await configStore.load()
  const git = new GitRunner()
  const binding = await createBinding({ cwd, dataDir: data, git })
  const engine = new TimeMachineEngine({ binding, configStore, git, logger, version: '0.1.0' })
  await engine.init()
  t.after(async () => {
    await engine.dispose()
  })
  return { root, project, cwd, data, binding, engine, configStore, git, logger }
}

testWithGit('初始快照、覆盖恢复：CRLF 与忽略文件不被改写', async (t) => {
  const w = await world(t, {
    files: { 'a.txt': 'hello\n', 'sub/b.txt': 'b\n', 'crlf.txt': 'one\r\ntwo\r\n' },
  })
  await mkdir(join(w.cwd, 'ignored'), { recursive: true })
  await writeFile(join(w.cwd, 'ignored', 'x.txt'), 'x\n')
  await writeFile(join(w.cwd, 'debug.log'), 'log1\n')
  const first = await w.engine.manualSnapshot('s1', 'initial')
  assert.equal(first.checkpoint.kind, 'manual')
  assert.equal(first.checkpoint.stats.initial, true)

  await writeFile(join(w.cwd, 'a.txt'), 'changed\n')
  await writeFile(join(w.cwd, 'new.txt'), 'new\n')
  await rm(join(w.cwd, 'sub', 'b.txt'))
  await writeFile(join(w.cwd, 'debug.log'), 'log2\n')
  await writeFile(join(w.cwd, 'crlf.txt'), 'one\r\ntwo changed\r\n')
  const second = await w.engine.manualSnapshot('s1', 'changed')
  assert.equal(second.checkpoint.stats.files, 4)

  const plan = await w.engine.planRestore({ sessionId: 's1', checkpointId: first.checkpoint.id, mode: 'overwrite' })
  assert.equal(plan.deletes, 0)
  assert.ok(plan.sample.every((item) => !item.path.includes('\\')))

  const result = await w.engine.applyRestore({ sessionId: 's1', planId: plan.planId, confirm: 'RESTORE' })
  assert.equal(result.restored, true)
  assert.equal(await readFile(join(w.cwd, 'a.txt'), 'utf8'), 'hello\n')
  assert.equal(await readFile(join(w.cwd, 'sub', 'b.txt'), 'utf8'), 'b\n')
  assert.equal(await readFile(join(w.cwd, 'debug.log'), 'utf8'), 'log2\n')
  assert.equal(await readFile(join(w.cwd, 'crlf.txt'), 'utf8'), 'one\r\ntwo\r\n')
  assert.equal(await stat(join(w.cwd, 'new.txt')).then(() => true, () => false), true)
  assert.ok(result.safetyId)
  assert.ok(result.checkpointId)
  const status = await w.engine.status('s1')
  assert.equal(status.checkpoints.find((entry) => entry.id === result.safetyId).kind, 'safety')
  assert.equal(status.checkpoints.find((entry) => entry.id === result.checkpointId).kind, 'restore')
})

testWithGit('精确恢复：删除恢复后新增的文件，恢复被删除的文件，忽略文件不动', async (t) => {
  const w = await world(t, {
    files: { 'a.txt': 'a\n', 'sub/b.txt': 'b\n' },
  })
  await writeFile(join(w.cwd, 'debug.log'), 'log\n')
  const first = await w.engine.manualSnapshot('s', 'initial')
  await writeFile(join(w.cwd, 'new.txt'), 'new\n')
  await rm(join(w.cwd, 'sub', 'b.txt'))
  await writeFile(join(w.cwd, 'a.txt'), 'a2\n')
  await w.engine.manualSnapshot('s', 'changed')
  const plan = await w.engine.planRestore({ sessionId: 's', checkpointId: first.checkpoint.id, mode: 'exact' })
  assert.equal(plan.writes, 2)
  assert.equal(plan.deletes, 1)
  const result = await w.engine.applyRestore({ sessionId: 's', planId: plan.planId, confirm: 'RESTORE' })
  assert.equal(result.mode, 'exact')
  assert.equal(await readFile(join(w.cwd, 'a.txt'), 'utf8'), 'a\n')
  assert.equal(await readFile(join(w.cwd, 'sub', 'b.txt'), 'utf8'), 'b\n')
  assert.equal(await stat(join(w.cwd, 'new.txt')).then(() => true, () => false), false)
  assert.equal(await readFile(join(w.cwd, 'debug.log'), 'utf8'), 'log\n')
})

testWithGit('子目录工作区只快照子树，且不改动用户仓库', async (t) => {
  const w = await world(t, {
    repo: true,
    subdir: true,
    files: { 'src/index.js': 'one\n' },
    gitignore: 'node_modules/\n*.tmp\n',
  })
  await writeFile(join(w.project, 'root.txt'), 'root\n')
  await writeFile(join(w.cwd, 'scratch.tmp'), 'tmp\n')
  const indexPath = join(w.project, '.git', 'index')
  const indexBefore = await readFile(indexPath)
  const headBefore = await readFile(join(w.project, '.git', 'HEAD'), 'utf8')
  const first = await w.engine.manualSnapshot('s', 'init')
  await writeFile(join(w.cwd, 'src', 'index.js'), 'two\n')
  await writeFile(join(w.cwd, 'new.txt'), 'new\n')
  await writeFile(join(w.project, 'root.txt'), 'root changed\n')
  await writeFile(join(w.cwd, 'more.tmp'), 'tmp2\n')
  await w.engine.manualSnapshot('s', 'changed')
  const plan = await w.engine.planRestore({ sessionId: 's', checkpointId: first.checkpoint.id, mode: 'exact' })
  assert.ok(plan.sample.every((item) => !item.path.startsWith('packages/app/')))
  assert.ok(plan.sample.some((item) => item.path === 'src/index.js'))
  await w.engine.applyRestore({ sessionId: 's', planId: plan.planId, confirm: 'RESTORE' })
  assert.equal(await readFile(join(w.cwd, 'src', 'index.js'), 'utf8'), 'one\n')
  assert.equal(await stat(join(w.cwd, 'new.txt')).then(() => true, () => false), false)
  assert.equal(await readFile(join(w.project, 'root.txt'), 'utf8'), 'root changed\n')
  assert.equal(await readFile(join(w.cwd, 'more.tmp'), 'utf8'), 'tmp2\n')
  await w.engine.dispose()
  assert.deepEqual(await readFile(indexPath), indexBefore)
  assert.equal(await readFile(join(w.project, '.git', 'HEAD'), 'utf8'), headBefore)
})

testWithGit('预览后工作区变化会拒绝恢复并丢弃计划', async (t) => {
  const w = await world(t, { files: { 'a.txt': 'one\n' } })
  const first = await w.engine.manualSnapshot('s', 'first')
  await writeFile(join(w.cwd, 'a.txt'), 'two\n')
  await w.engine.manualSnapshot('s', 'second')
  const plan = await w.engine.planRestore({ sessionId: 's', checkpointId: first.checkpoint.id, mode: 'overwrite' })
  await writeFile(join(w.cwd, 'a.txt'), 'three\n')
  await assert.rejects(
    () => w.engine.applyRestore({ sessionId: 's', planId: plan.planId, confirm: 'RESTORE' }),
    (error) => error.code === 'WORKSPACE_CHANGED',
  )
  assert.equal(w.engine.plans.has(plan.planId), false)
  assert.equal(await readFile(join(w.cwd, 'a.txt'), 'utf8'), 'three\n')
})

class FailingBlobGit extends GitRunner {
  constructor({ failAt, failFrom }) {
    super()
    this.blobCalls = 0
    this.failAt = failAt
    this.failFrom = failFrom
  }

  async runBuffer(args, options) {
    if (args[0] === 'cat-file' && args[1] === 'blob') {
      this.blobCalls += 1
      if (this.blobCalls === this.failAt || (this.failFrom !== undefined && this.blobCalls >= this.failFrom)) {
        throw new Error('injected blob read failure')
      }
    }
    return super.runBuffer(args, options)
  }
}

async function failingWorld(t, failure = { failFrom: 2 }) {
  const w = await world(t, { files: { 'a.txt': 'one\n', 'b.txt': 'one\n', 'c.txt': 'one\n' } })
  const git = new FailingBlobGit(failure)
  const engine = new TimeMachineEngine({
    binding: w.binding,
    configStore: w.configStore,
    git,
    logger: quietLogger,
    version: '0.1.0',
  })
  await engine.init()
  t.after(async () => {
    await engine.dispose()
  })
  return { ...w, engine }
}

testWithGit('恢复中途失败会自动回滚到安全点并删除恢复日志', async (t) => {
  const w = await failingWorld(t, { failAt: 2 })
  const first = await w.engine.manualSnapshot('s', 'first')
  await writeFile(join(w.cwd, 'a.txt'), 'two\n')
  await writeFile(join(w.cwd, 'b.txt'), 'two\n')
  await writeFile(join(w.cwd, 'c.txt'), 'two\n')
  await w.engine.manualSnapshot('s', 'second')
  const before = {
    a: await readFile(join(w.cwd, 'a.txt'), 'utf8'),
    b: await readFile(join(w.cwd, 'b.txt'), 'utf8'),
    c: await readFile(join(w.cwd, 'c.txt'), 'utf8'),
  }
  const plan = await w.engine.planRestore({ sessionId: 's', checkpointId: first.checkpoint.id, mode: 'overwrite' })
  await assert.rejects(
    () => w.engine.applyRestore({ sessionId: 's', planId: plan.planId, confirm: 'RESTORE' }),
    (error) => error.code === 'RESTORE_ROLLED_BACK' && error.details?.rolledBack === true,
  )
  assert.equal(await readFile(join(w.cwd, 'a.txt'), 'utf8'), before.a)
  assert.equal(await readFile(join(w.cwd, 'b.txt'), 'utf8'), before.b)
  assert.equal(await readFile(join(w.cwd, 'c.txt'), 'utf8'), before.c)
  assert.deepEqual(await w.engine.listJournals(), [])
})

testWithGit('回滚失败会保留恢复日志，可用新引擎 recover', async (t) => {
  const w = await failingWorld(t, { failFrom: 2 })
  const first = await w.engine.manualSnapshot('s', 'first')
  await writeFile(join(w.cwd, 'a.txt'), 'two\n')
  await writeFile(join(w.cwd, 'b.txt'), 'two\n')
  await writeFile(join(w.cwd, 'c.txt'), 'two\n')
  await w.engine.manualSnapshot('s', 'second')
  const before = await readFile(join(w.cwd, 'a.txt'), 'utf8')
  const plan = await w.engine.planRestore({ sessionId: 's', checkpointId: first.checkpoint.id, mode: 'overwrite' })
  // 第二次 blob 读取失败，回滚里的读取也全部失败。
  await assert.rejects(
    () => w.engine.applyRestore({ sessionId: 's', planId: plan.planId, confirm: 'RESTORE' }),
    (error) => error.code === 'ROLLBACK_FAILED' && Boolean(error.details?.safetyId),
  )
  const journals = await w.engine.listJournals()
  assert.equal(journals.length, 1)
  assert.equal(journals[0].planId, plan.planId)

  // 新引擎用正常 Git 运行器读取同一份数据，按日志回到安全点。
  const engine = new TimeMachineEngine({
    binding: w.binding,
    configStore: w.configStore,
    git: new GitRunner(),
    logger: quietLogger,
    version: '0.1.0',
  })
  await engine.init()
  t.after(async () => {
    await engine.dispose()
  })
  const recovered = await engine.recoverJournal(plan.planId)
  assert.equal(recovered.recovered, true)
  assert.equal(await readFile(join(w.cwd, 'a.txt'), 'utf8'), before)
  assert.deepEqual(await engine.listJournals(), [])
})

testWithGit('工具恢复可在自己的轮次中进行，但其他会话运行时会拒绝', async (t) => {
  const w = await world(t, { files: { 'a.txt': 'one\n' } })
  const first = await w.engine.manualSnapshot('s', 'first')
  await writeFile(join(w.cwd, 'a.txt'), 'two\n')
  await w.engine.manualSnapshot('s', 'second')
  await w.engine.startTurn('s', 1)
  await w.engine.startTurn('other', 1)
  await assert.rejects(
    () => w.engine.planRestore({ sessionId: 's', checkpointId: first.checkpoint.id, mode: 'overwrite', allowActiveSession: true }),
    (error) => error.code === 'SESSION_BUSY',
  )
  await w.engine.stopping('other', 1)
  w.engine.endTurn('other', 1)
  await new Promise((resolve) => setTimeout(resolve, 100))
  const result = await w.engine.restoreNow({
    sessionId: 's',
    checkpointId: first.checkpoint.id,
    mode: 'overwrite',
    allowActiveSession: true,
  })
  assert.equal(result.restored, true)
  assert.equal(await readFile(join(w.cwd, 'a.txt'), 'utf8'), 'one\n')
  await w.engine.stopping('s', 1)
  w.engine.endTurn('s', 1)
})

testWithGit('保留策略删除旧还原点引用', async (t) => {
  const w = await world(t, { files: { 'a.txt': '0\n' } })
  await w.configStore.update({ maxCheckpoints: 10, maxAgeDays: 365 })
  for (let index = 0; index < 12; index += 1) {
    await writeFile(join(w.cwd, 'a.txt'), `${index}\n`)
    await w.engine.manualSnapshot('s', `s${index}`)
  }
  const status = await w.engine.status('s')
  assert.equal(status.total, 10)
  const refs = execFileSync('git', ['--git-dir', w.binding.gitDir, 'for-each-ref', '--format=%(refname)', 'refs/time-machine/checkpoints'], {
    cwd: w.binding.shadowDir,
    encoding: 'utf8',
  }).trim().split('\n').filter(Boolean)
  assert.equal(refs.length, 10)
})

test('路径安全：拒绝逃逸、绝对路径与 .git', () => {
  assert.throws(() => insidePath('C:\\ws', '../x'), /unsafe path/)
  assert.throws(() => insidePath('C:\\ws', 'C:/x'), /absolute path/)
  assert.throws(() => insidePath('C:\\ws', '.git/config'), /\.git/)
  assert.equal(insidePath('C:\\ws', 'a/b.txt'), 'C:\\ws\\a\\b.txt')
})

test('配置归一化：越界收敛、排除项清洗、非法类型保留默认', () => {
  const { config, issues } = normalizeConfig({
    auto: 'yes',
    maxCheckpoints: 5,
    maxAgeDays: 9999,
    timeoutMs: 1,
    excludes: ['.git/', 'node_modules/', 'node_modules/', 'bad\npattern', '# comment'],
  })
  assert.equal(config.auto, true)
  assert.equal(config.maxCheckpoints, 10)
  assert.equal(config.maxAgeDays, 365)
  assert.equal(config.timeoutMs, 5000)
  assert.deepEqual(config.excludes, ['.git/', 'node_modules/', 'badpattern'])
  assert.ok(issues.length >= 3)
})

testWithGit('大小写重命名在 Windows 上不会误删恢复后的文件', { skip: process.platform !== 'win32' }, async (t) => {
  const w = await world(t, { files: { 'foo.txt': 'old\n' } })
  const first = await w.engine.manualSnapshot('s', 'first')
  await rename(join(w.cwd, 'foo.txt'), join(w.cwd, 'Foo.txt'))
  await writeFile(join(w.cwd, 'Foo.txt'), 'new\n')
  await w.engine.manualSnapshot('s', 'second')
  const plan = await w.engine.planRestore({ sessionId: 's', checkpointId: first.checkpoint.id, mode: 'exact' })
  assert.equal(plan.deletes, 0)
  await w.engine.applyRestore({ sessionId: 's', planId: plan.planId, confirm: 'RESTORE' })
  assert.equal(await readFile(join(w.cwd, 'Foo.txt'), 'utf8'), 'old\n')
})

testWithGit('快照不写入用户仓库且会自动排除 node_modules', async (t) => {
  const w = await world(t, { repo: true, files: { 'a.txt': 'a\n' } })
  const userObjectsBefore = execFileSync('git', ['--git-dir', join(w.project, '.git'), 'count-objects', '-v'], {
    encoding: 'utf8',
  })
  await ensureShadowRepo(w.binding, { git: w.git, excludes: ['.git/', 'node_modules/'] })
  assert.ok(existsSync(w.binding.gitDir))
  await mkdir(join(w.cwd, 'node_modules', 'x'), { recursive: true })
  await writeFile(join(w.cwd, 'node_modules', 'x', 'index.js'), 'junk\n')
  const { tree } = await snapshotTree(w.binding, { git: w.git, timeoutMs: 30000 })
  const entries = execFileSync('git', ['--git-dir', w.binding.gitDir, 'ls-tree', '-r', '--name-only', tree], {
    encoding: 'utf8',
  }).trim().split('\n')
  assert.ok(entries.includes('a.txt'))
  assert.ok(!entries.some((path) => path.startsWith('node_modules/')))
  const userObjectsAfter = execFileSync('git', ['--git-dir', join(w.project, '.git'), 'count-objects', '-v'], {
    encoding: 'utf8',
  })
  assert.equal(userObjectsAfter, userObjectsBefore)
})
