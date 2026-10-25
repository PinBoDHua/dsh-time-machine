/**
 * 零依赖客户端构建：把 src/client 的相对模块图拼成一个经典脚本，
 * 由宿主模块加载器登记。构建期做结构、权限、语法与关键接线校验。
 *
 * 用法：node scripts/build.mjs
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src', 'client')
const ENTRY = join(SRC, 'index.js')
const STYLE_FILE = join(SRC, 'styles.css')
const GENERATED = join(SRC, 'styles.generated.js')
const OUT = join(ROOT, 'client', 'client.js')
const PLUGIN_ID = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name

const ALLOWED_REQUIRES = new Set(['react', 'react-dom', 'react/jsx-runtime'])
const PRELUDE_NAMES = new Set(['React', 'ReactDOM', 'exports', 'module', 'require'])
const failures = []

function fail(message) {
  failures.push(message)
}

function rel(file) {
  return file.slice(ROOT.length + 1).replace(/\\/g, '/')
}

function assertBalancedBraces(name, css) {
  let depth = 0
  let inComment = false
  for (let index = 0; index < css.length; index += 1) {
    const two = css.slice(index, index + 2)
    if (!inComment && two === '/*') {
      inComment = true
      index += 1
      continue
    }
    if (inComment && two === '*/') {
      inComment = false
      index += 1
      continue
    }
    if (inComment) continue
    if (css[index] === '{') depth += 1
    if (css[index] === '}') depth -= 1
    if (depth < 0) {
      fail(`${name}: 第 ${index} 字节出现多余的 '}'`)
      return
    }
  }
  if (depth !== 0) fail(`${name}: 花括号未配平（剩余深度 ${depth}）`)
}

function generateStyles() {
  const css = readFileSync(STYLE_FILE, 'utf8').replace(/\r\n/g, '\n')
  assertBalancedBraces('styles.css', css)
  if (/<\/style/i.test(css)) fail('styles.css: 含 "</style" 片段，会提前闭合宿主文档里的样式标签')
  const body = `/**\n * 本文件由 scripts/build.mjs 生成，请勿手工编辑。\n */\nexport const STYLES = ${JSON.stringify(css)}\n`
  writeFileSync(GENERATED, body)
  return css.length
}

