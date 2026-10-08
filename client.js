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

    /** host 注册的审查路由：POST 求候选定稿，PUT 登记"这条我确认过了"。 */
    const REVIEW_ROUTE = '/plugins/dsh-prompt-hardener/review'

    /** 语言域命名空间。 */
    const NS = 'prompt-hardener'

    /** 两档发送模式：自动（老行为）/ 审查（先过一眼）。 */
    const MODES = ['auto', 'review']

    /**
     * 审查请求的客户端超时。
     *
     * 宿主的模型调用自己有 30 秒上限，这里留出余量；超过就当作"没人回音"落到失败态。
     * 没有这道闸的话，请求一旦卡住（路由没注册、服务僵住），卡片会**永远**停在"改写中"，
     * 用户除了关掉它没有任何出路 —— 真机上踩到过。
     */
    const REVIEW_TIMEOUT_MS = 45000

    /**
     * 放行登记（`PUT /review`）的超时。它不碰模型，本该是毫秒级；超过这个数就说明
     * 那条通道根本没回音 —— 那就别再等了，按原文把消息发出去，正文本来就在草稿里。
     */
    const RELEASE_TIMEOUT_MS = 8000

    /** 五档硬度，从弱到强。 */
    const LEVELS = ['off', 'light', 'standard', 'brutal', 'insane']

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
        mode: '发送',
        auto: '自动',
        review: '审查',
        autoHint: '自动：点了发送就直接发出，改写发生在发出之后（老行为）',
        reviewHint: '审查：点了发送先弹卡片，能看能改，确认了才真发',
        reviewTitle: '硬邦邦审查！！！',
        rewriting: '改写中…',
        fromRules: '模型没出力，这是规则兜底',
        originalLabel: '原文',
        failed: '改写失败',
        timeout: '45 秒没等到宿主的回音（宿主没在跑，或者这一步卡住了）',
        interrupted: '插件刚重载过，这次改写中断了。重试，或者按原文发出',
        releaseFailed: '发出失败',
        sending: '发出中…',
        send: '发出',
        sendOriginal: '按原文发出',
        retry: '重试',
        cancel: '撤回',
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
        mode: 'Send',
        auto: 'Auto',
        review: 'Review',
        autoHint: 'Auto: sends right away; the rewrite happens after the send (the old behaviour)',
        reviewHint: 'Review: opens a card first — read it, edit it, then send',
        reviewTitle: 'Muscle review！！！',
        rewriting: 'Rewriting…',
        fromRules: 'The model gave nothing; this is the rule-based fallback',
        originalLabel: 'Original',
        failed: 'Rewrite failed',
        timeout: 'no answer from the host within 45s (the host is not running, or this step stalled)',
        interrupted: 'The plugin just reloaded, so this rewrite was interrupted. Retry, or send the original',
        releaseFailed: 'Send failed',
        sending: 'Sending…',
        send: 'Send',
        sendOriginal: 'Send original',
        retry: 'Retry',
        cancel: 'Withdraw',
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
.ph-root { position: relative; display: inline-flex; align-items: center; }
/* 卡片开着时把自己抬到输入框那排按钮之上。
   不抬的话，宿主自己的发送键（渲染在更后面）会画在卡片上面，正好压住「发出」按钮的
   右半边 —— 真机上看得一清二楚。 */
.ph-root[data-card="true"] { z-index: 60; }
/* 但只抬自己是不够的：输入框底栏那一条（[data-composer-seat]，官方给的稳定属性）
   本身是 z-index: 7，而"滚动到底部"圆钮所在的槽位是它的**兄弟**、z-index: 8。
   聊天视图里没有任何元素创建层叠上下文（container-type: inline-size 只施加
   style + inline-size containment，不建层叠上下文 —— 见 MDN contain 的注记），
   所以 8 直接压在 7 上：我们卡片里写多高的 z-index 都出不去。
   卡片打开时把整条底栏抬到 9，卡片就自然浮在圆钮之上；关掉卡片即恢复原状，
   也仍然低于弹出菜单/对话框那一层（1100）。 */
body:has(.ph-root[data-card="true"]) [data-composer-seat] { z-index: 9; }
/* 药丸按输入框那一排官方控件的规格来。规格是量出来的，不是猜的：
   dsh-client-ui-model-selection/lib/ModelSelect.module.css 里紧挨着它的模型选择器是
   高 28px、border:none、背景透明、圆角 var(--dsw-radius-sm)（=8px）、悬停 interactive-bg-hover。
   我们原来是 1px 描边 + 13px 胶囊，在同一排里比邻居"立体"，所以去掉描边、顺齐圆角。
   注意 box-sizing：原来 26px 高 + 上下各 1px 描边 = 28px 总高；描边一去，若不显式声明
   border-box 就会塌成 26px，与旁边控件错位。 */
