import { chmod, lstat, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { MAX_SAMPLE_FILES } from '../shared/protocol.js'
import {
  diffNameStatus,
  diffNumstat,
  readBlob,
  treeEntries,
} from './git.js'
import {
  insidePath,
  throwIfAborted,
  toPosix,
} from './util.js'

export class RestoreError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'RestoreError'
    this.code = code
    this.details = details
  }
}

function scopeAllows(binding, path) {
  if (binding.prefix === '') return true
  return path === binding.prefix || path.startsWith(`${binding.prefix}/`)
}

function displayPathOf(binding, path) {
  if (binding.prefix !== '' && path.startsWith(`${binding.prefix}/`)) return path.slice(binding.prefix.length + 1)
  return path
}

async function lstatSafe(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined
    throw error
  }
}

async function assertSafeParents(binding, relativePath) {
  const segments = relativePath.split('/')
  let current = binding.workTree
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = join(current, segments[index])
    const info = await lstatSafe(current)
    if (info === undefined) return
    if (info.isSymbolicLink()) {
      throw new RestoreError('UNSAFE_PATH', `父目录是符号链接，拒绝写入：${toPosix(relativePath)}`)
    }
    if (!info.isDirectory()) {
      throw new RestoreError('PATH_CONFLICT', `父路径不是目录：${toPosix(relativePath)}`)
    }
  }
}

function validateEntryPath(binding, path) {
  if (!scopeAllows(binding, path)) {
    throw new RestoreError('UNSAFE_PATH', `快照路径不在会话工作区内：${path}`)
  }
  try {
    return insidePath(binding.workTree, path)
  } catch (error) {
    throw new RestoreError('UNSAFE_PATH', error.message)
  }
}

/**
 * 生成恢复计划：当前 tree 到目标 tree 的文件级变化，按模式过滤删除，
 * 并在落盘前把路径、大小、目录冲突与符号链接风险全部检查一遍。
 */
