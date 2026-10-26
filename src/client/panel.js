import { createApi } from './api.js'
import {
  formatAgo,
  formatFullTime,
  formatKind,
  formatStats,
  formatTurn,
  formatWhen,
  shortCheckpointId,
  statusMessage,
} from './format.js'
import {
  IconArrowLeft,
  IconCameraPlus,
  IconCheck,
  IconChevronRight,
  IconClose,
  IconHistory,
  IconRefresh,
  IconTune,
  IconShield,
  IconWarning,
} from './icons.js'
import { SettingsView, settingsDraftOf } from './settings.js'
import { DtmBanner, DtmButton, DtmIconButton, DtmSpinner, h } from './ui.js'

const DTM_PANEL_WIDTH = 420
const DTM_PANEL_GAP = 8

function activeLocale() {
  if (typeof document !== 'undefined' && typeof document.documentElement?.lang === 'string' && document.documentElement.lang !== '') {
    return document.documentElement.lang
  }
  if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') return navigator.language
  return 'zh-CN'
}

function useStableApi() {
  const ref = React.useRef(null)
  if (ref.current === null) ref.current = createApi()
  return ref.current
}

function useAnchorPosition(rootRef, open) {
  const [style, setStyle] = React.useState(null)
  const measure = React.useCallback(() => {
    const node = rootRef.current
    if (node === null || typeof window === 'undefined') return
    const rect = node.getBoundingClientRect()
    const width = Math.min(DTM_PANEL_WIDTH, window.innerWidth - DTM_PANEL_GAP * 2)
    const maxLeft = Math.max(DTM_PANEL_GAP, window.innerWidth - width - DTM_PANEL_GAP)
    // 会话标题栏的动作靠近标题左侧；按右边缘对齐会把 420px 面板推到侧栏上。
    // 左边缘对齐按钮，再夹进视口，面板落在对话区内。
    const left = Math.min(Math.max(DTM_PANEL_GAP, rect.left), maxLeft)
    const top = Math.max(DTM_PANEL_GAP, rect.bottom + DTM_PANEL_GAP)
    const maxHeight = Math.max(160, window.innerHeight - top - DTM_PANEL_GAP)
    setStyle({
      left: `${Math.round(left)}px`,
      top: `${Math.round(top)}px`,
      width: `${Math.round(width)}px`,
      maxHeight: `${Math.round(maxHeight)}px`,
    })
  }, [rootRef])

  React.useEffect(() => {
    if (open !== true) {
      setStyle(null)
      return undefined
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [measure, open])
  return style
}

function errorMessageOf(error, t) {
  return statusMessage(error, t)
}

function PanelHeader(props) {
  const { t, status, view, loading, restoring, onRefresh, onClose, onTimeline, onSettings, onBack } = props
  const canSettings = status !== null && status !== undefined
  const showBack = view === 'confirm' || view === 'result'
  return h(
    'div',
    { className: 'dtm_panelHead' },
    h(
      'div',
      { className: 'dtm_brand' },
      h('span', { className: 'dtm_brandIcon', 'aria-hidden': 'true' }, h(IconHistory, { size: 19 })),
      h(
        'div',
        { className: 'dtm_brandCopy' },
        h(
          'div',
          { className: 'dtm_brandTitle' },
          h('span', null, t('panel.title')),
          status?.version ? h('span', { className: 'dtm_version' }, t('global.version', { version: status.version })) : null
        ),
        h('div', { className: 'dtm_path', title: status?.workspacePath ?? '' }, status?.workspacePath ?? '—')
      )
    ),
    h(
      'div',
      { className: 'dtm_headActions' },
      h(
        DtmIconButton,
        {
          label: t('panel.refresh'),
          disabled: loading || restoring,
          onClick: onRefresh,
        },
        loading ? h('span', { className: 'dtm_spinner', 'aria-hidden': 'true' }) : h(IconRefresh, { size: 14 })
      ),
      h(
        DtmIconButton,
        {
          label: t('panel.close'),
          disabled: restoring,
          onClick: onClose,
        },
        h(IconClose, { size: 15 })
      )
    ),
    showBack
      ? h(
          'div',
          { className: 'dtm_subBar' },
          h(
            'button',
            { type: 'button', className: 'dtm_back', onClick: onBack, disabled: restoring },
            h(IconArrowLeft, { size: 13 }),
            h('span', null, t('panel.confirm.back'))
          )
        )
      : h(
          'div',
          { className: 'dtm_tabs', role: 'tablist' },
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              className: 'dtm_tab',
              'aria-selected': view === 'timeline',
              'data-active': view === 'timeline' ? 'true' : 'false',
              onClick: onTimeline,
              disabled: restoring,
            },
            h(IconHistory, { size: 13 }),
            h('span', null, t('panel.tabs.timeline'))
          ),
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              className: 'dtm_tab',
              'aria-selected': view === 'settings',
              'data-active': view === 'settings' ? 'true' : 'false',
              onClick: onSettings,
              disabled: !canSettings || restoring,
            },
            h(IconTune, { size: 13 }),
            h('span', null, t('panel.tabs.settings'))
          )
        )
  )
}

