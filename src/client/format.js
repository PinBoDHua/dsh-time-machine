/** 客户端展示格式化：时间、统计、类型标签。全部是纯函数。 */

export function formatWhen(iso, locale, t, now = Date.now()) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return String(iso ?? '')
  const current = new Date(now)
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
  if (sameDay(date, current)) return time
  const yesterday = new Date(current)
  yesterday.setDate(current.getDate() - 1)
  if (sameDay(date, yesterday)) return `${t('global.yesterday')} ${time}`
  const day = new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }).format(date)
  return `${day} ${time}`
}

export function formatFullTime(iso, locale) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return String(iso ?? '')
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

function sameDay(left, right) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

export function formatAgo(iso, t, now = Date.now()) {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 10) return t('global.justNow')
  if (seconds < 60) return t('global.secondsAgo', { count: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('global.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('global.hoursAgo', { count: hours })
  return t('global.daysAgo', { count: Math.floor(hours / 24) })
}

export function formatStats(entry, t) {
  const stats = entry?.stats ?? {}
  if (stats.initial === true) return t('panel.initial')
  const files = Number(stats.files ?? 0)
  if (files === 0) return t('panel.noChanges')
  const parts = [t('panel.files', { count: files })]
  if (Number(stats.added ?? 0) > 0 || Number(stats.deleted ?? 0) > 0) {
    parts.push(t('panel.lines', { added: stats.added ?? 0, deleted: stats.deleted ?? 0 }))
  }
  return parts.join(' · ')
}

export function formatKind(entry, t) {
  if (entry?.kind === 'auto') {
    const phase = entry.phase === 'before' ? t('panel.phase.before') : t('panel.phase.after')
    return `${t('panel.kind.auto')} · ${phase}`
  }
  if (typeof entry?.label === 'string' && entry.label !== '') {
    if (entry.kind === 'safety' || entry.kind === 'restore') return entry.label
    return entry.label
  }
  return t(`panel.kind.${entry?.kind ?? 'manual'}`)
}

export function formatTurn(entry, t) {
  return entry?.turn === null || entry?.turn === undefined ? '' : t('panel.turn', { turn: entry.turn })
}

export function shortCheckpointId(id) {
  if (typeof id !== 'string') return ''
  return id.length > 9 ? id.slice(9) : id
}

export function formatListLine(entry, t) {
  const bits = [formatKind(entry, t)]
  const turn = formatTurn(entry, t)
  if (turn !== '') bits.push(turn)
  bits.push(formatStats(entry, t))
  return bits.join(' · ')
}

export function statusMessage(error, t) {
  const code = error?.code
  if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') return t('error.unauthorized')
  if (code === 'WORKSPACE_CHANGED') return t('error.workspaceChanged')
  if (code === 'SESSION_BUSY') return t('error.sessionBusy')
  if (code === 'GIT_UNAVAILABLE') return t('error.gitUnavailable')
  if (code === 'SESSION_UNSUPPORTED') return t('error.sessionUnsupported')
  if (code === 'NOTHING_TO_RESTORE') return t('error.nothingToRestore')
  if (code === 'PLAN_EXPIRED') return t('error.planExpired')
  if (code === 'PLAN_NOT_FOUND') return t('error.planNotFound')
  if (code === 'CHECKPOINT_NOT_FOUND') return t('error.checkpointNotFound')
  if (code === 'RESTORE_ROLLED_BACK') {
    return t('error.restoreRolledBack', { message: error?.details?.cause ?? error?.message ?? '' })
  }
  if (code === 'ROLLBACK_FAILED') {
    return t('error.rollbackFailed', { message: error?.details?.cause ?? error?.message ?? '' })
  }
  if (code === 'CONFIRM_REQUIRED') return t('error.confirmRequired')
  if (code === 'TIMEOUT') return t('error.timeout')
  if (code === 'NETWORK') return t('error.network', { message: error?.message ?? '' })
  if (code === 'BAD_RESPONSE') return t('error.badResponse')
  return error?.message ?? String(error)
}