export async function buildRestorePlan({
  binding,
  git,
  currentCommit,
  currentTree,
  target,
  mode,
  maxFileBytes,
  signal,
  timeoutMs,
}) {
  const currentEntries = await treeEntries(binding, { git, commit: currentCommit, signal, timeoutMs })
  const targetEntries = await treeEntries(binding, { git, commit: target.commit, signal, timeoutMs })
  const statuses = await diffNameStatus(binding, { git, from: currentCommit, to: target.commit, signal, timeoutMs })
  const numstat = await diffNumstat(binding, { git, from: currentCommit, to: target.commit, signal, timeoutMs })
  const warnings = []
  const entries = []
  const oversized = []
  const seen = new Map()
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'

  for (const change of statuses) {
    throwIfAborted(signal)
    const path = change.path
    if (!scopeAllows(binding, path)) continue
    if (change.status === 'D' && mode !== 'exact') continue
    const targetEntry = targetEntries.get(path)
    const currentEntry = currentEntries.get(path)

    if (process.platform === 'win32' && currentEntry?.mode === '120000') {
      throw new RestoreError('UNSUPPORTED_SYMLINK', `Windows 上暂不支持覆盖/删除当前为符号链接的路径：${path}`, { paths: [path] })
    }
    if (change.status === 'A' || change.status === 'M' || change.status === 'T') {
      if (targetEntry === undefined || targetEntry.type !== 'blob') {
        warnings.push(`跳过无法恢复的条目：${path}`)
        continue
      }
      if (targetEntry.mode === '160000') {
        warnings.push(`跳过子模块：${path}`)
        continue
      }
      if (targetEntry.mode === '120000' && process.platform === 'win32') {
        throw new RestoreError('UNSUPPORTED_SYMLINK', `Windows 上暂不支持恢复符号链接：${path}`, { paths: [path] })
      }
      if (targetEntry.size !== null && targetEntry.size > maxFileBytes) {
        oversized.push({ path, size: targetEntry.size })
        continue
      }
      const key = caseInsensitive ? path.toLowerCase() : path
      if (seen.has(key)) {
        throw new RestoreError('CASE_CONFLICT', `两个快照路径在大小写不敏感的文件系统上冲突：${path}`, {
          paths: [seen.get(key), path],
        })
      }
      seen.set(key, path)
      entries.push({
        path,
        display: displayPathOf(binding, path),
        status: change.status,
        mode: targetEntry.mode,
        oid: targetEntry.oid,
        size: targetEntry.size,
      })
      continue
    }

    if (change.status === 'D') {
      if (currentEntry === undefined) continue
      if (currentEntry.mode === '160000') {
        warnings.push(`跳过子模块：${path}`)
        continue
      }
      if (currentEntry.mode === '120000' && process.platform === 'win32') {
        throw new RestoreError('UNSUPPORTED_SYMLINK', `Windows 上暂不支持删除符号链接后再回滚：${path}`, { paths: [path] })
      }
      entries.push({
        path,
        display: displayPathOf(binding, path),
        status: 'D',
        mode: currentEntry.mode,
        oid: currentEntry.oid,
        size: currentEntry.size,
      })
    }
  }

  if (caseInsensitive) {
    const writes = new Map(entries.filter((entry) => entry.status !== 'D').map((entry) => [entry.path.toLowerCase(), entry.path]))
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]
      if (entry.status !== 'D') continue
      const collision = writes.get(entry.path.toLowerCase())
      if (collision === undefined) continue
      warnings.push(`大小写重命名：${entry.display} → ${displayPathOf(binding, collision)}，删除步骤已合并到写入`)
      entries.splice(index, 1)
    }
  }

  if (oversized.length > 0) {
    throw new RestoreError(
      'FILE_TOO_LARGE',
      `有 ${oversized.length} 个文件超过恢复大小上限（${maxFileBytes} 字节），请提高 maxRestoreFileBytes 或手动处理`,
      { files: oversized.slice(0, MAX_SAMPLE_FILES) },
    )
  }

  for (const entry of entries) {
    const absolute = validateEntryPath(binding, entry.path)
    const info = await lstatSafe(absolute)
    if (entry.status === 'D') {
      if (info !== undefined && info.isDirectory()) {
        throw new RestoreError('PATH_CONFLICT', `要删除的路径现在是目录，拒绝递归删除：${entry.path}`, {
          paths: [entry.path],
        })
      }
      continue
    }
    if (info !== undefined && info.isDirectory()) {
      throw new RestoreError('PATH_CONFLICT', `要写入的路径现在是目录，拒绝覆盖：${entry.path}`, {
        paths: [entry.path],
      })
    }
    await assertSafeParents(binding, entry.path)
  }

  if (entries.length === 0) {
    throw new RestoreError('NOTHING_TO_RESTORE', '当前工作区已经与这个还原点一致（按所选模式）')
  }

  let addedLines = 0
  let deletedLines = 0
  for (const entry of entries) {
    const stat = numstat.get(entry.path)
    if (stat === undefined) continue
    addedLines += stat.added
    deletedLines += stat.deleted
  }
  const writes = entries.filter((entry) => entry.status !== 'D')
  const deletes = entries.filter((entry) => entry.status === 'D')
  return {
    currentTree,
    targetTree: target.tree,
    targetId: target.id,
    targetCommit: target.commit,
    mode,
    entries,
    writes: writes.length,
    deletes: deletes.length,
    addedLines,
    deletedLines,
    warnings,
    sample: entries.slice(0, MAX_SAMPLE_FILES).map((entry) => ({
      path: entry.display,
      status: entry.status,
      size: entry.size,
    })),
    truncatedSample: Math.max(0, entries.length - MAX_SAMPLE_FILES),
  }
}