function CommonBanners(props) {
  const { t, status, notice, error } = props
  const banners = []
  if (notice !== null && notice !== undefined && notice !== '') {
    banners.push(h(DtmBanner, { key: 'notice', kind: 'success' }, notice))
  }
  if (status?.busy === true) {
    banners.push(h(DtmBanner, { key: 'busy', kind: 'info' }, t('panel.busy')))
  }
  if (status?.settings?.auto === false) {
    banners.push(h(DtmBanner, { key: 'autoOff', kind: 'info' }, t('panel.autoOff')))
  }
  if (Array.isArray(status?.journals) && status.journals.length > 0) {
    banners.push(h(DtmBanner, { key: 'journals', kind: 'warning' }, t('panel.journal', { count: status.journals.length })))
  }
  if (status?.lastError !== null && status?.lastError !== undefined) {
    banners.push(
      h(
        DtmBanner,
        { key: 'lastError', kind: 'warning' },
        t('panel.lastError', { message: status.lastError.message })
      )
    )
  }
  if (error !== null && error !== undefined) {
    banners.push(
      h(
        DtmBanner,
        {
          key: 'error',
          kind: 'error',
          action: h(
            DtmButton,
            { variant: 'ghost', size: 'sm', onClick: props.onRetry },
            t('panel.retry')
          ),
        },
        errorMessageOf(error, t)
      )
    )
  }
  return banners.length === 0 ? null : h('div', { className: 'dtm_banners' }, banners)
}

function CheckpointRow(props) {
  const { t, entry, busy, locale, otherSession, onSelect } = props
  const title = entry.label || formatKind(entry, t)
  const kindLine = entry.label
    ? `${t(`panel.kind.${entry.kind}`)}${formatTurn(entry, t) ? ` · ${formatTurn(entry, t)}` : ''}`
    : formatTurn(entry, t)
  return h(
    'div',
    { className: 'dtm_row', 'data-kind': entry.kind, 'data-current': entry.current ? 'true' : 'false', role: 'listitem' },
    h('span', { className: 'dtm_rowDot', 'aria-hidden': 'true' }),
    h(
      'div',
      { className: 'dtm_rowBody' },
      h(
        'div',
        { className: 'dtm_rowTop' },
        h('span', { className: 'dtm_rowTitle', title: entry.id }, title),
        entry.current ? h('span', { className: 'dtm_badge', 'data-tone': 'current' }, t('panel.current')) : null,
        otherSession ? h('span', { className: 'dtm_badge' }, t('panel.otherSession')) : null,
        h(
          'span',
          { className: 'dtm_rowTime', title: `${formatFullTime(entry.createdAt, locale)} · ${formatAgo(entry.createdAt, t)}` },
          formatWhen(entry.createdAt, locale, t)
        )
      ),
      h(
        'div',
        { className: 'dtm_rowMeta' },
        kindLine === '' ? null : h('span', null, kindLine),
        kindLine === '' ? null : h('span', { className: 'dtm_sep', 'aria-hidden': 'true' }, '·'),
        h('span', null, formatStats(entry, t))
      )
    ),
    h(
      DtmButton,
      {
        variant: 'ghost',
        size: 'sm',
        disabled: busy,
        title: busy ? t('panel.restoreLocked') : undefined,
        onClick: () => onSelect(entry),
      },
      h('span', null, t('panel.restore')),
      h(IconChevronRight, { size: 12 })
    )
  )
}

