/** 时光机图标：全部是 currentColor 的内联 SVG，不引入图标包。 */

function iconProps(size) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  }
}

export function IconHistory(props) {
  const size = props?.size ?? 16
  return React.createElement(
    'svg',
    { ...iconProps(size), className: props?.className },
    React.createElement('path', { d: 'M3.5 12a8.5 8.5 0 1 0 2.2-5.7' }),
    React.createElement('path', { d: 'M3.5 4.8v4.4h4.4' }),
    React.createElement('path', { d: 'M12 7.5V12l3.2 2' })
  )
}

export function IconClose(props) {
  const size = props?.size ?? 15
  return React.createElement(
    'svg',
    { ...iconProps(size), className: props?.className },
    React.createElement('path', { d: 'M6 6l12 12M18 6L6 18' })
  )
}

export function IconRefresh(props) {
  const size = props?.size ?? 14
  return React.createElement(
    'svg',
    { ...iconProps(size), className: props?.className },
    React.createElement('path', { d: 'M20 12a8 8 0 0 1-13.7 5.6' }),
    React.createElement('path', { d: 'M4.3 21v-3.4h3.4' }),
    React.createElement('path', { d: 'M4 12a8 8 0 0 1 13.7-5.6' }),
    React.createElement('path', { d: 'M19.7 3v3.4h-3.4' })
  )
}

export function IconTune(props) {
  const size = props?.size ?? 14
  return React.createElement(
    'svg',
    { ...iconProps(size), className: props?.className },
    React.createElement('path', { d: 'M4 7h16M4 12h16M4 17h16' }),
    React.createElement('circle', { cx: 9, cy: 7, r: 1.8, fill: 'currentColor', stroke: 'none' }),
    React.createElement('circle', { cx: 15, cy: 12, r: 1.8, fill: 'currentColor', stroke: 'none' }),
    React.createElement('circle', { cx: 8, cy: 17, r: 1.8, fill: 'currentColor', stroke: 'none' })
  )
}

export function IconCameraPlus(props) {
  const size = props?.size ?? 15
  return React.createElement(
    'svg',
    { ...iconProps(size), className: props?.className },
    React.createElement('path', { d: 'M4 8.5h3l1.4-2h7.2L17 8.5h3v10H4z' }),
    React.createElement('circle', { cx: 12, cy: 13.2, r: 3.2 }),
    React.createElement('path', { d: 'M12 10v6.4M8.8 13.2h6.4' })
  )
}

export function IconShield(props) {
  const size = props?.size ?? 15
  return React.createElement(
    'svg',
    { ...iconProps(size), className: props?.className },
    React.createElement('path', { d: 'M12 3.5l7 2.6v5.3c0 4.5-3 7.6-7 9.1-4-1.5-7-4.6-7-9.1V6.1z' }),
    React.createElement('path', { d: 'M8.8 12.2l2.1 2.1 4.3-4.5' })
  )
}

export function IconWarning(props) {
  const size = props?.size ?? 14
  return React.createElement(
    'svg',
    { ...iconProps(size), className: props?.className },
    React.createElement('path', { d: 'M12 3.8l9 16.2H3z' }),
    React.createElement('path', { d: 'M12 9.5v4.6M12 17.2v.2' })
  )
}

export function IconArrowLeft(props) {
  const size = props?.size ?? 14
  return React.createElement(
    'svg',
    { ...iconProps(size), className: props?.className },
    React.createElement('path', { d: 'M19 12H5M11 6l-6 6 6 6' })
  )
}

export function IconChevronRight(props) {
  const size = props?.size ?? 14
  return React.createElement(
    'svg',
    { ...iconProps(size), className: props?.className },
    React.createElement('path', { d: 'M9 5l7 7-7 7' })
  )
}

export function IconCheck(props) {
  const size = props?.size ?? 16
  return React.createElement(
    'svg',
    { ...iconProps(size), className: props?.className },
    React.createElement('path', { d: 'M4.5 12.5l5 5L19.5 6.8' })
  )
}

export function IconDot(props) {
  const size = props?.size ?? 7
  return React.createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 8 8',
      fill: 'currentColor',
      'aria-hidden': 'true',
      focusable: 'false',
      className: props?.className,
    },
    React.createElement('circle', { cx: 4, cy: 4, r: 4 })
  )
}

export function IconSpinner(props) {
  const size = props?.size ?? 14
  return React.createElement(
    'svg',
    {
      ...iconProps(size),
      className: `dtm_spin ${props?.className ?? ''}`.trim(),
    },
    React.createElement('path', { d: 'M12 3.5a8.5 8.5 0 1 1-6 2.5' })
  )
}
