/**
 * 时光机 —— 安全安装 / 卸载。
 *
 * 默认 dry-run，只打印计划；加 --apply 才写盘，写盘前把 profile 清单与
 * 已存在的插件副本备份到 $DSH_HOME/dsh-time-machine-backup-<时间戳>/，
 * 并生成 restore.ps1。宿主侧改动需要重启 DSH；客户端产物可 --sync-client。
 *
 * 用法：
 *   node scripts/install.mjs
 *   node scripts/install.mjs --apply
 *   node scripts/install.mjs --status
 *   node scripts/install.mjs --sync-client --apply
 *   node scripts/install.mjs --uninstall --apply
 *   node scripts/install.mjs --profile C:/Users/me/.dsh/profiles/desktop --apply
 */

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_NAME = 'dsh-time-machine'
const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const uninstall = argv.includes('--uninstall')
const syncClientOnly = argv.includes('--sync-client')
const showStatus = argv.includes('--status')
const profileArgIndex = argv.indexOf('--profile')
const profileArg = profileArgIndex >= 0 ? argv[profileArgIndex + 1] : undefined

function resolveProfileDir() {
  if (typeof profileArg === 'string' && existsSync(profileArg)) return resolve(profileArg)
  if (process.env.DSH_PROFILE_DIR && existsSync(process.env.DSH_PROFILE_DIR)) return resolve(process.env.DSH_PROFILE_DIR)
  const home = process.env.DSH_HOME
  if (home && existsSync(join(home, 'profiles', 'desktop'))) return join(home, 'profiles', 'desktop')
  const fallback = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'profiles', 'desktop')
  if (existsSync(fallback)) return fallback
  throw new Error('找不到 DSH profile 目录。请设置 DSH_PROFILE_DIR 或传 --profile <dir>。')
}

const profileDir = resolveProfileDir()
const manifestPath = join(profileDir, 'package.json')
const targetDir = join(profileDir, 'node_modules', PLUGIN_NAME)
const dshHome = process.env.DSH_HOME ?? dirname(dirname(profileDir))
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const backupDir = join(dshHome, `${PLUGIN_NAME}-backup-${stamp}`)
const localPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const clientBundle = join(ROOT, 'client', 'client.js')

const COPY_ITEMS = [
  'lib',
  'client',
  'shared',
  'src',
  'scripts',
  'docs',
  'cordis.patch.yml',
  'package.json',
  'icon.svg',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
]

const log = (message) => console.log(message)
const change = (message) => console.log(`  · ${message}`)

function readManifest() {
  try {
    // Windows 编辑器/PowerShell 5 可能给 JSON 加 UTF-8 BOM；JSON.parse 会拒绝。
    return JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new Error(`无法读取 profile package.json：${error.message}`)
  }
}

