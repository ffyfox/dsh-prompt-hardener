/**
 * dsh-prompt-hardener — 浏览器半边。
 *
 * 在输入框控制行（`conversation.input.left`）挂一根「力量条」：五格硬度。面板上不养闲字。
 *
 * 几点刻意的取舍：
 * - **不接管输入框**。DSH 没有官方的"发送前钩子"；同类插件是靠捕获阶段 keydown +
 *   向上找 contenteditable 祖先 hack 出来的，随客户端升级容易坏。本插件的改写发生在
 *   host 侧 `agent/pre-step`，所以这里只做开关和读数，不碰 composer、不改发送链路。
 * - **只用主题变量**（--dsw-alias-*）着色，深浅色主题都跟着走。
 * - **不用任何 Harness Client 包当模块**，只 require('react')；React 由页面的模块表
 *   提供，避免打包出第二份 React。
 * - 五格硬度那一行是整幅面板宽，按钮文字不省略 —— "丧心病狂"四个字必须完整显示；
 *   收起的药丸上用短标签，免得把窄窄的输入框控制行撑变形。
 *
 * @module dsh-prompt-hardener/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-prompt-hardener',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 必须等于 host 包名：模块表按包身份对账。 */
    const name = 'dsh-prompt-hardener'

    /** host 注册的状态路由。 */
    const STATE_ROUTE = '/plugins/dsh-prompt-hardener/state.json'

    /** 语言域命名空间。 */
    const NS = 'prompt-hardener'

    /** 五档硬度，从弱到强。 */
    const LEVELS = ['off', 'light', 'standard', 'brutal', 'insane']

    /** 收起的药丸上用短标签，避免撑变形输入框控制行。 */
    const SHORT = { off: '关', light: '轻', standard: '中', brutal: '重', insane: '狂' }

    const DICT = {
      zh: {
        label: '硬邦邦',
        title: '硬邦邦！！！',
        hint: '按！提示词！把！需求！全量重写！看得！硬邦邦！！！！',
        level: '硬度',
        off: '关',
        light: '轻',
        standard: '中',
        brutal: '重',
        insane: '丧心病狂',
        unreachable: '读不到 host 状态',
      },
      en: {
        label: 'Muscle',
        title: '硬邦邦！！！',
        hint: '按！提示词！把！需求！全量重写！看得！硬邦邦！！！！',
        level: '硬度',
        off: 'Off',
        light: 'Light',
        standard: 'Medium',
        brutal: 'Heavy',
        insane: 'Insane',
        unreachable: 'Cannot read host state',
      },
    }

    /** 五档对应的主题变量，深浅色主题下自动切换。 */
    const ACCENT = {
      off: 'var(--dsw-alias-label-tertiary)',
      light: 'var(--dsw-alias-state-success-primary)',
      standard: 'var(--dsw-alias-state-warn-primary)',
      brutal: 'var(--dsw-alias-brand-primary)',
      insane: 'var(--dsw-alias-state-error-primary)',
    }

    const CSS = `
.ybb-root { position: relative; display: inline-flex; align-items: center; }
.ybb-pill {
  display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 13px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font-size: 12px; line-height: 1; cursor: pointer; white-space: nowrap;
}
.ybb-pill:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ybb-pill[data-open="true"] { background: var(--dsw-alias-interactive-bg-active); }
.ybb-bars { display: inline-flex; align-items: flex-end; gap: 2px; height: 12px; }
.ybb-bar { width: 3px; border-radius: 1px; background: currentColor; opacity: .25; }
.ybb-bar[data-on="true"] { opacity: 1; }
.ybb-bar[data-i="0"] { height: 4px; }
.ybb-bar[data-i="1"] { height: 6px; }
.ybb-bar[data-i="2"] { height: 8px; }
.ybb-bar[data-i="3"] { height: 10px; }
.ybb-bar[data-i="4"] { height: 12px; }
.ybb-panel {
  position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 40; width: 340px;
  padding: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary);
  box-shadow: 0 8px 28px rgb(0 0 0 / 22%); font-size: 12px;
}
.ybb-title { font-size: 13px; font-weight: 600; margin-bottom: 2px; }
.ybb-hint { color: var(--dsw-alias-label-tertiary); line-height: 1.5; margin-bottom: 10px; }
.ybb-rowlabel { display: block; color: var(--dsw-alias-label-secondary); margin-bottom: 6px; }
.ybb-seg { display: flex; gap: 4px; }
.ybb-segbtn {
  flex: 1 1 0; min-width: 0; height: 28px; padding: 0 2px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2); background: transparent;
  color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ybb-segbtn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ybb-segbtn[data-on="true"] {
  color: var(--dsw-alias-label-primary-foreground);
  border-color: transparent;
}
.ybb-warn {
  border-top: 1px solid var(--dsw-alias-border-l1); margin-top: 12px; padding-top: 8px;
  color: var(--dsw-alias-label-error); line-height: 1.6; word-break: break-all;
}
`

    /**
     * 挂一份样式表；HMR 重复 apply 时先拆旧的，不留残留。
     * @returns {() => void} 清理函数。
     */
    function mountStyles() {
      const id = `${NS}-style`
      const previous = document.getElementById(id)
      if (previous && typeof previous.remove === 'function') previous.remove()
      const tag = document.createElement('style')
      tag.id = id
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        if (typeof tag.remove === 'function') tag.remove()
        else if (tag.parentNode) tag.parentNode.removeChild(tag)
      }
    }

    /** 容错的 GET。host 没起路由时静默返回 null。 */
    async function fetchState() {
      const res = await fetch(STATE_ROUTE, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      return data && data.ok ? data.state : null
    }

    /** 容错的 PUT。 */
    async function pushState(patch) {
      const res = await fetch(STATE_ROUTE, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: patch }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      return data && data.ok ? data.state : null
    }

    /**
     * 力量条本体。
     * @returns {object} React 元素工厂。
     */
    function makeControl(t) {
      return function Control() {
        const [open, setOpen] = React.useState(false)
        const [state, setState] = React.useState({
          enabled: true,
          intensity: 'standard',
          llm: {},
          stats: {},
          prompt: {},
        })
        const [error, setError] = React.useState('')
        const rootRef = React.useRef(null)

        React.useEffect(() => {
          let alive = true
          fetchState()
            .then((next) => {
              if (alive && next) setState((prev) => ({ ...prev, ...next }))
            })
            .catch(() => {
              /* host 路由还没就绪时保持默认外观，不打扰用户 */
            })
          return () => {
            alive = false
          }
        }, [])

        React.useEffect(() => {
          if (!open) return undefined
          const onDown = (event) => {
            const root = rootRef.current
            if (root && event.target instanceof Node && !root.contains(event.target)) setOpen(false)
          }
          const onKey = (event) => {
            if (event.key === 'Escape') setOpen(false)
          }
          document.addEventListener('mousedown', onDown, true)
          document.addEventListener('keydown', onKey, true)
          return () => {
            document.removeEventListener('mousedown', onDown, true)
            document.removeEventListener('keydown', onKey, true)
          }
        }, [open])

        const commit = (patch) => {
          setState((prev) => ({ ...prev, ...patch }))
          pushState(patch)
            .then((next) => {
              setError('')
              if (next) setState((prev) => ({ ...prev, ...next }))
            })
            .catch((err) => setError(String((err && err.message) || err)))
        }

        const level = state.enabled === false ? 'off' : (state.intensity || 'standard')
        const activeIndex = Math.max(0, LEVELS.indexOf(level))
        const accent = ACCENT[level] || ACCENT.standard
        const bars = h('span', { className: 'ybb-bars', 'aria-hidden': true },
          LEVELS.map((_, i) => h('span', {
            key: i,
            className: 'ybb-bar',
            'data-i': String(i),
            'data-on': String(i <= activeIndex),
          })))

        const pill = h('button', {
          type: 'button',
          className: 'ybb-pill',
          style: { color: accent },
          'data-open': String(open),
          title: t('title'),
          'aria-expanded': open,
          onClick: () => setOpen((v) => !v),
        }, bars, h('span', null, `${t('label')}·${SHORT[level] || t(level)}`))

        if (!open) return h('span', { className: 'ybb-root', ref: rootRef }, pill)

        const seg = h('div', { className: 'ybb-seg' }, LEVELS.map((id) => h('button', {
          key: id,
          type: 'button',
          className: 'ybb-segbtn',
          'data-on': String(id === level),
          style: id === level ? { background: ACCENT[id] } : undefined,
          title: t(id),
          onClick: () => commit({ enabled: id !== 'off', intensity: id === 'off' ? state.intensity : id }),
        }, t(id))))

        const panel = h('div', { className: 'ybb-panel', role: 'dialog', 'aria-label': t('title') },
          h('div', { className: 'ybb-title' }, t('title')),
          h('div', { className: 'ybb-hint' }, t('hint')),
          h('span', { className: 'ybb-rowlabel' }, t('level')),
          seg,
          // 面板上不养闲字：统计与提示词信息整块删除。
          // 只留这一行，而且只有真出问题时才出现（路由读不到 / 写不进去）。
          error ? h('div', { className: 'ybb-warn' }, `${t('unreachable')}: ${error}`) : null)

        return h('span', { className: 'ybb-root', ref: rootRef }, pill, panel)
      }
    }

    return {
      name,
      inject: ['slots', 'locale'],
      /**
       * 客户端插件入口。
       * @param {object} ctx 浏览器侧 cordis 上下文。
       */
      apply(ctx) {
        // HMR 会重跑 apply 而不先卸载旧实例：先拆掉上一份，避免 slot 重复注册。
        try {
          if (typeof window.__YBB_OPTIMIZER_DISPOSE__ === 'function') window.__YBB_OPTIMIZER_DISPOSE__()
        } catch {
          /* 旧实例已经烂了也不影响新实例 */
        }
        const disposers = []
        const own = (fn, label) => {
          const dispose = ctx.effect(fn, label)
          disposers.push(typeof dispose === 'function' ? dispose : () => {})
        }
        window.__YBB_OPTIMIZER_DISPOSE__ = () => {
          for (const dispose of disposers.splice(0)) {
            try {
              dispose()
            } catch {
              /* 逐个拆，坏一个不影响其余 */
            }
          }
        }

        own(() => ctx.locale.register(NS, DICT), `${NS}: dictionaries`)
        const t = ctx.locale.bind(NS)
        own(() => mountStyles(), `${NS}: styles`)
        own(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: NS,
          order: 30,
          label: () => t('label'),
        }, makeControl(t))), `${NS}: composer control`)
      },
    }
  },
})
