import { PLUGIN_ID } from '../../shared/protocol.js'
import { en, zh } from './locales.js'
import { TimeMachineAction } from './panel.js'
import { STYLES } from './styles.generated.js'

export const name = PLUGIN_ID
export const inject = ['slots', 'locale']

const STYLE_TAG_ID = `${PLUGIN_ID}/client.css`
const HEADER_SLOT = 'conversation.session.header.actions'

function mountStyles() {
  if (typeof document === 'undefined') return false
  const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`)
  if (existing !== null) {
    // HMR/插件热重载后 bundle 已是新代码，但 style 标签还留着旧 CSS。
    // 复用标签时同步内容，避免开发期或升级后样式停留在旧版本。
    if (existing.textContent !== STYLES) existing.textContent = STYLES
    return false
  }
  const tag = document.createElement('style')
  tag.dataset.plugin = PLUGIN_ID
  tag.dataset.pluginCss = STYLE_TAG_ID
  tag.textContent = STYLES
  document.head.appendChild(tag)
  return true
}

export function apply(ctx) {
  ctx.effect(() => {
    const created = mountStyles()
    return () => {
      if (!created || typeof document === 'undefined') return
      const tag = document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`)
      if (tag !== null) tag.remove()
    }
  }, `${PLUGIN_ID}: styles`)

  ctx.effect(() => ctx.locale.register(PLUGIN_ID, { zh, en }), `${PLUGIN_ID}: locale`)

  ctx.slots.inject(HEADER_SLOT, () =>
    ctx.slots.register(
      {
        name: HEADER_SLOT,
        id: PLUGIN_ID,
        order: 40,
        locale: PLUGIN_ID,
      },
      TimeMachineAction
    )
  )
}
