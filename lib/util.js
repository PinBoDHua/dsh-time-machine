import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { MAX_LABEL_CHARS } from '../shared/protocol.js'

export function nowIso() {
  return new Date().toISOString()
}

export function makeCheckpointId(date = new Date()) {
  return `${stamp(date)}-${randomBytes(2).toString('hex')}`
}

export function makePlanId(date = new Date()) {
  return `p-${stamp(date)}-${randomBytes(3).toString('hex')}`
}

function stamp(date) {
  const iso = date.toISOString()
  return `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`
}

export function workspaceKey(canonicalPath) {
  const spelling = process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath
  return createHash('sha256').update(spelling).digest('hex').slice(0, 16)
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

export async function ensureDir(directory) {
  await mkdir(directory, { recursive: true })
}

export async function exists(file) {
  try {
    await stat(file)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

export async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

export async function readJsonSafe(file) {
  try {
    return { value: await readJson(file), error: undefined }
  } catch (error) {
    return { value: undefined, error }
  }
}

export async function writeJsonAtomic(file, value) {
  await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

export async function writeTextAtomic(file, text) {
  await ensureDir(dirname(file))
  const temp = join(dirname(file), `.tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
  try {
    await writeFile(temp, text, 'utf8')
    try {
      await rename(temp, file)
    } catch (error) {
      if (error?.code !== 'EPERM' && error?.code !== 'EEXIST' && error?.code !== 'EACCES') throw error
      await rm(file, { force: true })
      await rename(temp, file)
    }
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

export async function removeFile(file) {
  await rm(file, { force: true })
}

export async function canonicalPath(path) {
  const missing = []
  let head = resolve(path)
  for (;;) {
    try {
      return join(await realpath(head), ...missing)
    } catch {
      const parent = dirname(head)
      if (parent === head) return resolve(path)
      missing.unshift(head.slice(parent.length).replace(/^[\\/]+/, ''))
      head = parent
    }
  }
}

export function toPosix(path) {
  return path.split(sep).join('/')
}

export function isInside(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 把 Git 树里的相对路径变成工作区内的绝对路径，并拒绝任何可能逃出根目录
 * 的写法。调用方仍需自行检查祖先目录不是符号链接。
 */
export function insidePath(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath === '') throw new Error('empty path')
  if (relativePath.includes('\0')) throw new Error('NUL in path')
  const normalized = relativePath.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.startsWith('//')) {
    throw new Error(`absolute path is not allowed: ${relativePath}`)
  }
  const segments = normalized.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') throw new Error(`unsafe path: ${relativePath}`)
    // Win32 会把结尾的点和空格规范化掉（`.git.` 实际就是 `.git`），也保留
    // CON/NUL 等设备名。不能只比较原始字符串。
    const check = process.platform === 'win32' ? segment.replace(/[ .]+$/u, '') : segment
    if (check === '') throw new Error(`unsafe path: ${relativePath}`)
    if (check.toLowerCase() === '.git') throw new Error(`refusing to touch .git: ${relativePath}`)
    if (
      process.platform === 'win32' &&
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(check)
    ) {
      throw new Error(`refusing to touch a Windows device path: ${relativePath}`)
    }
  }
  const absolute = resolve(root, ...segments)
  if (!isInside(root, absolute)) throw new Error(`path escapes workspace: ${relativePath}`)
  return absolute
}

export function sanitizeLabel(value) {
  if (typeof value !== 'string') return undefined
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_LABEL_CHARS)
  return cleaned === '' ? undefined : cleaned
}

export function sanitizeExcludes(value) {
  if (!Array.isArray(value)) return undefined
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const line = item.replace(/[\r\n\u0000]/g, '').trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.length > 200) throw new Error('exclude pattern is longer than 200 characters')
    if (!out.includes(line)) out.push(line)
  }
  if (out.length > 50) throw new Error('at most 50 exclude patterns are allowed')
  return out
}

export function clampInt(value, [min, max], fallback) {
  if (value === undefined || value === null) return fallback
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

export function formatError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

export function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
}

export function abortError(message = 'aborted') {
  const error = new Error(message)
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError()
}

export function sleep(ms, signal) {
  if (!ms || ms <= 0) return Promise.resolve()
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    if (signal?.aborted) {
      clearTimeout(timer)
      reject(abortError())
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