.ph-pill {
  box-sizing: border-box;
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 8px;
  border: none; border-radius: var(--dsw-radius-sm);
  background: transparent; color: var(--dsw-alias-label-secondary);
  font-size: 12px; line-height: 1; cursor: pointer; white-space: nowrap;
}
.ph-pill:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ph-pill[data-open="true"] { background: var(--dsw-alias-interactive-bg-active); }
.ph-bars { display: inline-flex; align-items: flex-end; gap: 2px; height: 12px; }
.ph-bar { width: 3px; border-radius: 1px; background: currentColor; opacity: .25; }
.ph-bar[data-on="true"] { opacity: 1; }
.ph-bar[data-i="0"] { height: 4px; }
.ph-bar[data-i="1"] { height: 6px; }
.ph-bar[data-i="2"] { height: 8px; }
.ph-bar[data-i="3"] { height: 10px; }
.ph-bar[data-i="4"] { height: 12px; }
.ph-panel {
  position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 40; width: 340px;
  padding: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary);
  box-shadow: 0 8px 28px rgb(0 0 0 / 22%); font-size: 12px;
}
.ph-title { font-size: 13px; font-weight: 600; margin-bottom: 2px; }
.ph-hint { color: var(--dsw-alias-label-tertiary); line-height: 1.5; margin-bottom: 10px; }
.ph-rowlabel { display: block; color: var(--dsw-alias-label-secondary); margin-bottom: 6px; }
.ph-seg { display: flex; gap: 4px; }
.ph-segbtn {
  flex: 1 1 0; min-width: 0; height: 28px; padding: 0 2px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2); background: transparent;
  color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ph-segbtn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ph-segbtn[data-on="true"] {
  color: var(--dsw-alias-label-primary-foreground);
  border-color: transparent;
}
.ph-warn {
  border-top: 1px solid var(--dsw-alias-border-l1); margin-top: 12px; padding-top: 8px;
  color: var(--dsw-alias-label-error); line-height: 1.6; word-break: break-all;
}
/* 审查卡片。它比设置面板高得多（要装一段可编辑的正文），所以宽度按视口收一下，
   免得窄窗口里从输入框左下角往右顶出屏幕。 */
.ph-card {
  position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 41;
  width: min(460px, calc(100vw - 48px));
  padding: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary);
  box-shadow: 0 8px 28px rgb(0 0 0 / 22%); font-size: 12px;
}
.ph-cardtitle {
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
  font-size: 13px; font-weight: 600; margin-bottom: 8px;
}
.ph-badge { font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-tertiary); }
.ph-orig {
  color: var(--dsw-alias-label-tertiary); line-height: 1.55; margin-bottom: 8px;
  max-height: 56px; overflow: auto; white-space: pre-wrap; word-break: break-word;
}
/* 92px 是原来"正文 + 下面那行字数统计"里的正文部分高度；字数统计整行删掉后，
   把空出来的 34px（6 上边距 + 18 行高 + 10 下边距）还给输入框，卡片总高不变。 */
.ph-edit {
  display: block; width: 100%; box-sizing: border-box; min-height: 126px; max-height: 260px;
  resize: vertical; padding: 8px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  font-family: inherit; font-size: 12px; line-height: 1.6;
}
.ph-edit:disabled { opacity: .6; }
.ph-edit:focus { outline: 1px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
/* 按钮行与正文输入框之间必须留出这段间隙。
   曾经它是**零**：那时间隙是由下面那行字数统计的上下边距"顺带"提供的，
   字数统计一删，输入框就和按钮贴死了（真机上肉眼可见的挤压感）。
   所以这条 margin-top 不是装饰，是补回来的呼吸位，别再顺手删掉。 */
.ph-actions { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; margin-top: 12px; }
.ph-btn {
  height: 28px; padding: 0 12px; border-radius: 6px; cursor: pointer; font-size: 12px;
  border: 1px solid var(--dsw-alias-border-l2); background: transparent;
  color: var(--dsw-alias-label-secondary); white-space: nowrap;
}
.ph-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ph-btn:disabled { opacity: .5; cursor: default; }
.ph-btn-primary {
  border-color: transparent; font-weight: 600;
  background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground);
}
/* 主按钮的悬停必须自己声明，而且要用官方的 hover 令牌。
   不声明会翻车：上面那条 .ph-btn:hover:not(:disabled) 与 .ph-btn-primary 权重打平
   （都是 0,3,0），胜负由书写顺序决定 —— 浅色主题下主按钮底色被换成
   interactive-bg-hover（只是 6% 黑遮罩 ≈ 透明），白字于是印在白卡片上，
   按钮"发白到和背景融为一体"。官方 Button.module.css 就是这么写的
   （.primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover) }），
   浅色主题下它是 #43454a —— 黑按钮悬停变深灰。
   这里多带一个类名让权重升一档（0,4,0），将来谁挪动规则顺序都不会再把它改坏。 */
