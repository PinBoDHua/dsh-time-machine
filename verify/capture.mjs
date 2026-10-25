/**
 * 把离线预览页面里的面板本体截成文档用 PNG（不含真实会话数据）。
 * 先运行 node verify/preview.mjs，再运行本脚本。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const OUT = join(ROOT, 'docs', 'images')
const TMP = join(ROOT, 'verify', 'chrome-profile')
const CHROME_CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean)
const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate))
if (chromePath === undefined) throw new Error('找不到 Chrome/Edge；可设置 CHROME 环境变量')
const pages = [
  ['timeline-zh-light.html', 'timeline-light.png'],
  ['settings-zh-light.html', 'settings-light.png'],
  ['confirm-exact-zh-light.html', 'confirm-exact-light.png'],
  ['result-zh-light.html', 'result-light.png'],
]
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
const port = 9460
const hard = setTimeout(() => {
  console.error('capture timeout')
  try { spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  process.exit(2)
}, 60000)
const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--force-device-scale-factor=1.5', '--remote-debugging-port=' + String(port),
  '--user-data-dir=' + TMP, 'about:blank',
], { stdio: 'ignore' })

let socket
let nextId = 0
const pending = new Map()
function send(method, params = {}, timeout = 20000) {
  return new Promise((resolvePromise, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout ' + method)) }, timeout)
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolvePromise(value) },
      reject: (error) => { clearTimeout(timer); reject(error) },
    })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return result.result?.value
}

async function main() {
  for (let index = 0; index < 60; index += 1) {
    try {
      const version = await (await fetch(`http://127.0.0.1:${String(port)}/json/version`)).json()
      if (version) break
    } catch {
      await sleep(250)
    }
  }
  const targets = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()
  const page = targets.find((entry) => entry.type === 'page')
  if (page === undefined) throw new Error('Chrome page target missing')
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolvePromise, reject) => { socket.onopen = resolvePromise; socket.onerror = reject })
  socket.onmessage = (raw) => {
    const message = JSON.parse(raw.data)
    if (message.id === undefined) return
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  }
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 560, height: 1600, deviceScaleFactor: 1.5, mobile: false })
  for (const [html, png] of pages) {
    const url = pathToFileURL(join(ROOT, 'verify', 'shots', html)).href
    await send('Page.navigate', { url })
    await sleep(700)
    const rect = await evaluate(`(() => {
      const panel = document.querySelector('.dtm_panel')
      if (!panel) return null
      const r = panel.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })()`)
    if (rect === null) throw new Error('panel missing in ' + html)
    const clip = {
      x: Math.max(0, rect.x - 6),
      y: Math.max(0, rect.y - 6),
      width: Math.ceil(rect.width + 12),
      height: Math.ceil(rect.height + 12),
      scale: 1,
    }
    const shot = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true }, 30000)
    writeFileSync(join(OUT, png), Buffer.from(shot.data, 'base64'))
    console.log('wrote', png, clip.width + 'x' + clip.height)
  }
}

main().then(() => {
  clearTimeout(hard)
  try { spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  setTimeout(() => { try { rmSync(TMP, { recursive: true, force: true }) } catch {} ; process.exit(0) }, 500)
}).catch((error) => {
  clearTimeout(hard)
  console.error(error.stack || String(error))
  try { spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  process.exit(1)
})
