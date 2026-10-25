/**
 * 离线视觉验收：真实组件 + 真实样式 + 宿主主题令牌，输出静态 HTML 供截图。
 * 不参与插件运行，也不进入安装包。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'verify', 'shots')
const CSS = readFileSync(join(ROOT, 'src', 'client', 'styles.css'), 'utf8')

function createElement(type, props, ...children) {
  return { type, props: { ...(props ?? {}), children: children.flat(Infinity) } }
}
const React = {
  Fragment: Symbol('Fragment'),
  createElement,
  useState: (initial) => [initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  useEffect() {},
  useMemo: (fn) => fn(),
}
globalThis.React = React
globalThis.ReactDOM = { createPortal: (node) => node }

const { TimeMachinePanel } = await import(pathToFileURL(join(ROOT, 'src', 'client', 'panel.js')).href)
const { zh, en } = await import(pathToFileURL(join(ROOT, 'src', 'client', 'locales.js')).href)

function translator(lang) {
  const table = lang === 'en' ? en : zh
  return (key, params) => {
    let text = table[key] ?? key
    if (params) text = text.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`))
    return text
  }
}

const now = Date.now()
const ago = (minutes) => new Date(now - minutes * 60000).toISOString()
const checkpoints = [
  { id: '20261025-142210-a1b2', kind: 'auto', phase: 'after', sessionId: 's1', turn: 8, createdAt: ago(2), stats: { files: 3, added: 22, deleted: 7 }, current: true },
  { id: '20261025-142105-c3d4', kind: 'restore', phase: 'after', sessionId: 's1', turn: 7, createdAt: ago(9), stats: { files: 2, added: 4, deleted: 31 } },
  { id: '20261025-142040-ef56', kind: 'safety', phase: 'after', sessionId: 's1', turn: 7, createdAt: ago(11), stats: { files: 2, added: 31, deleted: 4 } },
  { id: '20261025-141805-77aa', kind: 'auto', phase: 'after', sessionId: 's1', turn: 6, createdAt: ago(26), stats: { files: 5, added: 64, deleted: 12 } },
  { id: '20261025-141532-90bc', kind: 'manual', phase: 'after', sessionId: 's2', label: '重构前基线', createdAt: ago(48), stats: { files: 1, added: 8, deleted: 2 } },
  { id: '20261025-140010-1234', kind: 'auto', phase: 'before', sessionId: 's1', turn: 1, createdAt: ago(133), stats: { files: 0, added: 0, deleted: 0, initial: true } },
]
const status = {
  ok: true,
  key: 'preview',
  sessionId: 's1',
  workspacePath: 'C:\\Projects\\my-agent-project',
  workTree: 'C:\\Projects\\my-agent-project',
  prefix: '',
  checkpoints,
  total: 6,
  busy: false,
  activeTurn: null,
  settings: {
    version: 1,
    auto: true,
    beforeTurn: true,
    afterTurn: true,
    maxCheckpoints: 120,
    maxAgeDays: 14,
    timeoutMs: 30000,
    restoreTimeoutMs: 120000,
    maxRestoreFileBytes: 67108864,
    autoGc: true,
    excludes: ['.git/', 'node_modules/', '.dsh-time-machine/'],
  },
  lastError: null,
  journals: [],
  version: '0.1.0',
  gitAvailable: true,
}
const plan = {
  planId: 'p-20261025-142500-abcdef',
  checkpointId: '20261025-142105-c3d4',
  mode: 'exact',
  files: 8,
  writes: 6,
  deletes: 2,
  addedLines: 31,
  deletedLines: 4,
  sample: [
    { path: 'src/planner.ts', status: 'M', size: 4200 },
    { path: 'src/runner.ts', status: 'M', size: 9100 },
    { path: 'src/legacy/old-scheduler.ts', status: 'D', size: 1200 },
    { path: 'tests/planner.test.ts', status: 'A', size: 2300 },
    { path: 'docs/architecture/time-machine.md', status: 'A', size: 5400 },
  ],
  truncatedSample: 3,
  warnings: ['大小写重命名：src/Legacy.ts → src/legacy.ts，删除步骤已合并到写入'],
  expiresAt: now + 240000,
  workspacePath: 'C:\\Projects\\my-agent-project',
}
const result = {
  restored: true,
  targetId: '20261025-142105-c3d4',
  safetyId: '20261025-142501-8f8f',
  checkpointId: '20261025-142504-2a2a',
  mode: 'exact',
  files: 8,
  writes: 6,
  deletes: 2,
  addedLines: 31,
  deletedLines: 4,
  warnings: [],
  sample: [],
  truncatedSample: 0,
}
const draft = {
  auto: true,
  beforeTurn: true,
  afterTurn: true,
  maxCheckpoints: '120',
  maxAgeDays: '14',
  timeoutMs: '30000',
  excludesText: '.git/\nnode_modules/\n.dsh-time-machine/\n# 每行一个 gitignore 规则',
}
const baseProps = {
  status,
  loading: false,
  error: null,
  notice: null,
  view: 'timeline',
  selected: checkpoints[3],
  mode: 'overwrite',
  plan: null,
  planError: null,
  planning: false,
  restoring: false,
  result: null,
  exactAck: false,
  snapshotting: false,
  draft,
  saving: false,
  issues: [],
  settingsError: null,
  locale: 'zh-CN',
  position: { position: 'relative', left: 'auto', top: 'auto', width: '420px', maxHeight: 'none' },
  panelRef: { current: null },
  sessionId: 's1',
  onClose: () => {}, onRefresh: () => {}, onTimeline: () => {}, onSettings: () => {}, onBack: () => {},
  onSnapshot: () => {}, onSelect: () => {}, onMode: () => {}, onReplan: () => {}, onExactAck: () => {},
  onCancel: () => {}, onConfirm: () => {}, onDone: () => {}, onDraft: () => {}, onSaveSettings: () => {},
}

const views = [
  { name: 'timeline', props: {} },
  { name: 'settings', props: { view: 'settings' } },
  { name: 'confirm-exact', props: { view: 'confirm', mode: 'exact', plan, exactAck: true } },
  { name: 'result', props: { view: 'result', result } },
]

const VOID = new Set(['input', 'br', 'img', 'hr', 'meta', 'link'])
const UNITLESS = new Set(['flex', 'flexGrow', 'flexShrink', 'opacity', 'zIndex', 'fontWeight', 'lineHeight', 'order', 'strokeWidth', 'tabIndex'])
function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function styleOf(style) {
  if (!style) return ''
  return Object.entries(style).filter(([, value]) => value !== undefined && value !== null && value !== '').map(([key, value]) => {
    let text = String(value)
    if (typeof value === 'number' && value !== 0 && !UNITLESS.has(key)) text = `${text}px`
    const name = key.startsWith('--') ? key : key.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)
    return `${name}:${text}`
  }).join(';')
}
function html(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return esc(node)
  if (Array.isArray(node)) return node.map(html).join('')
  if (typeof node !== 'object') return ''
  if (node.type === React.Fragment) return html(node.props?.children)
  if (typeof node.type === 'function') return html(node.type(node.props ?? {}))
  if (typeof node.type !== 'string') return ''
  const tag = node.type
  const props = node.props ?? {}
  const attrs = []
  const style = styleOf(props.style)
  if (style) attrs.push(`style="${esc(style)}"`)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'style' || key === 'children' || key.startsWith('on')) continue
    if (key === 'className') { attrs.push(`class="${esc(value)}"`); continue }
    if (key === 'checked' || key === 'disabled' || key === 'readOnly') {
      if (value === true) attrs.push(key.toLowerCase())
      continue
    }
    if (key === 'value') {
      if (tag !== 'textarea') attrs.push(`value="${esc(value)}"`)
      continue
    }
    if (key.startsWith('aria-') || key.startsWith('data-')) {
      attrs.push(`${key}="${value === true ? 'true' : esc(value)}"`)
      continue
    }
    if (['viewBox', 'width', 'height', 'fill', 'stroke', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin', 'focusable', 'preserveAspectRatio', 'd', 'cx', 'cy', 'r', 'rows', 'min', 'max', 'step', 'type', 'title', 'role', 'spellCheck'].includes(key)) {
      const name = key.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)
      attrs.push(`${name}="${value === true ? 'true' : esc(value)}"`)
    }
  }
  const inner = tag === 'textarea' && props.value !== undefined ? esc(props.value) : html(props.children)
  return VOID.has(tag) ? `<${tag} ${attrs.join(' ')}>` : `<${tag} ${attrs.join(' ')}>${inner}</${tag}>`
}

const tokens = `
:root{color-scheme:light;--dsw-radius-lg:14px;--dsw-radius-sm:8px;--dsw-specific-menu:#fff;--dsw-menu-backdrop-filter:blur(18px);
--dsw-elevation-prominent:0 18px 50px rgba(16,29,54,.18),0 2px 8px rgba(16,29,54,.06);--dsw-alias-bg-base:#f5f7fb;--dsw-alias-bg-module-platform:#fff;
--dsw-alias-button-elevated-fill:#fff;--dsw-alias-label-primary:#0e1626;--dsw-alias-label-secondary:#46536a;--dsw-alias-label-tertiary:#65728a;--dsw-alias-label-caption:#7b879c;
--dsw-alias-border-l1:rgba(20,34,60,.08);--dsw-alias-border-l2:rgba(20,34,60,.13);--dsw-alias-border-l3:rgba(20,34,60,.22);
--dsw-alias-interactive-bg-hover:rgba(20,34,60,.045);--dsw-alias-interactive-bg-hover-solid:rgba(20,34,60,.075);
--dsw-alias-state-business-primary:#2f62d8;--dsw-alias-state-success-primary:#147a45;--dsw-alias-state-error-primary:#c02525;
--dsw-alias-switch-thumb:#fff;--dsw-focus-ring-color:#2f62d8;--dsw-alias-scrollbar-thumb:rgba(20,34,60,.18);}
body[data-ds-dark-theme]{color-scheme:dark;--dsw-specific-menu:#1b1f24;--dsw-elevation-prominent:0 22px 60px rgba(0,0,0,.6),0 2px 10px rgba(0,0,0,.35);
--dsw-alias-bg-base:#121417;--dsw-alias-bg-module-platform:#1a1d21;--dsw-alias-button-elevated-fill:#2a2f36;--dsw-alias-label-primary:#eef1f4;--dsw-alias-label-secondary:#c3c9d1;--dsw-alias-label-tertiary:#939ca8;--dsw-alias-label-caption:#828b96;
--dsw-alias-border-l1:rgba(255,255,255,.08);--dsw-alias-border-l2:rgba(255,255,255,.14);--dsw-alias-border-l3:rgba(255,255,255,.22);
--dsw-alias-interactive-bg-hover:rgba(255,255,255,.055);--dsw-alias-interactive-bg-hover-solid:rgba(255,255,255,.09);
--dsw-alias-state-business-primary:#7fa1ff;--dsw-alias-state-success-primary:#55c98c;--dsw-alias-state-error-primary:#f27777;
--dsw-alias-switch-thumb:#e8ebef;--dsw-focus-ring-color:#7fa1ff;--dsw-alias-scrollbar-thumb:rgba(255,255,255,.18);}
*{box-sizing:border-box}
body{margin:0;padding:28px 22px;background:radial-gradient(120% 120% at 15% 0%,rgba(76,181,245,.06),transparent 45%),var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;font-size:13px;-webkit-font-smoothing:antialiased}
.stage{width:520px;max-width:100%;margin:0 auto}
.caption{font:600 11px/1.4 "Segoe UI",sans-serif;color:#7b879c;margin:0 2px 14px;letter-spacing:.04em;text-transform:uppercase}
.headerMock{display:flex;align-items:center;gap:10px;padding:10px 14px;margin-bottom:10px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-module-platform);box-shadow:0 1px 2px rgba(16,29,54,.04)}
.headerMock .crumb{font-weight:600;font-size:12.5px}
.headerMock .spacer{flex:1}
.headerMock .pill{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-secondary);font-size:12px}
.headerMock .dot{width:8px;height:8px;border-radius:50%;background:#1f9e99}
.note{margin:12px 2px 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
`

mkdirSync(OUT, { recursive: true })
for (const lang of ['zh', 'en']) {
  const t = translator(lang)
  for (const view of views) {
    for (const dark of [false, true]) {
      const tree = TimeMachinePanel({ ...baseProps, ...view.props, t })
      const page = `<!doctype html><html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><style>${tokens}\n${CSS}</style></head>
<body${dark ? ' data-ds-dark-theme' : ''}><div class="stage">
<div class="caption">dsh-time-machine · ${view.name} · ${lang} · ${dark ? 'dark' : 'light'}</div>
<div class="headerMock"><span class="crumb">项目对话</span><span class="spacer"></span><span class="pill"><span class="dot"></span>时光机</span></div>
${html(tree)}
<p class="note">离线视觉验收：真实组件 + 真实样式 + 宿主主题令牌。面板在真实界面中由会话标题栏按钮向下展开。</p>
</div></body></html>`
      const file = join(OUT, `${view.name}-${lang}-${dark ? 'dark' : 'light'}.html`)
      writeFileSync(file, page, 'utf8')
      console.log('wrote', file)
    }
  }
}