function TimelineView(props) {
  const { t, status, locale, snapshotting, onSnapshot, onSelect, sessionId } = props
  if (status.checkpoints.length === 0) {
    return h(
      'div',
      { className: 'dtm_empty' },
      h('span', { className: 'dtm_emptyIcon', 'aria-hidden': 'true' }, h(IconCameraPlus, { size: 24 })),
      h('div', { className: 'dtm_emptyTitle' }, t('panel.empty.title')),
      h('p', { className: 'dtm_emptyBody' }, t('panel.empty.body')),
      h(
        DtmButton,
        { variant: 'primary', disabled: snapshotting, onClick: onSnapshot },
        snapshotting ? h(DtmSpinner, null) : h(IconCameraPlus, { size: 14 }),
        h('span', null, snapshotting ? t('panel.snapshotting') : t('panel.empty.action'))
      )
    )
  }
  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'dtm_list', role: 'list' },
      status.checkpoints.map((entry) =>
        h(CheckpointRow, {
          key: entry.id,
          t,
          entry,
          busy: status.busy,
          locale,
          otherSession: entry.sessionId !== sessionId,
          onSelect,
        })
      )
    ),
    h(
      'div',
      { className: 'dtm_listFoot' },
      h(
        'div',
        { className: 'dtm_listCount' },
        t('panel.count', { count: status.total }),
        status.total > status.checkpoints.length
          ? h('span', { className: 'dtm_listMore' }, t('panel.more', { count: status.checkpoints.length }))
          : null
      ),
      h(
        DtmButton,
        { variant: 'soft', size: 'sm', disabled: snapshotting, onClick: onSnapshot },
        snapshotting ? h(DtmSpinner, null) : h(IconCameraPlus, { size: 13 }),
        h('span', null, snapshotting ? t('panel.snapshotting') : t('panel.snapshot'))
      )
    )
  )
}

function ModeOption(props) {
  const { t, value, current, disabled, onChange } = props
  const selected = value === current
  return h(
    'button',
    {
      type: 'button',
      role: 'radio',
      'aria-checked': selected,
      className: 'dtm_mode',
      'data-selected': selected ? 'true' : 'false',
      'data-mode': value,
      disabled,
      onClick: () => onChange(value),
    },
    h('span', { className: 'dtm_modeRadio', 'aria-hidden': 'true' }, selected ? h('span', null) : null),
    h(
      'span',
      { className: 'dtm_modeCopy' },
      h('span', { className: 'dtm_modeTitle' }, value === 'overwrite' ? t('panel.confirm.overwrite') : t('panel.confirm.exact')),
      h('span', { className: 'dtm_modeHint' }, value === 'overwrite' ? t('panel.confirm.overwriteHint') : t('panel.confirm.exactHint'))
    )
  )
}