function writeManifest(value) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  const temp = `${manifestPath}.tmp-${process.pid}`
  writeFileSync(temp, text, 'utf8')
  try {
    // rename 覆盖写：中途崩溃时原清单仍然完整。Windows 上目标被占用时
    // rename 可能返回 EPERM/EACCES，退回“先删后改名”的兼容路径。
    try {
      renameSync(temp, manifestPath)
    } catch (error) {
      if (error?.code !== 'EPERM' && error?.code !== 'EACCES' && error?.code !== 'EEXIST') throw error
      rmSync(manifestPath, { force: true })
      renameSync(temp, manifestPath)
    }
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

function bundleList(manifest) {
  manifest.dsh ??= { profile: { bundles: [] } }
  manifest.dsh.profile ??= { bundles: [] }
  if (!Array.isArray(manifest.dsh.profile.bundles)) manifest.dsh.profile.bundles = []
  return manifest.dsh.profile.bundles
}

function installedVersion() {
  try {
    return JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf8')).version
  } catch {
    return undefined
  }
}

function printStatus() {
  const manifest = readManifest()
  const dependencies = manifest.dependencies ?? {}
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const installed = installedVersion()
  log(`本地         v${localPkg.version}（${ROOT}）`)
  log(`profile      ${profileDir}`)
  log(`已装副本     ${installed === undefined ? '未安装' : `v${installed}（${targetDir}）`}`)
  log(`依赖条目     ${typeof dependencies[PLUGIN_NAME] === 'string' ? dependencies[PLUGIN_NAME] : '缺失'}`)
  log(`bundle 顺序  ${bundles.includes(PLUGIN_NAME) ? '包含' : '缺失'}（${bundles.join(' → ')}）`)
  log(`客户端产物   ${existsSync(clientBundle) ? '存在' : '缺失（先运行 node scripts/build.mjs）'}`)
}

function planInstall() {
  const manifest = readManifest()
  const dependencies = manifest.dependencies ?? {}
  const bundles = bundleList(manifest)
  const spec = `file:${ROOT.replaceAll('\\', '/')}`
  const planned = []
  planned.push({ kind: 'copy', from: ROOT, to: targetDir })
  if (dependencies[PLUGIN_NAME] !== spec) planned.push({ kind: 'dependency', value: spec })
  if (!bundles.includes(PLUGIN_NAME)) planned.push({ kind: 'bundle', value: PLUGIN_NAME })
  return { manifest, planned }
}

function backup() {
  mkdirSync(backupDir, { recursive: true })
  if (existsSync(manifestPath)) cpSync(manifestPath, join(backupDir, 'package.json'))
  if (existsSync(targetDir)) cpSync(targetDir, join(backupDir, 'plugin'), { recursive: true })
  const ps = [
    `$ErrorActionPreference = 'Stop'`,
    `$backup = '${backupDir.replaceAll("'", "''")}'`,
    `$profile = '${profileDir.replaceAll("'", "''")}'`,
    `$target = '${targetDir.replaceAll("'", "''")}'`,
    `if (Test-Path (Join-Path $backup 'package.json')) { Copy-Item (Join-Path $backup 'package.json') (Join-Path $profile 'package.json') -Force }`,
    `if (Test-Path (Join-Path $backup 'plugin')) {`,
    `  if (Test-Path $target) { Remove-Item $target -Recurse -Force }`,
    `  New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null`,
    `  Copy-Item (Join-Path $backup 'plugin') $target -Recurse -Force`,
    `} else {`,
    `  if (Test-Path $target) { Remove-Item $target -Recurse -Force }`,
    `}`,
    `Write-Host '已恢复安装前的 profile 清单与插件副本。请重启 DSH。'`,
    '',
  ].join('\r\n')
  writeFileSync(join(backupDir, 'restore.ps1'), ps, 'utf8')
  log(`已备份到 ${backupDir}`)
}

function install() {
  const { manifest, planned } = planInstall()
  const dependencies = manifest.dependencies ?? (manifest.dependencies = {})
  const bundles = bundleList(manifest)
  const spec = `file:${ROOT.replaceAll('\\', '/')}`

  if (apply) {
    backup()
    rmSync(targetDir, { recursive: true, force: true })
    mkdirSync(targetDir, { recursive: true })
    for (const item of COPY_ITEMS) {
      const source = join(ROOT, item)
      if (!existsSync(source)) continue
      cpSync(source, join(targetDir, item), { recursive: true })
    }
    try {
      chmodSync(join(targetDir, 'lib', 'bin.js'), 0o755)
    } catch {
      /* Windows */
    }
    dependencies[PLUGIN_NAME] = spec
    if (!bundles.includes(PLUGIN_NAME)) bundles.push(PLUGIN_NAME)
    writeManifest(manifest)
  }

  log(`${apply ? '已安装' : '预览安装（不写盘）'} v${localPkg.version}`)
  change(`插件目录：${targetDir}`)
  change(`依赖：${PLUGIN_NAME} = ${spec}`)
  change(`bundle 顺序：${[...bundles, ...(bundles.includes(PLUGIN_NAME) ? [] : [PLUGIN_NAME])].join(' → ')}`)
  for (const item of planned) {
    if (item.kind === 'copy') change(`复制 ${item.from} → ${item.to}`)
  }
  if (apply) {
    log('')
    log('安装完成。宿主侧改动需要完全退出并重启 DSH 才会加载。')
    log(`回滚：PowerShell -File "${join(backupDir, 'restore.ps1')}"`)
  } else {
    log('')
    log('这是预览。确认无误后加 --apply 执行。')
  }
}

function uninstallPlugin() {
  const manifest = readManifest()
  const dependencies = manifest.dependencies ?? {}
  const bundles = bundleList(manifest)
  const spec = dependencies[PLUGIN_NAME]
  if (apply) {
    backup()
    rmSync(targetDir, { recursive: true, force: true })
    delete dependencies[PLUGIN_NAME]
    const index = bundles.indexOf(PLUGIN_NAME)
    if (index >= 0) bundles.splice(index, 1)
    writeManifest(manifest)
  }
  log(`${apply ? '已卸载' : '预览卸载（不写盘）'}`)
  change(`删除 ${targetDir}`)
  change(`移除依赖${spec === undefined ? '（本来就没有）' : ` ${PLUGIN_NAME}`}`)
  change(`从 bundle 顺序移除 ${PLUGIN_NAME}`)
  change('数据目录与已有还原点不会被删除')
  if (apply) {
    log('')
    log('卸载完成。请完全退出并重启 DSH。')
    log(`回滚：PowerShell -File "${join(backupDir, 'restore.ps1')}"`)
  } else {
    log('')
    log('这是预览。确认无误后加 --apply 执行。')
  }
}

if (showStatus) {
  printStatus()
  process.exit(0)
}

if (syncClientOnly) {
  if (!existsSync(clientBundle)) {
    console.error('缺少构建产物 client/client.js — 先运行 node scripts/build.mjs')
    process.exit(2)
  }
  if (!existsSync(targetDir)) {
    console.error(`插件尚未安装到 ${targetDir} — 先运行 node scripts/install.mjs --apply`)
    process.exit(2)
  }
  const target = join(targetDir, 'client', 'client.js')
  log(`同步客户端产物（${apply ? '执行' : '预览，不写盘'}）`)
  change(`${clientBundle} → ${target}`)
  if (apply) {
    mkdirSync(dirname(target), { recursive: true })
    cpSync(clientBundle, target)
    log('已写入。dsh-client-hmr 约 1 秒后热替换界面。')
  } else {
    log('这是预览。确认无误后加 --apply 执行。')
  }
  process.exit(0)
}

if (uninstall) uninstallPlugin()
else install()