const IMPORT_RE = /^[ \t]*import\s+(?:([\w$]+)\s*,\s*)?(?:\{([\s\S]*?)\}\s*)?from\s*['"]([^'"]+)['"];?[ \t]*$/gm
const DECL_RE = /^(?:export\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm

function loadModule(file) {
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const deps = []
  for (const match of text.matchAll(IMPORT_RE)) {
    const specifier = match[3]
    if (!specifier.startsWith('.')) {
      fail(`${rel(file)}: 只允许相对导入，发现 '${specifier}'`)
      continue
    }
    if (!specifier.endsWith('.js')) {
      fail(`${rel(file)}: 相对导入必须带 .js 后缀：'${specifier}'`)
      continue
    }
    deps.push(resolve(dirname(file), specifier))
  }
  const body = text.replace(IMPORT_RE, '')
  const stripped = body.replace(/^(export\s+)/gm, '')
  if (/^[ \t]*export\s/m.test(stripped)) {
    const leftover = stripped.match(/^[ \t]*export\s.*$/m)?.[0]?.trim()
    fail(`${rel(file)}: 存在构建脚本无法处理的 export 形式：${leftover}`)
  }
  return { file, deps, body: stripped }
}

function orderModules(entry) {
  const ordered = []
  const state = new Map()
  const visit = (file, stack) => {
    const mark = state.get(file)
    if (mark === 'done') return
    if (mark === 'visiting') {
      fail(`模块图存在循环依赖：${[...stack, file].map(rel).join(' -> ')}`)
      return
    }
    state.set(file, 'visiting')
    const mod = loadModule(file)
    for (const dep of mod.deps) visit(dep, [...stack, file])
    state.set(file, 'done')
    ordered.push(mod)
  }
  visit(entry, [])
  return ordered
}

function collectDeclarations(modules) {
  const seen = new Map()
  for (const name of PRELUDE_NAMES) seen.set(name, '<prelude>')
  for (const mod of modules) {
    for (const match of mod.body.matchAll(DECL_RE)) {
      const name = match[1]
      const owner = seen.get(name)
      if (owner !== undefined) {
        fail(`顶层名冲突：'${name}' 同时定义于 ${owner} 与 ${rel(mod.file)}（拼接后后者会覆盖前者）`)
        continue
      }
      seen.set(name, rel(mod.file))
    }
  }
}

function assemble(modules) {
  const chunks = modules.map(
    (mod) => `\n// ---- ${rel(mod.file)} ${'-'.repeat(Math.max(0, 56 - rel(mod.file).length))}\n${mod.body.trim()}\n`
  )
  const body = `\t\tconst React = require("react")
\t\tconst ReactDOM = require("react-dom")
${chunks.join('')}
\t\texports.apply = apply
\t\texports.inject = inject
\t\texports.name = name
\t\treturn module.exports`
  return `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PLUGIN_ID)},
\tfactory: (require) => {
\t\tvar module = { exports: {} }
\t\tvar exports = module.exports
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
${body}
\t}
})
`
}

function verify(code) {
  try {
    new vm.Script(code, { filename: 'client.js' })
  } catch (error) {
    fail(`产物无法解析为经典脚本：${error.message}`)
    return
  }
  for (const match of code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
    if (!ALLOWED_REQUIRES.has(match[1])) fail(`产物 require 了未授权的模块 id：'${match[1]}'`)
  }
  for (const key of ['name', 'inject', 'apply']) {
    if (!code.includes(`exports.${key} = ${key}`)) fail(`产物缺少 exports.${key}`)
  }
  if (/^\s*(?:import|export)\s/m.test(code)) fail('产物中残留 ESM 语句')
  const markers = [
    ['conversation.session.header.actions', '会话标题栏挂载点'],
    ['x-dsh-time-machine-key', '控制密钥请求头'],
    ['/plugins/dsh-time-machine', '插件 API 前缀'],
    ['dtm_panel', '面板样式类'],
    ['panel.confirm.apply', '恢复确认词条'],
    [': styles', '样式卸载标记'],
    ['DEFAULT_CONFIG', '共享默认配置'],
    ['CONFIRM_PHRASE', '恢复确认短语'],
  ]
  for (const [marker, label] of markers) {
    if (!code.includes(marker)) fail(`产物里没有找到 ${label}（${marker}）`)
  }
}

function assertVersionConsistency() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8').match(/^## (\d+\.\d+\.\d+)\s*$/m)?.[1]
  if (changelog !== pkg.version) {
    fail(`版本不一致：package.json 是 ${pkg.version}，CHANGELOG.md 最新条目是 ${changelog ?? '（没有找到）'}`)
  }
  if (!pkg.dsh?.bundle?.patch) fail('package.json 缺少 dsh.bundle.patch')
  if (!Array.isArray(pkg.dsh?.client?.inject) || pkg.dsh.client.inject.length === 0) fail('package.json 缺少 dsh.client.inject')
}

const cssLength = generateStyles()
assertVersionConsistency()
const modules = orderModules(ENTRY)
collectDeclarations(modules)
const code = assemble(modules)
verify(code)

if (failures.length > 0) {
  console.error(`构建失败，共 ${failures.length} 项：`)
  for (const message of failures) console.error(`  - ${message}`)
  process.exit(1)
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, code)
console.log(`插件 id : ${PLUGIN_ID}`)
console.log(`样式    : ${(cssLength / 1024).toFixed(1)} KB`)
console.log(`模块    : ${modules.length} 个`)
console.log(`产物    : ${rel(OUT)} (${(Buffer.byteLength(code, 'utf8') / 1024).toFixed(1)} KB)`)