function PlanPreview(props) {
  const { t, plan, planning, planError, mode, onReplan, disabled } = props
  if (planning) {
    return h(
      'div',
      { className: 'dtm_planState' },
      h(DtmSpinner, { label: t('panel.confirm.plan') })
    )
  }
  if (planError !== null && planError !== undefined) {
    return h(
      React.Fragment,
      null,
      h(
        DtmBanner,
        { kind: 'error' },
        planError.code === 'WORKSPACE_CHANGED'
          ? t('panel.confirm.stale')
          : t('panel.confirm.planFailed', { message: errorMessageOf(planError, t) })
      ),
      h(
        DtmButton,
        { variant: 'soft', size: 'sm', disabled, onClick: onReplan },
        h(IconRefresh, { size: 13 }),
        h('span', null, t('panel.confirm.replan'))
      )
    )
  }
  if (plan === null || plan === undefined) return null
  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'dtm_planSummary' },
      h(
        'div',
        { className: 'dtm_planStat' },
        h('span', { className: 'dtm_planNumber' }, plan.writes),
        h('span', { className: 'dtm_planLabel' }, t('panel.confirm.write'))
      ),
      h(
        'div',
        { className: 'dtm_planStat', 'data-tone': 'danger' },
        h('span', { className: 'dtm_planNumber' }, plan.deletes),
        h('span', { className: 'dtm_planLabel' }, t('panel.confirm.delete'))
      ),
      h(
        'div',
        { className: 'dtm_planStat', 'data-tone': 'muted' },
        h('span', { className: 'dtm_planNumber' }, `+${String(plan.addedLines)}`),
        h('span', { className: 'dtm_planLabel' }, `−${String(plan.deletedLines)}`)
      )
    ),
    h('p', { className: 'dtm_summaryLine' }, t('panel.confirm.summary', { writes: plan.writes, deletes: plan.deletes })),
    plan.sample.length === 0
      ? null
      : h(
          'div',
          { className: 'dtm_sample' },
          h('div', { className: 'dtm_sampleTitle' }, t('panel.confirm.sample')),
          h(
            'div',
            { className: 'dtm_sampleList' },
            plan.sample.map((file) =>
              h(
                'div',
                { key: `${file.status}:${file.path}`, className: 'dtm_sampleRow' },
                h('span', { className: 'dtm_sampleBadge', 'data-status': file.status }, file.status === 'D' ? t('panel.confirm.delete') : t('panel.confirm.write')),
                h('span', { className: 'dtm_samplePath', title: file.path }, file.path)
              )
            )
          ),
          plan.truncatedSample > 0
            ? h('div', { className: 'dtm_sampleMore' }, t('panel.confirm.more', { count: plan.truncatedSample }))
            : null
        ),
    Array.isArray(plan.warnings) && plan.warnings.length > 0
      ? h(
          DtmBanner,
          { kind: 'warning' },
          h(
            'span',
            null,
            plan.warnings.map((warning, index) => h('div', { key: String(index) }, warning))
          )
        )
      : null
  )
}

function ConfirmView(props) {
  const {
    t, locale, selected, mode, plan, planning, planError, restoring, exactAck, busy, onMode, onReplan, onExactAck, onCancel, onConfirm,
  } = props
  if (selected === null || selected === undefined) return null
  const needsAck = mode === 'exact'
  const canRestore = plan !== null && !planning && !restoring && !busy && (!needsAck || exactAck)
  return h(
    'div',
    { className: 'dtm_view dtm_confirm' },
    h(
      'div',
      { className: 'dtm_target' },
      h(
        'div',
        { className: 'dtm_targetTop' },
        h('span', { className: 'dtm_targetTitle' }, t('panel.confirm.title')),
        h('span', { className: 'dtm_targetTime', title: formatFullTime(selected.createdAt, locale) }, formatWhen(selected.createdAt, locale, t))
      ),
      h(
        'div',
        { className: 'dtm_targetMeta' },
        formatKind(selected, t),
        formatTurn(selected, t) === '' ? null : h('span', { className: 'dtm_sep' }, '·'),
        formatTurn(selected, t) === '' ? null : h('span', null, formatTurn(selected, t)),
        h('span', { className: 'dtm_sep' }, '·'),
        h('span', null, formatStats(selected, t))
      )
    ),
    h('div', { className: 'dtm_sectionLabel' }, t('panel.confirm.mode')),
    h(
      'div',
      { className: 'dtm_modes', role: 'radiogroup', 'aria-label': t('panel.confirm.mode') },
      h(ModeOption, {
        t,
        value: 'overwrite',
        current: mode,
        disabled: restoring || planning,
        onChange: onMode,
      }),
      h(ModeOption, {
        t,
        value: 'exact',
        current: mode,
        disabled: restoring || planning,
        onChange: onMode,
      })
    ),
    needsAck
      ? h(
          'label',
          { className: 'dtm_ack', 'data-checked': exactAck ? 'true' : 'false' },
          h('input', {
            type: 'checkbox',
            checked: exactAck,
            disabled: restoring,
            onChange: (event) => onExactAck(event.target.checked),
          }),
          h('span', null, t('panel.confirm.exactCheck'))
        )
      : null,
    h(PlanPreview, {
      t,
      plan,
      planning,
      planError,
      mode,
      disabled: restoring,
      onReplan,
    }),
    h(
      'div',
      { className: 'dtm_safetyNote' },
      h(IconShield, { size: 14 }),
      h('span', null, t('panel.confirm.safety'))
    ),
    h(
      'div',
      { className: 'dtm_actions' },
      h(DtmButton, { variant: 'ghost', disabled: restoring, onClick: onCancel }, t('panel.confirm.cancel')),
      h(
        DtmButton,
        {
          variant: needsAck ? 'danger' : 'primary',
          disabled: !canRestore,
          onClick: onConfirm,
        },
        restoring ? h(DtmSpinner, null) : h(IconHistory, { size: 14 }),
        h('span', null, restoring ? t('panel.confirm.applying') : t('panel.confirm.apply'))
      )
    )
  )
}

