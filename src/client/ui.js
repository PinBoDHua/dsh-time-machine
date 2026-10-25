/** 客户端小部件：按钮、横幅、加载态。用 h() 而不是 JSX，构建器无需转译。 */

export const h = React.createElement

export function DtmBanner(props) {
  return h(
    'div',
    { className: 'dtm_banner', 'data-kind': props.kind ?? 'info', role: props.role ?? 'status' },
    h('span', { className: 'dtm_bannerText' }, props.children),
    props.action ?? null
  )
}

export function DtmButton(props) {
  return h(
    'button',
    {
      type: props.type ?? 'button',
      className: `dtm_button ${props.className ?? ''}`.trim(),
      'data-variant': props.variant ?? 'ghost',
      'data-size': props.size ?? 'md',
      disabled: props.disabled === true,
      onClick: props.disabled === true ? undefined : props.onClick,
      title: props.title,
      'aria-label': props.ariaLabel,
    },
    props.children
  )
}

export function DtmIconButton(props) {
  return h(
    'button',
    {
      type: 'button',
      className: `dtm_iconButton ${props.className ?? ''}`.trim(),
      'aria-label': props.label,
      title: props.label,
      disabled: props.disabled === true,
      onClick: props.disabled === true ? undefined : props.onClick,
    },
    props.children
  )
}

export function DtmSpinner(props) {
  return h(
    'span',
    { className: 'dtm_loading', role: 'status' },
    h('span', { className: 'dtm_spinner', 'aria-hidden': 'true' }),
    props.label === undefined ? null : h('span', null, props.label)
  )
}
