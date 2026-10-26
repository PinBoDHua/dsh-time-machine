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
import { snapshotTree, ensureShadowRepo, treeEntries } from '../lib/git.js'
import { CheckpointStore } from '../lib/store.js'
import { insidePath, makeCheckpointId, nowIso } from '../lib/util.js'

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
  const engine = new TimeMachineEngine({ binding, configStore, git, logger, version: '0.2.0' })
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
    version: '0.2.0',
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
  // 先让面板轮询读一次空日志；回滚失败后 journal 不能被 listJournals 的 2 秒
  // 缓存遮住，否则面板会在最关键的时候显示“没有未完成的恢复日志”。
  await w.engine.status('s')
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
    version: '0.2.0',
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

testWithGit('自动 gc 按累计淘汰数触发，稳态下不会无限堆积对象', async (t) => {
  const w = await world(t, { files: { 'a.txt': '0\n' } })
  await w.configStore.update({ maxCheckpoints: 10, maxAgeDays: 365 })
  for (let index = 0; index < 20; index += 1) {
    await writeFile(join(w.cwd, 'a.txt'), `${index}\n`)
    await w.engine.manualSnapshot('s', `s${index}`)
  }
  // 第 20 个还原点淘汰了第 10 个旧引用，gc 已排进串行链；再排一个空任务等它完成。
  await w.engine.enqueue(async () => {})
  assert.equal(typeof w.engine.store.get().lastGcAt, 'string')
  const refs = execFileSync('git', ['--git-dir', w.binding.gitDir, 'for-each-ref', '--format=%(refname)', 'refs/time-machine/checkpoints'], {
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

testWithGit('数据目录位于工作区内时会自动排除，不会快照自己', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tm-self-'))
  const cwd = join(root, 'ws')
  const dataDir = join(cwd, '.tm-data')
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'a.txt'), 'one\n')
  const configStore = new ConfigStore({ dataDir, logger: quietLogger })
  await configStore.load()
  const git = new GitRunner()
  const binding = await createBinding({ cwd, dataDir, git })
  const engine = new TimeMachineEngine({ binding, configStore, git, logger: quietLogger, version: 'test' })
  await engine.init()
  t.after(async () => {
    await engine.dispose()
    await rm(root, { recursive: true, force: true })
  })

  const first = await engine.manualSnapshot('s', 'one')
  const record = engine.store.find(first.checkpoint.id)
  const entries = await treeEntries(binding, { git, commit: record.commit })
  assert.deepEqual([...entries.keys()], ['a.txt'])

  // 绑定文件每次快照都会刷新 seenAt；如果数据目录没被排除，这里会多出
  // .tm-data 下的文件并把“无变化”的轮次也记成新还原点。
  await writeFile(join(cwd, 'a.txt'), 'two\n')
  const second = await engine.checkpoint({ sessionId: 's', kind: 'auto', phase: 'after' })
  assert.equal(second.checkpoint.stats.files, 1)
})

testWithGit('还原点标签会截断到 80 字符并清除控制字符', async (t) => {
  const w = await world(t, { files: { 'a.txt': 'a\n' } })
  const label = `${'x'.repeat(70)}\n\t${'y'.repeat(50)}`
  const { checkpoint } = await w.engine.manualSnapshot('s', label)
  assert.equal(checkpoint.label.length, 80)
  assert.ok(!/[\u0000-\u001f\u007f]/u.test(checkpoint.label))
  assert.equal(w.engine.store.find(checkpoint.id).label, checkpoint.label)
})

testWithGit('排除规则始终保护 .git 与插件数据目录', async (t) => {
  const w = await world(t, { files: { 'a.txt': 'a\n' } })
  await mkdir(join(w.cwd, '.dsh-time-machine'), { recursive: true })
  await writeFile(join(w.cwd, '.dsh-time-machine', 'marker.txt'), 'marker\n')
  await w.configStore.update({ excludes: ['*', '!.dsh-time-machine/', '!a.txt'] })
  const { checkpoint } = await w.engine.manualSnapshot('s', 'excludes')
  const record = w.engine.store.find(checkpoint.id)
  const entries = await treeEntries(w.binding, { git: w.git, commit: record.commit })
  assert.deepEqual([...entries.keys()], ['a.txt'])
})

testWithGit('init 失败后下一次调用会重新加载，而不是永久 rejected', async (t) => {
  const w = await world(t, { files: { 'a.txt': 'a\n' } })
  const engine = new TimeMachineEngine({
    binding: w.binding,
    configStore: w.configStore,
    git: w.git,
    logger: quietLogger,
    version: 'test',
  })
  t.after(async () => {
    await engine.dispose()
  })
  const original = engine.store.load.bind(engine.store)
  let calls = 0
  engine.store.load = async () => {
    calls += 1
    if (calls === 1) throw new Error('transient metadata failure')
    return original()
  }
  await assert.rejects(() => engine.init(), /transient metadata failure/)
  await engine.init()
  assert.equal(calls, 2)
  assert.equal(engine.store.loaded, true)
})

test('元数据写盘失败时 append 回滚内存状态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tm-store-'))
  try {
    const binding = {
      workspacePath: root,
      workTree: root,
      prefix: '',
      dataDir: root,
      metadataFile: join(root, 'workspaces', 'key.json'),
    }
    const store = new CheckpointStore({ binding, logger: quietLogger })
    await store.load()
    store.save = async () => {
      throw new Error('disk full')
    }
    const checkpoint = {
      id: makeCheckpointId(),
      kind: 'manual',
      phase: 'after',
      sessionId: 's',
      createdAt: nowIso(),
      commit: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      stats: { files: 1, added: 0, deleted: 0 },
    }
    await assert.rejects(() => store.append(checkpoint), /disk full/)
    assert.deepEqual(store.list(), [])
    assert.equal(store.get().lastCheckpointId, undefined)
    assert.equal(store.get().lastTree, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