.ph-btn.ph-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.ph-err { color: var(--dsw-alias-label-error); line-height: 1.6; margin-bottom: 8px; word-break: break-word; }
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

    /**
     * 生成"这一次发送该不该拦"的两个判据。
     *
     * 全是纯判断（DOM 一律从参数注入），所以能离线测。这套逻辑值得单独拎出来测，因为它
     * 出错的方式**很安静**：判漏一边是"审查形同虚设"，判多一边是"消息被吞掉"，
     * 两种都不会抛异常，只会在真机上表现为"怎么没反应"。
     *
     * @param {object} deps 依赖注入：`cardOf / draftOf / isOurs / buttonOf / lastButtonOf /
     *   sendLabels / stopLabels / isNode`。
     * @returns {{ wantKey: Function, wantClick: Function, buttonOf: Function }}
     */
    function createSendGuards(deps) {
      const {
        cardOf,
        draftOf,
        isOurs,
        buttonOf,
        lastButtonOf,
        sendLabels,
        stopLabels,
        isNode = (value) => typeof Node !== 'undefined' && value instanceof Node,
      } = deps

      /**
       * @param {object} event keydown 事件。
       * @returns {string|null} null = 该拦；其余是放行原因（会写进真机诊断标记）。
       */
      const wantKey = (event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return 'not-plain-enter'
        if (event.isComposing === true || event.keyCode === 229) return 'composing'
        const card = cardOf()
        if (!card) return 'no-card'
        const target = event.target
        if (!isNode(target) || typeof card.contains !== 'function' || !card.contains(target)) return 'focus-outside'
        if (isOurs(target)) return 'our-own-node'
        const draft = draftOf(card)
        // 空白一律按"没写东西"处理：draftOf 通常已经 trim 过，但判据不该依赖调用方
        // 一定这么干 —— 判错的后果是白弹一张空卡片。
        if (draft.trim().length === 0) return 'empty-draft'
        if (draft.trimStart().startsWith('/')) return 'slash-command'
        return null
      }

      /**
       * @param {object|null} button 被点的按钮。
       * @returns {string|null} null = 该拦；其余是放行原因。
       */
      const wantClick = (button) => {
        if (!button) return 'no-button'
        if (isOurs(button)) return 'our-own-button'
        const card = cardOf()
        if (!card) return 'no-card'
        if (typeof card.contains !== 'function' || !card.contains(button)) return 'button-outside-card'
        // 空草稿时主按钮是"停止生成"，绝不能吞 —— 吞了就连中断都点不动。
        if (draftOf(card).trim().length === 0) return 'empty-draft'
        const label = button.getAttribute ? button.getAttribute('aria-label') : null
        if (label && stopLabels.has(label)) return 'stop-button'
        if (label && sendLabels.has(label)) return null
        // 结构兜底：卡片里最后一个按钮就是发送键（跳过我们自己的按钮）。
        if (lastButtonOf(card) === button) return null
        return 'not-send-button'
      }

      return { wantKey, wantClick, buttonOf }
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
     * 卡片上"跳过改写、直接发出"时，到底该发哪一份正文。
     *
     * host 回的那份（`data.text`）已经洗过一遍：`!!` / `??` 前缀被剥掉了，正文也按
     * 触发前缀的语义处理过。草稿里那份还带着暗号 —— 发草稿等于把 `??` 塞进对话。
     * 只有读不到 host 那份时才退回草稿（老宿主 / 半截响应）。
     *
     * 单独拎成纯函数是因为它错起来**特别安静**：消息照样发出去了，只是内容不对，
     * 而没有任何一处会抛。
     *
     * @param {object} data host 的响应体。
     * @param {string} draft 输入框里那份。
     * @returns {string} 真正要发出去的正文。
     */
    function releaseTextFor(data, draft) {
      if (data && typeof data.text === 'string' && data.text.length > 0) return data.text
      return typeof draft === 'string' ? draft : ''
    }

    /* ─────────────────────────── 审查态（每会话一份） ─────────────────────────── */

    /**
     * 审查卡片的状态存在 window 上，而不是只放组件里。**它是唯一真相**，组件只是它的一个
     * 订阅者。
     *
     * 为什么非这样不可：控件栏是**按会话挂载**的，切会话会把它整个重挂；而 HMR 还会把整个
     * 客户端模块换一个新实例（旧组件的 React state 就此失联）。曾经的写法是"组件持有
     * React state + 顺手往 window 备份一份"，于是真机上踩到过这个坑（2026-10-02）：
     * 一次在飞的改写请求回来时，写的是 window 里那份，而**挂载着的那个组件**还在显示它
     * 自己那份旧快照 —— 卡片就永远停在"改写中"，怎么点都好不了。
     *
     * 现在改成：写一律走 `writeHold`（写袋子 + 通知所有活着的订阅者），读一律读袋子。
     * 袋子挂在 window 上，所以换会话、换实例之后大家看的还是同一份。
     */
    const HOLD_KEY = '__PROMPT_HARDENER_HOLD__'

    /** 审查态的编号；用来判断"这次请求回来时，卡片还是不是当初那一张"。 */
    let holdSeq = 0

    /** @returns {object} `{ byId, subs }`：会话 id → 审查态，以及还活着的订阅者。 */
    function holdBag() {
      try {
        let bag = window[HOLD_KEY]
        if (!bag || typeof bag !== 'object') bag = window[HOLD_KEY] = {}
        if (!bag.byId || typeof bag.byId !== 'object') bag.byId = {}
        if (!Array.isArray(bag.subs)) bag.subs = []
        return bag
      } catch {
        // 取不到袋子只影响"切会话后恢复"，拦截本身照常。
        return { byId: {}, subs: [] }
      }
    }

    /** @param {string} sessionId 会话 id。 @returns {object|null} 该会话挂着的审查态。 */
    function readHold(sessionId) {
      if (!sessionId) return null
      try {
        return holdBag().byId[sessionId] || null
      } catch {
        return null
      }
    }

    /**
     * 写回（或清掉）某个会话的审查态，并**通知所有活着的订阅者**。
     *
     * 那句通知是修"卡片永远停在改写中"的关键：在飞的请求可能由**上一个实例**发起，
     * 它回来时只写袋子；挂载着的组件必须被叫醒去重读，否则它会一直显示旧快照。
     *
     * @param {string} sessionId 会话 id。
     * @param {object|null} hold 审查态；null 表示清掉。
     */
    function writeHold(sessionId, hold) {
      if (!sessionId) return
      let subs = []
      try {
        const bag = holdBag()
        if (hold) bag.byId[sessionId] = hold
        else delete bag.byId[sessionId]
        subs = bag.subs.slice()
      } catch {
        /* 存不下只影响恢复 */
      }
      for (const notify of subs) {
        try {
          notify()
        } catch {
          /* 一个坏订阅不影响其他 */
        }
      }
    }

    /**
     * 给新卡片发一个编号。
     * @returns {number} 单调递增的编号。
     */
    function nextHoldId() {
      holdSeq += 1
      return holdSeq
    }

    /**
     * 新实例启动时，把**上一次实例留下的、还在飞的**审查态落到失败态。
     *
     * 为什么必须做：`working` / `sending` 意味着有一个上一实例发起的请求还没回来，
     * 而那次请求的结果只会写进袋子 —— 新挂载的组件即便被通知到，也等不到一个属于它的
     * 结果。卡片就会一直停在"改写中"，用户除了关掉它别无他法。
     * 换成一句说人话的失败态，正文还在（草稿从头到尾没动过），点一下就能继续。
     */
    function interruptInflightHolds() {
      try {
        const bag = holdBag()
        for (const sessionId of Object.keys(bag.byId)) {
          const hold = bag.byId[sessionId]
          if (hold && (hold.phase === 'working' || hold.phase === 'sending')) {
            bag.byId[sessionId] = { ...hold, phase: 'error', reason: 'interrupted', error: '' }
          }
        }
      } catch {
        /* 清不掉也不影响主流程 */
      }
    }

    /**
     * 力量条本体。
     * @param {Function} t 语言域绑定。
     * @param {object} ctx 浏览器侧 cordis 上下文（要借它读会话那套字典里的"发送/停止"文案）。
     * @returns {object} React 元素工厂。
     */
    function makeControl(t, ctx) {
      return function Control(props) {
        // 宿主按**标准 props** 注入。`inputActions` 是官方放行通道，`sessionId` 是作用域。
        // 拿不到 `inputActions.submit` 就**绝不拦截** —— 拦下却没有放行通道 = 把用户的消息吞掉。
        const { sessionId, inputActions } = props || {}
        const [open, setOpen] = React.useState(false)
        const [state, setState] = React.useState({
          enabled: true,
          intensity: 'standard',
          mode: 'auto',
          llm: {},
          stats: {},
          prompt: {},
        })
        const [error, setError] = React.useState('')
        const rootRef = React.useRef(null)

        // 审查卡片：`{ id, phase, original, text, source, error, startedAt, reason }`。
        // **袋子（window）才是真相，这里只是它的一个订阅者** —— 见 holdBag 的注释。
        const [hold, setHoldState] = React.useState(() => readHold(sessionId))
        /** 事件监听器里要读最新值，不能靠闭包捕获的那一份。 */
        const holdRef = React.useRef(hold)
        holdRef.current = hold
        /** 最新一次的 inputActions；它每次渲染可能是新对象，不能进 effect 依赖。 */
        const actionsRef = React.useRef(inputActions)
        actionsRef.current = inputActions
        /** 诊断计数：写了几个事件、最后一个为什么放行。真机上排"怎么没拦住"全靠它。 */
        const seenRef = React.useRef(0)

        /** 改审查态：写袋子（并通知订阅者），本实例的 state 由订阅回调统一对齐。 */
        const applyHold = React.useCallback((next) => {
          holdRef.current = next
          setHoldState(next)
          writeHold(sessionId, next)
        }, [sessionId])

        // 订阅袋子：sessionId 变了、或者被别的实例改过（HMR 后旧实例那次在飞的请求回来），
        // 都在这里被叫醒重读。**不能只在 sessionId 变化时同步一次**，那正是卡片卡死的成因。
        React.useEffect(() => {
          const bag = holdBag()
          const sync = () => {
            const next = readHold(sessionId)
            holdRef.current = next
            setHoldState(next)
          }
          bag.subs.push(sync)
          sync()
          return () => {
            const at = bag.subs.indexOf(sync)
            if (at >= 0) bag.subs.splice(at, 1)
          }
        }, [sessionId])

        // 等待期间每 500ms 把"现在几点"推进一次，好把"等了多久"显示在卡片上。
        // 有了这个，一张截图就能说明卡片停在哪一步、停了多久 —— 不需要开发者工具。
        const [nowMs, setNowMs] = React.useState(() => Date.now())
        const waiting = Boolean(hold) && (hold.phase === 'working' || hold.phase === 'sending')
        React.useEffect(() => {
          if (!waiting) return undefined
          setNowMs(Date.now())
          const timer = window.setInterval(() => setNowMs(Date.now()), 500)
          return () => window.clearInterval(timer)
        }, [waiting])

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
          if (!open && !hold) return undefined
          const onDown = (event) => {
            const root = rootRef.current
            if (root && event.target instanceof Node && !root.contains(event.target)) setOpen(false)
          }
          const onKey = (event) => {
            if (event.key !== 'Escape') return
            // 卡片挂着时 Esc = 撤回（草稿一直在输入框里，什么都没动过），不能顺着把面板也关了。
            if (holdRef.current) applyHold(null)
            else setOpen(false)
          }
          document.addEventListener('mousedown', onDown, true)
          document.addEventListener('keydown', onKey, true)
          return () => {
            document.removeEventListener('mousedown', onDown, true)
            document.removeEventListener('keydown', onKey, true)
          }
        }, [open, hold, applyHold])

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
        const mode = MODES.includes(state.mode) ? state.mode : 'auto'

        /* ─────────────────── 审查模式：拦下发送、放行定稿 ─────────────────── */

        /**
         * 拿输入卡片。优先用产品自己声明的 `data-composer-card`（精确、不靠猜），
         * 退回"从我自己往上找第一个含 contenteditable 的祖先"（不依赖任何产品类名）。
         * 找不到就一律放行 —— 不在会话页，没什么可拦的。
         */
        const composerCard = () => {
          const root = rootRef.current
          if (!root) return null
          const declared = document.querySelectorAll('[data-composer-card]')
          for (const el of declared) if (el.contains(root)) return el
          let el = root
          while (el && el !== document.body) {
            if (el.querySelector && el.querySelector('[contenteditable="true"]')) return el
            el = el.parentElement
          }
          return null
        }

        /**
         * 现读输入框里的字。
         *
         * 从 **DOM** 现读而不是从宿主状态读：这是用户按下发送那一刻**看得见**的那一份。
         * 放行时会无条件 `setDraft` 一次把宿主状态对齐过去（同类插件的真机记录里，
         * DOM 与宿主状态确实会不同步，而 `submit()` 发的是宿主状态里那份）。
         */
        const draftNow = (card) => {
          const box = card || composerCard()
          const editor = box ? box.querySelector('[contenteditable="true"]') : null
          if (!editor) return ''
          const raw = typeof editor.innerText === 'string' && editor.innerText.length > 0
            ? editor.innerText
            : (editor.textContent || '')
          return String(raw).replace(/\u00a0/g, ' ').trim()
        }

        /** 我自己渲染的东西（药丸、档位按钮、卡片按钮）永不吞。 */
        const isOurs = (node) => !!(node && node.closest && node.closest('[data-ph-owned]'))

        /**
         * 卡片里最后一个按钮 —— 发送按钮的结构兜底。
         * 跳过我们自己的按钮：药丸也长在同一个卡片里，不跳就可能把药丸当成发送键。
         */
        const lastComposerButton = (card) => {
          if (!card) return null
          const list = Array.from(card.querySelectorAll('button')).filter((el) => !isOurs(el))
          return list.length > 0 ? list[list.length - 1] : null
        }

        /** 宿主会按 sessionId 注入，缺一不可；少一个就整套不武装。 */
        const canArm = Boolean(sessionId) && Boolean(inputActions) && typeof inputActions.submit === 'function'
        const reviewArmed = mode === 'review' && level !== 'off' && canArm


        /**
         * 放行：先把定稿登记给宿主（免得 pre-step 再改写一遍），再交给宿主的 `submit()`。
         *
         * 两条不变量：
         * - **拦下就一定要放行**：登记失败也照样发。最坏结果是 pre-step 又改写一遍（看得见），
         *   绝不能是"消息凭空消失"。
         * - **放行前无条件 setDraft 一次**：`submit()` 发的是宿主状态里的草稿，而我们是按 DOM
         *   判的空不空。对齐一次是幂等的，不一致时它就是唯一的保险。
         *
         * @param {string} text 最终要发出去的正文。
         */
        const release = React.useCallback((text) => {
          const mine = holdRef.current
          applyHold({ ...(mine || {}), phase: 'sending', text, startedAt: Date.now() })
          void (async () => {
            // 同 startReview：全部包进 try，绝不让这个块静悄悄死掉。
            let controller = null
            let timer = null
            try {
              controller = typeof AbortController === 'function' ? new AbortController() : null
              // 登记也要有自己的上限：它卡住的话卡片会永远停在"发出中"，
              // 而正文就躺在输入框里，等一个永远不会来的回执。
              timer = controller ? window.setTimeout(() => controller.abort(), RELEASE_TIMEOUT_MS) : null
              await fetch(REVIEW_ROUTE, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ text }),
                ...(controller ? { signal: controller.signal } : {}),
              })
            } catch (err) {
              // 登记不上也照发（见上），但要知道是"没登记上"，不是"没发"。
            } finally {
              if (timer !== null) window.clearTimeout(timer)
            }
            try {
              const actions = actionsRef.current || {}
              if (typeof actions.setDraft === 'function') actions.setDraft(text)
              actions.submit()
              // 卡片收掉。消息会自己出现在对话里，那就是回执。
              applyHold(null)
            } catch (err) {
              // 连放行都失败 ⇒ 必须说出来：用户至少要知道消息没发出去、可以自己再按一次。
              // 草稿一直在输入框里没被动过，所以这里不丢东西。
              applyHold({
                ...(holdRef.current || {}),
                phase: 'error',
                error: `${t('releaseFailed')}: ${String((err && err.message) || err)}`,
              })
            }
          })().catch((err) => {
            // 兜底：同 startReview，这个块绝不许静悄悄死掉 —— 那会让卡片永远停在"发出中"。
            applyHold({
              ...(holdRef.current || {}),
              phase: 'error',
              error: `${t('releaseFailed')}: ${String((err && err.message) || err)}`,
            })
          })
        }, [applyHold, t])

        /**
         * 开一张审查卡：立刻弹出来（先显示原文 + "改写中…"），再去问宿主。
         * 先弹后等是刻意的 —— 改写要几秒，不先弹的话用户点完发送只能干等。
         */
        const startReview = React.useCallback((text) => {
          const mine = { id: nextHoldId(), phase: 'working', original: text, text, source: null, error: '', startedAt: Date.now() }
          applyHold(mine)
          /**
           * 这张卡还是当初那一张吗。
           * 判据是**编号**而不是对象身份：请求可能由上一个实例发起，回来时挂载的组件已经
           * 换了人，但袋子里的编号还是同一个。撤回/发出会把袋子清掉 ⇒ 编号对不上 ⇒ 丢弃。
           */
          const stillMine = () => {
            const current = readHold(sessionId)
            return Boolean(current) && current.id === mine.id
          }
          void (async () => {
            // 这里**整体**包在 try 里：从前 `const controller` / `window.setTimeout` 两行在 try
            // 之外，一旦它们抛（或将来有人在这里加一句会抛的代码），这个 async 块就静悄悄死掉 ——
            // 没有请求、没有超时、卡片永远停在"改写中"，而且什么错误都看不到。实测踩到过。
            let controller = null
            let timer = null
            try {
              // 客户端自己也要有超时。宿主那次模型调用有 30 秒上限，这里留出余量；
              // 万一请求压根到不了宿主（路由没注册 / 服务卡住），卡片也不能永远停在"改写中"。
              controller = typeof AbortController === 'function' ? new AbortController() : null
              timer = controller ? window.setTimeout(() => controller.abort(), REVIEW_TIMEOUT_MS) : null
              const res = await fetch(REVIEW_ROUTE, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ text }),
                ...(controller ? { signal: controller.signal } : {}),
              })
              const data = await res.json().catch(() => null)
              if (!res.ok || !data || data.ok !== true) {
                throw new Error((data && data.error) || `HTTP ${res.status}`)
              }
              // 用户已经撤回或换了另一条：这张卡过期了，什么都不做。
              if (!stillMine()) return
              if (typeof data.skipped === 'string' && data.skipped.length > 0) {
                // 没东西可审（插件关了 / 火力关了 / 本来就够硬 / 命中 `??`）—— 直接按原文发出，
                // 别拿一张"其实没改"的卡片耽误人。发的是 host 洗过的那份，不是草稿：
                // 草稿里还带着 `??` 这类暗号（见 releaseTextFor）。
                release(releaseTextFor(data, text))
                return
              }
              if (data.changed !== true) {
                // 改写没成功。审查模式下**绝不自动发出**：把原因摆在卡片上，由用户自己选。
                applyHold({ ...mine, phase: 'error', error: data.error || t('failed') })
                return
              }
              applyHold({
                ...mine,
                phase: 'ready',
                text: data.text,
                source: data.source,
                error: data.error || '',
              })
            } catch (err) {
              // 超时要单独说人话：它是"没人回音"，和"宿主明确报错"是两件事。
              const aborted = err && (err.name === 'AbortError' || err.code === 20)
              if (!stillMine()) return
              applyHold({
                ...mine,
                phase: 'error',
                error: aborted ? t('timeout') : String((err && err.message) || err),
              })
            } finally {
              if (timer !== null) window.clearTimeout(timer)
            }
          })().catch((err) => {
            // 兜底：万一还有哪儿在 try 之外抛了，卡片也必须变成看得见的失败态，
            // 而不是永远停在"改写中"。这条曾经真实发生过，所以留着。
            applyHold({ ...mine, phase: 'error', error: String((err && err.message) || err) })
          })
        }, [applyHold, release, t, sessionId])

        /** 拦下一次发送：草稿从头到尾没动过，所以"撤回"就是关掉卡片。 */
        const beginHold = React.useCallback(() => {
          // 去重：同一次发送会同时命中 Enter 与 click。已经挂着一张卡时也不再开第二张 ——
          // 再抓一次只会抓到同一段字。
          if (holdRef.current) return
          const text = draftNow()
          if (text.length === 0) return
          setOpen(false)
          startReview(text)
        }, [startReview])

        // 监听挂在 **window 的捕获阶段**：早于 React 根容器和编辑器自己的处理器。
        // 这是"发送前"唯一的入口 —— 全客户端 90 个 slot 里没有官方的发送前钩子。
        React.useEffect(() => {
          if (!reviewArmed) return undefined

          const mark = (why) => {
            seenRef.current += 1
            try {
              const el = rootRef.current
              if (el && el.setAttribute) {
                el.setAttribute('data-ph-seen', String(seenRef.current))
                el.setAttribute('data-ph-lastpass', why)
              }
            } catch {
              /* 诊断不影响主流程 */
            }
          }

          // 会话那套字典里的文案。读不到就只靠结构兜底（最后一个按钮）。
          const labelSet = (bind, keys) => {
            const out = new Set()
            if (typeof bind !== 'function') return out
            for (const key of keys) {
              try {
                const value = bind(key)
                if (typeof value === 'string' && value.length > 0 && value !== key) out.add(value)
              } catch {
                /* 字典缺失不影响拦截 */
              }
            }
            return out
          }
          let bind = null
          try {
            if (ctx && ctx.locale && typeof ctx.locale.bind === 'function') bind = ctx.locale.bind('conversation')
          } catch {
            /* 拿不到就只用结构兜底 */
          }
          const sendLabels = labelSet(bind, ['input.send', 'input.send.queue', 'input.send.steer'])
          const stopLabels = labelSet(bind, ['input.stop'])

          const guards = createSendGuards({
            cardOf: composerCard,
            draftOf: draftNow,
            isOurs,
            buttonOf: (target) => (target && target.closest ? target.closest('button') : null),
            lastButtonOf: lastComposerButton,
            sendLabels,
            stopLabels,
          })

          const swallow = (event) => {
            event.preventDefault()
            if (typeof event.stopPropagation === 'function') event.stopPropagation()
            if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
          }

          const onKey = (event) => {
            const why = guards.wantKey(event)
            if (why !== null) {
              mark(`key:${why}`)
              return
            }
            swallow(event)
            mark('key:intercepted')
            beginHold()
          }

          const onClick = (event) => {
            const why = guards.wantClick(guards.buttonOf(event.target))
            if (why !== null) {
              mark(`click:${why}`)
              return
            }
            swallow(event)
            mark('click:intercepted')
            beginHold()
          }

          window.addEventListener('keydown', onKey, true)
          window.addEventListener('click', onClick, true)
          return () => {
            window.removeEventListener('keydown', onKey, true)
            window.removeEventListener('click', onClick, true)
          }
        }, [reviewArmed, beginHold, sessionId])

        const activeIndex = Math.max(0, LEVELS.indexOf(level))
        const accent = ACCENT[level] || ACCENT.standard
        const bars = h('span', { className: 'ph-bars', 'aria-hidden': true },
          LEVELS.map((_, i) => h('span', {
            key: i,
            className: 'ph-bar',
            'data-i': String(i),
            'data-on': String(i <= activeIndex),
          })))

        const pill = h('button', {
          type: 'button',
          className: 'ph-pill',
          style: { color: accent },
          'data-open': String(open),
          'data-mode': mode,
          title: t('title'),
          'aria-expanded': open,
          onClick: () => setOpen((v) => !v),
        },
        bars,
        // 只留名字。档位由颜色和力量条标识就够了，不再写"关/轻/中/重/狂"。
        h('span', null, t('label')))

        // 卡片挂着时只显示卡片：面板要让位，免得两个浮层叠在一起。
        const panel = open && !hold

        const rootAttrs = { className: 'ph-root', ref: rootRef, 'data-ph-owned': 'true', 'data-card': String(Boolean(hold)) }
        if (!panel && !hold) return h('span', rootAttrs, pill)

        if (hold) {
          const mine = holdRef.current || hold
          const busy = mine.phase === 'working' || mine.phase === 'sending'
          // 等了多久（`nowMs` 在等待期间每 500ms 推进一次）。
          const waited = mine.startedAt ? Math.max(0, Math.round((nowMs - mine.startedAt) / 1000)) : null
          const badge = mine.phase === 'working'
            ? `${t('rewriting')}${waited === null ? '' : ` ${waited}s`}`
            : (mine.phase === 'sending'
              ? `${t('sending')}${waited === null ? '' : ` ${waited}s`}`
              : (mine.source === 'rules-fallback' ? t('fromRules') : ''))
          // 卡片上不养闲字：原来这里有一行"6 字 → 466 字 · 已手改"，整行删掉了，
          // 空出来的高度给了正文输入框。曾经还写过"运行中，将排队发出"，但客户端拿不到
          // "当前回合在不在跑"的可信信号，那句在空闲时照样显示 —— 界面宁可少说，也不能说错。

          const card = h('div', { className: 'ph-card', role: 'dialog', 'aria-label': t('reviewTitle') },
            h('div', { className: 'ph-cardtitle' },
              h('span', null, t('reviewTitle')),
              badge ? h('span', { className: 'ph-badge' }, badge) : null),
            h('div', { className: 'ph-orig' }, `${t('originalLabel')}：${mine.original}`),
            mine.phase === 'error' && (mine.error || mine.reason === 'interrupted')
              ? h('div', { className: 'ph-err' },
                `${t('failed')}：${mine.reason === 'interrupted' ? t('interrupted') : mine.error}`)
              : null,
            h('textarea', {
              className: 'ph-edit',
              value: mine.text || '',
              spellCheck: false,
              disabled: busy,
              'aria-label': t('reviewTitle'),
              onChange: (event) => applyHold({ ...holdRef.current, text: event.target.value }),
              onKeyDown: (event) => {
                // 纯 Enter 留给换行（正文里换行是有意义的），Cmd/Ctrl+Enter 才是发出。
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  release(mine.text || '')
                }
              },
            }),
            h('div', { className: 'ph-actions' },
              h('button', {
                type: 'button',
                className: 'ph-btn',
                onClick: () => applyHold(null),
              }, t('cancel')),
              mine.phase === 'error' ? h('button', {
                type: 'button',
                className: 'ph-btn',
                onClick: () => startReview(mine.original),
              }, t('retry')) : null,
              h('button', {
                type: 'button',
                className: 'ph-btn',
                // 改写还在飞的时候也允许"按原文发出"：这是不等模型的逃生口，
                // 不能让人被一次卡住的改写关在卡片里。发出会清掉袋子 ⇒ 迟到的结果会被丢弃。
                onClick: () => release(mine.original),
              }, t('sendOriginal')),
              h('button', {
                type: 'button',
                className: 'ph-btn ph-btn-primary',
                disabled: busy,
                onClick: () => release(mine.text || ''),
              }, mine.phase === 'sending' ? t('sending') : t('send'))))

          return h('span', rootAttrs, pill, card)
        }

        const seg = h('div', { className: 'ph-seg' }, LEVELS.map((id) => h('button', {
          key: id,
          type: 'button',
          className: 'ph-segbtn',
          'data-on': String(id === level),
          style: id === level ? { background: ACCENT[id] } : undefined,
          title: t(id),
          onClick: () => commit({ enabled: id !== 'off', intensity: id === 'off' ? state.intensity : id }),
        }, t(id))))

        const modeSeg = h('div', { className: 'ph-seg' }, MODES.map((id) => h('button', {
          key: id,
          type: 'button',
          className: 'ph-segbtn',
          'data-on': String(id === mode),
          style: id === mode ? { background: 'var(--dsw-alias-brand-primary)' } : undefined,
          title: t(id === 'review' ? 'reviewHint' : 'autoHint'),
          onClick: () => commit({ mode: id }),
        }, t(id))))

        const panelEl = h('div', { className: 'ph-panel', role: 'dialog', 'aria-label': t('title') },
          h('div', { className: 'ph-title' }, t('title')),
          h('div', { className: 'ph-hint' }, t('hint')),
          h('span', { className: 'ph-rowlabel' }, t('level')),
          seg,
          h('span', { className: 'ph-rowlabel', style: { marginTop: '10px' } }, t('mode')),
          modeSeg,
          // 面板上不养闲字：统计与提示词信息整块删除。
          // 只留这一行，而且只有真出问题时才出现（路由读不到 / 写不进去）。
          error ? h('div', { className: 'ph-warn' }, `${t('unreachable')}: ${error}`) : null)

        return h('span', rootAttrs, pill, panelEl)
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
          if (typeof window.__PROMPT_HARDENER_DISPOSE__ === 'function') window.__PROMPT_HARDENER_DISPOSE__()
        } catch {
          /* 旧实例已经烂了也不影响新实例 */
        }
        const disposers = []
        const own = (fn, label) => {
          const dispose = ctx.effect(fn, label)
          disposers.push(typeof dispose === 'function' ? dispose : () => {})
        }
        // HMR 会把模块换成新实例：上一次实例发起、还在飞的改写**永远回不来了**，
        // 它的卡片会一直停在"改写中"。先把它落成失败态，用户重试一下就好。
        interruptInflightHolds()
        window.__PROMPT_HARDENER_DISPOSE__ = () => {
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
        }, makeControl(t, ctx))), `${NS}: composer control`)
      },
      /**
       * 测试缝。拦截判据与审查态的读写在浏览器里没法离线验，而它们出错的方式都很安静
       * （判漏 = 审查形同虚设，判多 = 吞消息；审查态不同步 = 卡片永远停在"改写中"）。
       * `CSS` 也放进来：样式表里有两处"写错了也照样跑、只有肉眼能看出来"的坑
       * （主按钮悬停被通用悬停规则洗白、药丸靠 box-sizing 维持与邻居同高），
       * 没有任何别的手段能离线守住它们。
       * 浏览器端没人读这个字段，放它对运行时没有任何影响。
       */
      __internals: {
        createSendGuards,
        releaseTextFor,
        holdBag,
        readHold,
        writeHold,
        interruptInflightHolds,
        nextHoldId,
        ACCENT,
        LEVELS,
        DICT,
        CSS,
      },
    }
  },
})