async function replaceWithBuffer(absolute, buffer, mode) {
  await mkdir(dirname(absolute), { recursive: true })
  const temp = join(dirname(absolute), `.dsh-tm-${process.pid}-${randomBytes(4).toString('hex')}`)
  await writeFile(temp, buffer)
  if (process.platform !== 'win32' && (mode === '100755' || mode === '100644')) {
    try {
      await chmod(temp, mode === '100755' ? 0o755 : 0o644)
    } catch {
      /* mode is best-effort */
    }
  }
  try {
    await rename(temp, absolute)
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES' && error?.code !== 'EEXIST') {
      await rm(temp, { force: true })
      throw error
    }
    try {
      await chmod(absolute, 0o666).catch(() => {})
      await rm(absolute, { force: true })
      await rename(temp, absolute)
    } catch (retryError) {
      await rm(temp, { force: true })
      throw retryError
    }
  }
}

async function writeSymlink(absolute, buffer) {
  await mkdir(dirname(absolute), { recursive: true })
  await rm(absolute, { force: true })
  await symlink(buffer, absolute)
}

/**
 * 执行计划。写入先于删除，任何一步失败都会抛错，由上层用安全点回滚。
 * 每个条目落盘前再次检查路径，避免计划生成后目录结构被替换成符号链接。
 */
export async function applyEntries({ binding, git, entries, maxFileBytes, signal, timeoutMs }) {
  const applied = []
  for (const entry of entries) {
    throwIfAborted(signal)
    const absolute = validateEntryPath(binding, entry.path)
    if (entry.status === 'D') {
      const info = await lstatSafe(absolute)
      if (info !== undefined) {
        if (info.isDirectory()) throw new RestoreError('PATH_CONFLICT', `删除目标变成目录：${entry.path}`)
        await rm(absolute, { force: true })
      }
      applied.push(entry)
      continue
    }
    await assertSafeParents(binding, entry.path)
    const info = await lstatSafe(absolute)
    if (info !== undefined && info.isDirectory()) {
      throw new RestoreError('PATH_CONFLICT', `写入目标变成目录：${entry.path}`)
    }
    const buffer = await readBlob(binding, {
      git,
      oid: entry.oid,
      maxBytes: Math.min(maxFileBytes, entry.size === null ? maxFileBytes : Math.max(entry.size, 1)),
      signal,
      timeoutMs,
    })
    if (entry.mode === '120000') await writeSymlink(absolute, buffer)
    else await replaceWithBuffer(absolute, buffer, entry.mode)
    applied.push(entry)
  }
  return applied
}

/**
 * 把计划涉及的路径恢复成安全点里的内容。没有出现在安全点里的路径是恢复过程
 * 新建的，回滚时删除。这里不依赖“已经写了多少”的状态记录，天然幂等。
 */
export async function rollbackToSafety({
  binding,
  git,
  safetyCommit,
  planEntries,
  maxFileBytes,
  signal,
  timeoutMs,
}) {
  const safetyEntries = await treeEntries(binding, { git, commit: safetyCommit, signal, timeoutMs })
  const rollback = []
  for (const entry of planEntries) {
    const safety = safetyEntries.get(entry.path)
    if (safety === undefined) {
      rollback.push({ path: entry.path, status: 'D' })
    } else if (safety.type === 'blob' && safety.mode !== '160000') {
      rollback.push({
        path: entry.path,
        status: 'W',
        mode: safety.mode,
        oid: safety.oid,
        size: safety.size,
      })
    }
  }
  await applyEntries({ binding, git, entries: rollback, maxFileBytes, signal, timeoutMs })
  return rollback.length
}

export function verifyRestoredEntries({ plan, postEntries }) {
  const mismatches = []
  for (const entry of plan.entries) {
    if (entry.status === 'D') {
      if (postEntries.has(entry.path)) mismatches.push({ path: entry.path, reason: 'still-present' })
      continue
    }
    const post = postEntries.get(entry.path)
    if (post === undefined || post.oid !== entry.oid) {
      mismatches.push({ path: entry.path, reason: 'content-mismatch' })
    }
  }
  return mismatches
}

export async function readSafetyEntries({ binding, git, safetyCommit, signal, timeoutMs }) {
  return treeEntries(binding, { git, commit: safetyCommit, signal, timeoutMs })
}