function ResultView(props) {
  const { t, result, onDone } = props
  return h(
    'div',
    { className: 'dtm_view dtm_result' },
    h('span', { className: 'dtm_resultIcon', 'aria-hidden': 'true' }, h(IconCheck, { size: 26 })),
    h('div', { className: 'dtm_resultTitle' }, t('panel.result.title')),
    h('p', { className: 'dtm_resultSummary' }, t('panel.result.summary', { writes: result.writes, deletes: result.deletes })),
    h(
      'div',
      { className: 'dtm_resultIds' },
      h('span', { title: result.safetyId }, `${t('panel.result.ids', { safety: shortCheckpointId(result.safetyId), checkpoint: shortCheckpointId(result.checkpointId) })}`),
      h('div', { className: 'dtm_resultTarget', title: result.targetId }, t('panel.result.target', { target: shortCheckpointId(result.targetId) }))
    ),
    h('p', { className: 'dtm_resultHint' }, t('panel.result.hint')),
    h(
      'div',
      { className: 'dtm_actions' },
      h(DtmButton, { variant: 'primary', onClick: onDone }, t('panel.result.done'))
    )
  )
}

export function TimeMachinePanel(props) {
  const {
    t, status, loading, error, notice, view, selected, mode, plan, planError, planning, restoring, result, exactAck,
    snapshotting, draft, saving, issues, settingsError, locale, position, panelRef,
    onClose, onRefresh, onTimeline, onSettings, onBack, onSnapshot, onSelect, onMode, onReplan, onExactAck, onCancel, onConfirm,
    onDone, onDraft, onSaveSettings, sessionId,
  } = props
  const body = (() => {
    if (status === null || status === undefined) {
      if (loading) return h('div', { className: 'dtm_state' }, h(DtmSpinner, { label: t('panel.loading') }))
      if (error !== null && error !== undefined) {
        return h(
          'div',
          { className: 'dtm_state' },
          h(DtmBanner, { kind: 'error' }, errorMessageOf(error, t)),
          h(DtmButton, { variant: 'soft', onClick: onRefresh }, t('panel.retry'))
        )
      }
      return h('div', { className: 'dtm_state' }, h(DtmSpinner, { label: t('panel.loading') }))
    }
    if (view === 'settings') {
      return h(SettingsView, {
        t,
        draft,
        saving,
        issues,
        error: settingsError === null || settingsError === undefined ? undefined : errorMessageOf(settingsError, t),
        onChange: onDraft,
        onSave: onSaveSettings,
      })
    }
    if (view === 'confirm') {
      return h(ConfirmView, {
        t,
        locale,
        selected,
        mode,
        plan,
        planning,
        planError,
        restoring,
        exactAck,
        busy: status.busy,
        onMode,
        onReplan,
        onExactAck,
        onCancel,
        onConfirm,
      })
    }
    if (view === 'result') {
      return h(ResultView, { t, result, onDone })
    }
    return h(TimelineView, {
      t,
      status,
      locale,
      sessionId,
      snapshotting,
      onSnapshot,
      onSelect,
    })
  })()

  return h(
    'section',
    {
      className: 'dtm_panel',
      ref: panelRef,
      role: 'dialog',
      'aria-label': t('panel.title'),
      'aria-modal': 'false',
      'data-view': view,
      style: position ?? undefined,
    },
    h(PanelHeader, {
      t,
      status,
      view,
      loading,
      restoring,
      onRefresh,
      onClose,
      onTimeline,
      onSettings,
      onBack,
    }),
    h(
      'div',
      { className: 'dtm_panelBody' },
      h(CommonBanners, {
        t,
        status,
        notice,
        error,
        onRetry: onRefresh,
      }),
      body
    )
  )
}

