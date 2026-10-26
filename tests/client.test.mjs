import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src', 'client')
const BUNDLE = join(ROOT, 'client', 'client.js')

const fakeReact = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  useEffect() {},
  useMemo: (fn) => fn(),
}
globalThis.React = fakeReact
globalThis.ReactDOM = { createPortal: (node) => node }

const locales = await import(pathToFileURL(join(SRC, 'locales.js')).href)
const format = await import(pathToFileURL(join(SRC, 'format.js')).href)
const settings = await import(pathToFileURL(join(SRC, 'settings.js')).href)
const protocol = await import(pathToFileURL(join(ROOT, 'shared', 'protocol.js')).href)

function translator(dict = locales.zh) {
  return (key, params) => {
    const template = dict[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`))
  }
}

test('中英文词条键集完全一致', () => {
  const zhKeys = Object.keys(locales.zh).sort()
  const enKeys = Object.keys(locales.en).sort()
  assert.deepEqual(enKeys, zhKeys)
  assert.ok(zhKeys.includes('panel.confirm.apply'))
})

test('格式化：时间、统计、类型标签', () => {
  const t = translator()
  const now = Date.UTC(2026, 9, 25, 12, 0, 0)
  const iso = new Date(now - 65_000).toISOString()
  assert.match(format.formatAgo(iso, t, now), /1 分钟前/)
  const entry = {
    id: '20261025-120000-abcd',
    kind: 'auto',
    phase: 'after',
    turn: 3,
    createdAt: iso,
    stats: { files: 2, added: 10, deleted: 3 },
  }
  assert.equal(format.formatKind(entry, t), '自动 · 轮后')
  assert.match(format.formatStats(entry, t), /2 个文件/)
  assert.equal(format.formatTurn(entry, t), '第 3 轮')
  assert.equal(format.shortCheckpointId(entry.id), '120000-abcd')
  assert.equal(format.formatKind({ ...entry, kind: 'safety', label: '恢复前安全点' }, t), '恢复前安全点')
  assert.match(format.statusMessage({ code: 'NOTHING_TO_RESTORE' }, t), /已经与这个还原点一致/)
  assert.match(format.statusMessage({ code: 'PLAN_EXPIRED' }, t), /重新预览/)
})

test('设置草稿与提交载荷互转', () => {
  const draft = settings.settingsDraftOf({
    auto: false,
    beforeTurn: true,
    afterTurn: false,
    maxCheckpoints: 66,
    maxAgeDays: 7,
    timeoutMs: 15000,
    excludes: ['.git/', 'node_modules/'],
  })
  assert.equal(draft.auto, false)
  assert.equal(draft.maxCheckpoints, '66')
  assert.equal(draft.excludesText, '.git/\nnode_modules/')
  const payload = settings.settingsPayloadOf({ ...draft, excludesText: '\n.git/\nnode_modules/\n# comment\n' })
  assert.equal(payload.auto, false)
  assert.equal(payload.beforeTurn, true)
  assert.equal(payload.afterTurn, false)
  assert.equal(payload.maxCheckpoints, 66)
  assert.deepEqual(payload.excludes, ['.git/', 'node_modules/'])
})

function fakeBundleContext() {
  const registered = []
  const localeCalls = []
  const effects = []
  const styleTags = []
  const head = {
    appendChild(node) {
      styleTags.push(node)
    },
  }
  const document = {
    documentElement: { lang: 'zh-CN' },
    head,
    body: {},
    querySelector() {
      return null
    },
    createElement(tag) {
      return { tag, dataset: {}, textContent: '' }
    },
    addEventListener() {},
    removeEventListener() {},
  }
  const ctx = {
    effect(fn) {
      const disposable = fn()
      effects.push(disposable)
      return disposable
    },
    locale: {
      register(ns, dictionaries) {
        localeCalls.push({ ns, dictionaries })
        return () => {}
      },
    },
    slots: {
      inject(name, callback) {
        assert.equal(name, 'conversation.session.header.actions')
        return callback()
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, registered, localeCalls, effects, styleTags, document }
}

test('客户端 bundle：加载、注册挂载点、注入样式与词典', async () => {
  const code = readFileSync(BUNDLE, 'utf8')
  assert.match(code, /^window\.__ModuleLoader__\.load\(\{/u)
  let loaded
  const window = {
    __ModuleLoader__: {
      load(entry) {
        loaded = entry
      },
    },
  }
  const fakeRequire = (id) => {
    if (id === 'react') return fakeReact
    if (id === 'react-dom') return globalThis.ReactDOM
    throw new Error(`unexpected require: ${id}`)
  }
  const env = fakeBundleContext()
  const context = vm.createContext({ window, document: env.document, console, Symbol, require: fakeRequire })
  vm.runInContext(code, context)
  assert.equal(loaded.id, 'dsh-time-machine')
  const module = loaded.factory(fakeRequire)
  assert.equal(module.name, 'dsh-time-machine')
  assert.deepEqual(Array.from(module.inject), ['slots', 'locale'])
  module.apply(env.ctx)
  assert.equal(env.registered.length, 1)
  assert.equal(env.registered[0].options.name, 'conversation.session.header.actions')
  assert.equal(env.registered[0].options.id, 'dsh-time-machine')
  assert.equal(typeof env.registered[0].component, 'function')
  assert.equal(env.localeCalls.length, 1)
  assert.equal(env.localeCalls[0].ns, 'dsh-time-machine')
  assert.deepEqual(Object.keys(env.localeCalls[0].dictionaries.en).sort(), Object.keys(locales.zh).sort())
  assert.equal(env.styleTags.length, 1)
  assert.match(env.styleTags[0].textContent, /\.dtm_panel/u)
  assert.equal(env.styleTags[0].dataset.plugin, 'dsh-time-machine')

  // 入口组件在关闭态渲染为一个会话标题栏胶囊。
  const tree = env.registered[0].component({ sessionId: 's1', t: translator() })
  assert.equal(tree.type, fakeReact.Fragment)
  const root = tree.props.children[0]
  assert.equal(root.props.className, 'dtm_root')
  const trigger = root.props.children[0]
  assert.equal(trigger.props.className, 'dtm_trigger')
  assert.equal(trigger.props['aria-label'], '打开时光机：查看和恢复工作区还原点')
})

test('共享协议常量与客户端构建一致', () => {
  assert.equal(protocol.PLUGIN_ID, 'dsh-time-machine')
  assert.equal(protocol.API_BASE, '/plugins/dsh-time-machine')
  assert.ok(protocol.CHECKPOINT_ID_RE.test('20261025-120000-abcd'))
  assert.ok(protocol.PLAN_ID_RE.test('p-20261025-120000-abcdef'))
  assert.equal(protocol.CONFIRM_PHRASE, 'RESTORE')
})
