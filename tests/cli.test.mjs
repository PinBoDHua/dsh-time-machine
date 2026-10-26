import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = join(ROOT, 'lib', 'bin.js')

function gitOk() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function run(args, env) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 120000,
  })
}

test('CLI：snapshot → list → 拒绝未确认恢复 → --yes 恢复', { skip: gitOk() ? false : 'git unavailable' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tm-cli-'))
  const ws = join(root, 'ws')
  const data = join(root, 'data')
  await mkdir(ws, { recursive: true })
  await mkdir(data, { recursive: true })
  await writeFile(join(ws, 'a.txt'), 'one\n')
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const env = { DSH_TIME_MACHINE_DATA_DIR: data }

  const first = run(['snapshot', '--workspace', ws, '--label', 'first'], env)
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, /已创建还原点/)

  await writeFile(join(ws, 'a.txt'), 'two\n')
  const second = run(['snapshot', '--workspace', ws, '--label', 'second'], env)
  assert.equal(second.status, 0, second.stderr)

  const listed = run(['list', '--workspace', ws], env)
  assert.equal(listed.status, 0, listed.stderr)
  assert.match(listed.stdout, /共 2 个还原点/)
  assert.match(listed.stdout, /first|second/)

  const badLimit = run(['list', '--workspace', ws, '--limit', 'not-a-number'], env)
  assert.equal(badLimit.status, 0, badLimit.stderr)
  assert.match(badLimit.stdout, /first|second/)

  const workspaceDir = join(data, 'workspaces')
  const metadataFile = (await readdir(workspaceDir)).find((file) => file.endsWith('.json'))
  assert.ok(metadataFile)
  const metadata = JSON.parse(await readFile(join(workspaceDir, metadataFile), 'utf8'))
  const oldest = metadata.checkpoints[metadata.checkpoints.length - 1]
  assert.equal(metadata.checkpoints.length, 2)

  const refused = run(['restore', '--workspace', ws, '--checkpoint', oldest.id, '--mode', 'overwrite'], env)
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /未执行/)
  assert.equal(await readFile(join(ws, 'a.txt'), 'utf8'), 'two\n')

  const restored = run(['restore', '--workspace', ws, '--checkpoint', oldest.id, '--mode', 'overwrite', '--yes'], env)
  assert.equal(restored.status, 0, restored.stderr)
  assert.match(restored.stdout, /已恢复/)
  assert.equal(await readFile(join(ws, 'a.txt'), 'utf8'), 'one\n')

  const status = run(['status'], env)
  assert.equal(status.status, 0, status.stderr)
  assert.match(status.stdout, /合计还原点：\d+/)

  const doctor = run(['doctor'], env)
  assert.equal(doctor.status, 0, doctor.stderr)
  assert.match(doctor.stdout, /还原点 [1-9]/)
  assert.ok(existsSync(join(data, 'repos')))
})