export function TimeMachineAction(props) {
  const t = typeof props.t === 'function' ? props.t : (key) => key
  const sessionId = props.sessionId
  const api = useStableApi()
  const [open, setOpen] = React.useState(false)
  const [status, setStatus] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [notice, setNotice] = React.useState(null)
  const [view, setView] = React.useState('timeline')
  const [selected, setSelected] = React.useState(null)
  const [mode, setMode] = React.useState('overwrite')
  const [plan, setPlan] = React.useState(null)
  const [planError, setPlanError] = React.useState(null)
  const [planning, setPlanning] = React.useState(false)
  const [restoring, setRestoring] = React.useState(false)
  const [result, setResult] = React.useState(null)
  const [exactAck, setExactAck] = React.useState(false)
  const [snapshotting, setSnapshotting] = React.useState(false)
  const [draft, setDraft] = React.useState(null)
  const [saving, setSaving] = React.useState(false)
  const [issues, setIssues] = React.useState([])
  const [settingsError, setSettingsError] = React.useState(null)
  const rootRef = React.useRef(null)
  const triggerRef = React.useRef(null)
  const panelRef = React.useRef(null)
  const position = useAnchorPosition(triggerRef, open)
  const refreshSeq = React.useRef(0)
  const planSeq = React.useRef(0)
  const locale = activeLocale()

  const refresh = React.useCallback(async (options = {}) => {
    if (sessionId === undefined || sessionId === null || sessionId === '') return
    const seq = refreshSeq.current + 1
    refreshSeq.current = seq
    if (options.quiet !== true) setLoading(true)
    try {
      const next = await api.status(sessionId)
      if (refreshSeq.current !== seq) return
      setStatus(next)
      setError(null)
    } catch (failure) {
      if (refreshSeq.current !== seq) return
      if (failure?.code !== 'ABORTED') setError(failure)
    } finally {
      if (refreshSeq.current === seq) setLoading(false)
    }
  }, [api, sessionId])

  React.useEffect(() => {
    // 会话切换：让仍在路上的 status/plan 请求失效，避免旧会话的响应写回新面板。
    refreshSeq.current += 1
    planSeq.current += 1
    setLoading(false)
    setPlanning(false)
    setOpen(false)
    setStatus(null)
    setError(null)
    setNotice(null)
    setView('timeline')
    setSelected(null)
    setPlan(null)
    setPlanError(null)
    setResult(null)
    setExactAck(false)
    setDraft(null)
    setIssues([])
    setSettingsError(null)
  }, [sessionId])

  React.useEffect(() => {
    if (open !== true) return undefined
    void refresh()
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void refresh({ quiet: true })
    }, 5000)
    return () => {
      clearInterval(timer)
    }
  }, [open, refresh])

  React.useEffect(() => {
    if (open !== true) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape' && restoring !== true) setOpen(false)
    }
    const onDown = (event) => {
      const target = event.target
      if (rootRef.current !== null && rootRef.current.contains(target)) return
      if (panelRef.current !== null && panelRef.current.contains(target)) return
      if (restoring !== true) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown, true)
    }
  }, [open, restoring])

  const loadPlan = React.useCallback(async (checkpointId, nextMode) => {
    const seq = planSeq.current + 1
    planSeq.current = seq
    setPlanning(true)
    setPlan(null)
    setPlanError(null)
    try {
      const payload = await api.plan(sessionId, checkpointId, nextMode)
      if (planSeq.current === seq) setPlan(payload.plan)
    } catch (failure) {
      if (planSeq.current === seq && failure?.code !== 'ABORTED') setPlanError(failure)
    } finally {
      if (planSeq.current === seq) setPlanning(false)
    }
  }, [api, sessionId])

  const selectCheckpoint = (entry) => {
    setSelected(entry)
    setView('confirm')
    setMode('overwrite')
    setExactAck(false)
    setResult(null)
    setNotice(null)
    void loadPlan(entry.id, 'overwrite')
  }

  const changeMode = (nextMode) => {
    if (nextMode === mode || planning || restoring) return
    setMode(nextMode)
    setExactAck(false)
    if (selected !== null) void loadPlan(selected.id, nextMode)
  }

  const replan = () => {
    if (selected !== null) void loadPlan(selected.id, mode)
  }

  const confirmRestore = async () => {
    if (plan === null || restoring || status?.busy === true) return
    if (mode === 'exact' && exactAck !== true) return
    setRestoring(true)
    setPlanError(null)
    try {
      const payload = await api.restore(sessionId, plan.planId)
      setResult(payload.result)
      setView('result')
      setPlan(null)
      setExactAck(false)
      setNotice(null)
      void refresh({ quiet: true })
    } catch (failure) {
      if (failure?.code !== 'ABORTED') {
        setPlanError(failure)
        setPlan(null)
      }
      void refresh({ quiet: true })
    } finally {
      setRestoring(false)
    }
  }

  const createSnapshot = async () => {
    if (snapshotting) return
    setSnapshotting(true)
    setNotice(null)
    try {
      const payload = await api.checkpoint(sessionId)
      setNotice(t('panel.snapshotDone', { id: shortCheckpointId(payload.checkpoint.id) }))
      await refresh({ quiet: true })
    } catch (failure) {
      if (failure?.code !== 'ABORTED') setError(failure)
    } finally {
      setSnapshotting(false)
    }
  }

  const openSettings = () => {
    if (status === null) return
    setDraft(settingsDraftOf(status.settings))
    setIssues([])
    setSettingsError(null)
    setNotice(null)
    setView('settings')
  }

  const saveSettings = async (config) => {
    if (saving) return
    setSaving(true)
    setSettingsError(null)
    setNotice(null)
    try {
      const payload = await api.saveConfig(sessionId, config)
      setDraft(settingsDraftOf(payload.config))
      setStatus((previous) => (previous === null ? previous : { ...previous, settings: payload.config }))
      setIssues(Array.isArray(payload.issues) ? payload.issues : [])
      setNotice(t('panel.settings.saved'))
    } catch (failure) {
      if (failure?.code !== 'ABORTED') setSettingsError(failure)
    } finally {
      setSaving(false)
    }
  }

  const backToTimeline = () => {
    if (restoring) return
    setView('timeline')
    setSelected(null)
    setPlan(null)
    setPlanError(null)
    setResult(null)
    setExactAck(false)
    setNotice(null)
    void refresh({ quiet: true })
  }

  const toggleOpen = () => {
    if (!open) {
      setView('timeline')
      setSelected(null)
      setPlan(null)
      setPlanError(null)
      setError(null)
      setNotice(null)
      setResult(null)
      setExactAck(false)
      setMode('overwrite')
    }
    setOpen((value) => !value)
  }

  const panel = open
    ? ReactDOM.createPortal(
        h(TimeMachinePanel, {
          t,
          status,
          loading,
          error,
          notice,
          view,
          selected,
          mode,
          plan,
          planError,
          planning,
          restoring,
          result,
          exactAck,
          snapshotting,
          draft,
          saving,
          issues,
          settingsError,
          locale,
          position,
          panelRef,
          sessionId,
          onClose: () => {
            if (!restoring) setOpen(false)
          },
          onRefresh: () => {
            void refresh()
          },
          onTimeline: backToTimeline,
          onSettings: openSettings,
          onBack: backToTimeline,
          onSnapshot: createSnapshot,
          onSelect: selectCheckpoint,
          onMode: changeMode,
          onReplan: replan,
          onExactAck: setExactAck,
          onCancel: backToTimeline,
          onConfirm: confirmRestore,
          onDone: backToTimeline,
          onDraft: setDraft,
          onSaveSettings: saveSettings,
        }),
        document.body
      )
    : null

  if (sessionId === undefined || sessionId === null || sessionId === '') return null

  return h(
    React.Fragment,
    null,
    h(
      'span',
      { className: 'dtm_root', ref: rootRef, 'data-time-machine': true },
      h(
        'button',
        {
          type: 'button',
          ref: triggerRef,
          className: 'dtm_trigger',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': t('action.aria'),
          title: t('action.aria'),
          onClick: toggleOpen,
        },
        h(IconHistory, { size: 14 }),
        h('span', { className: 'dtm_triggerText' }, t('action.label'))
      )
    ),
    panel
  )
}
