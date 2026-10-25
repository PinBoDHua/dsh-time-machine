import { DEFAULT_CONFIG } from '../../shared/protocol.js'
import { DtmBanner, DtmButton, DtmSpinner, h } from './ui.js'

export function settingsDraftOf(settings) {
  const source = settings ?? DEFAULT_CONFIG
  return {
    auto: source.auto !== false,
    beforeTurn: source.beforeTurn !== false,
    afterTurn: source.afterTurn !== false,
    maxCheckpoints: String(source.maxCheckpoints ?? DEFAULT_CONFIG.maxCheckpoints),
    maxAgeDays: String(source.maxAgeDays ?? DEFAULT_CONFIG.maxAgeDays),
    timeoutMs: String(source.timeoutMs ?? DEFAULT_CONFIG.timeoutMs),
    excludesText: Array.isArray(source.excludes) ? source.excludes.join('\n') : DEFAULT_CONFIG.excludes.join('\n'),
  }
}

export function settingsPayloadOf(draft) {
  return {
    auto: draft.auto === true,
    beforeTurn: draft.beforeTurn === true,
    afterTurn: draft.afterTurn === true,
    maxCheckpoints: Number(draft.maxCheckpoints),
    maxAgeDays: Number(draft.maxAgeDays),
    timeoutMs: Number(draft.timeoutMs),
    excludes: String(draft.excludesText ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#')),
  }
}

function DtmSwitch(props) {
  return h(
    'button',
    {
      type: 'button',
      role: 'switch',
      className: 'dtm_switch',
      'aria-checked': props.checked === true,
      'aria-label': props.label,
      'data-on': props.checked === true ? 'true' : 'false',
      disabled: props.disabled === true,
      onClick: () => {
        if (props.disabled !== true) props.onChange(props.checked !== true)
      },
    },
    h('span', { className: 'dtm_switchThumb', 'aria-hidden': 'true' })
  )
}

function DtmField(props) {
  return h(
    'div',
    { className: 'dtm_field', 'data-field': props.name },
    h(
      'div',
      { className: 'dtm_fieldCopy' },
      h('div', { className: 'dtm_fieldTitle' }, props.title),
      h('div', { className: 'dtm_fieldHint' }, props.hint)
    ),
    h('div', { className: 'dtm_fieldControl' }, props.children)
  )
}

function DtmNumberInput(props) {
  return h('input', {
    type: 'number',
    className: 'dtm_input',
    value: props.value,
    min: props.min,
    max: props.max,
    step: props.step ?? 1,
    'aria-label': props.label,
    onChange: (event) => props.onChange(event.target.value),
  })
}

export function SettingsView(props) {
  const { t, draft, saving, issues, error, onChange, onSave } = props
  if (draft === null || draft === undefined) {
    return h('div', { className: 'dtm_view' }, h(DtmSpinner, { label: t('panel.loading') }))
  }
  return h(
    'div',
    { className: 'dtm_view dtm_settings' },
    h('div', { className: 'dtm_viewTitle', style: { marginBottom: '2px' } }, t('panel.settings.title')),
    h('p', { className: 'dtm_viewHint' }, t('panel.settings.global')),
    error === null || error === undefined ? null : h(DtmBanner, { kind: 'error' }, error),
    issues !== undefined && issues.length > 0
      ? h(
          DtmBanner,
          { kind: 'warning' },
          h(
            'span',
            null,
            issues.map((issue, index) => h('span', { key: `${String(index)}:${issue}` }, t('panel.settings.issue', { issue }), index < issues.length - 1 ? ' ' : ''))
          )
        )
      : null,

    h(
      DtmField,
      { name: 'auto', title: t('panel.settings.auto'), hint: t('panel.settings.autoHint') },
      h(DtmSwitch, {
        checked: draft.auto,
        label: t('panel.settings.auto'),
        onChange: (value) => onChange({ ...draft, auto: value }),
      })
    ),
    h(
      'div',
      { className: 'dtm_fieldGroup', 'data-disabled': draft.auto ? 'false' : 'true' },
      h(
        DtmField,
        { name: 'before', title: t('panel.settings.before'), hint: '' },
        h(DtmSwitch, {
          checked: draft.beforeTurn,
          label: t('panel.settings.before'),
          disabled: !draft.auto,
          onChange: (value) => onChange({ ...draft, beforeTurn: value }),
        })
      ),
      h(
        DtmField,
        { name: 'after', title: t('panel.settings.after'), hint: '' },
        h(DtmSwitch, {
          checked: draft.afterTurn,
          label: t('panel.settings.after'),
          disabled: !draft.auto,
          onChange: (value) => onChange({ ...draft, afterTurn: value }),
        })
      )
    ),
    h(
      DtmField,
      { name: 'max', title: t('panel.settings.max'), hint: t('panel.settings.maxUnit') },
      h(DtmNumberInput, {
        value: draft.maxCheckpoints,
        min: 10,
        max: 1000,
        label: t('panel.settings.max'),
        onChange: (value) => onChange({ ...draft, maxCheckpoints: value }),
      })
    ),
    h(
      DtmField,
      { name: 'age', title: t('panel.settings.age'), hint: t('panel.settings.ageUnit') },
      h(DtmNumberInput, {
        value: draft.maxAgeDays,
        min: 1,
        max: 365,
        label: t('panel.settings.age'),
        onChange: (value) => onChange({ ...draft, maxAgeDays: value }),
      })
    ),
    h(
      DtmField,
      { name: 'timeout', title: t('panel.settings.timeout'), hint: t('panel.settings.timeoutUnit') },
      h(DtmNumberInput, {
        value: draft.timeoutMs,
        min: 5000,
        max: 120000,
        step: 1000,
        label: t('panel.settings.timeout'),
        onChange: (value) => onChange({ ...draft, timeoutMs: value }),
      })
    ),
    h(
      'div',
      { className: 'dtm_field dtm_fieldBlock', 'data-field': 'excludes' },
      h(
        'div',
        { className: 'dtm_fieldCopy' },
        h('div', { className: 'dtm_fieldTitle' }, t('panel.settings.excludes')),
        h('div', { className: 'dtm_fieldHint' }, t('panel.settings.excludesHint'))
      ),
      h('textarea', {
        className: 'dtm_textarea',
        rows: 5,
        value: draft.excludesText,
        'aria-label': t('panel.settings.excludes'),
        spellCheck: false,
        onChange: (event) => onChange({ ...draft, excludesText: event.target.value }),
      })
    ),
    h(
      'div',
      { className: 'dtm_actions' },
      h(
        DtmButton,
        {
          variant: 'primary',
          disabled: saving,
          onClick: () => onSave(settingsPayloadOf(draft)),
        },
        saving ? h(React.Fragment, null, h(DtmSpinner, null), t('panel.settings.saving')) : t('panel.settings.save')
      )
    )
  )
}
