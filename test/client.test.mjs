/**
 * 浏览器半边的形状测试。
 *
 * 没有浏览器可用，但客户端产物只有两个硬约定可以离线验证：
 * 1. 它必须用 `window.__ModuleLoader__.load({ id: <包名>, factory })` 注册；
 * 2. factory 返回的模块必须能 apply 到客户端上下文上，并把控件注册进
 *    `conversation.input.left`。
 *
 * 一个抛异常的组件会把 slot entry 打空（控制台报 slot entry crashed），
 * 所以这里真的把组件渲染一次。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

/** 捕获客户端产物注册的模块。 */
let registered = null

/** 极简 React 桩：只提供产物用到的那几个 API。 */
const ReactStub = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children }
  },
  useState(initial) {
    // 第一个 useState 是面板的展开开关；测试里可以强制它先给一次 true，
    // 否则组件只会渲染收起的药丸，面板那条渲染路径就没人守。
    if (ReactStub.__forceOpenOnce === true) {
      ReactStub.__forceOpenOnce = false
      return [true, () => {}]
    }
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useCallback(fn) {
    return fn
  },
  useRef() {
    return { current: null }
  },
}

/** 极简 document 桩：样式表挂载与卸载都要能跑。 */
function makeDocumentStub() {
  const head = { children: [], appendChild(node) { this.children.push(node); node.parentNode = this } }
  const nodes = new Map()
  return {
    head,
    getElementById: (id) => nodes.get(id) || null,
    createElement: (tag) => ({
      tagName: String(tag).toUpperCase(),
      id: '',
      textContent: '',
      parentNode: null,
      remove() {
        if (this.parentNode) {
          const i = this.parentNode.children.indexOf(this)
          if (i >= 0) this.parentNode.children.splice(i, 1)
        }
        nodes.delete(this.id)
      },
    }),
    __nodes: nodes,
  }
}

/** 装好全局桩，然后加载客户端产物。 */
const documentStub = makeDocumentStub()
globalThis.document = documentStub
globalThis.window = {
  __ModuleLoader__: {
    load(module) {
      registered = module
    },
  },
}
globalThis.fetch = async () => {
  throw new Error('offline test')
}

await import('../client.js')

test('用包名注册 lazy factory', () => {
  assert.ok(registered, '客户端产物没有调用 __ModuleLoader__.load')
  assert.equal(registered.id, 'dsh-prompt-hardener')
  assert.equal(typeof registered.factory, 'function')
})

test('factory 只 require("react")，并导出 name/inject/apply', () => {
  const requested = []
  const module = registered.factory((id) => {
    requested.push(id)
    if (id === 'react') return ReactStub
    throw new Error(`unexpected require: ${id}`)
  })
  assert.deepEqual(requested, ['react'], '除 react 外不得加载任何模块')
  assert.equal(module.name, 'dsh-prompt-hardener')
  assert.deepEqual(module.inject, ['slots', 'locale'])
  assert.equal(typeof module.apply, 'function')
})

test('apply 注册语言域、样式表与输入框控件', () => {
  const module = registered.factory(() => ReactStub)
  const calls = { slots: [], inject: [], effects: [], locale: [] }

  const disposers = []
  const ctx = {
    effect(fn, label) {
      calls.effects.push(label)
      const dispose = fn()
      disposers.push(dispose)
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    locale: {
      register(ns, dict) {
        calls.locale.push(ns)
        assert.ok(dict.zh && dict.en, '语言域必须中英双语')
        return () => {}
      },
      bind: () => (key) => key,
    },
    slots: {
      inject(owner, cb) {
        calls.inject.push(owner)
        return cb()
      },
      register(options, Component) {
        calls.slots.push({ options, Component })
        return () => {}
      },
    },
  }

  module.apply(ctx)

  assert.ok(calls.locale.includes('prompt-hardener'))
  assert.ok(calls.inject.includes('conversation.input.left'))
  // 三条注册一条都不能少：输入框控件 + 状态提示的"生产者"与"渲染者"。
  // 少任何一条在真机上都是"某个功能静默不见了"，所以这里逐个点名。
  assert.deepEqual(
    calls.slots.map((item) => item.options.name).sort(),
    ['conversation.input.dock', 'conversation.input.left', 'shell.overlay'],
  )
  const entry = calls.slots.find((item) => item.options.name === 'conversation.input.left')
  assert.equal(entry.options.id, 'prompt-hardener')
  assert.equal(typeof entry.options.order, 'number')

  // 组件必须能渲染而不抛：抛了会把 slot entry 打空。
  const tree = entry.Component({ sessionId: 'session-test' })
  assert.ok(tree && tree.type === 'span')

  // HMR 语义：dispose 要能重复调用而不炸。
  for (const dispose of disposers) {
    if (typeof dispose === 'function') dispose()
    if (typeof dispose === 'function') dispose()
  }
})

/** 把 React 元素树里的所有字符串抠出来，用来断言面板上到底写了什么。 */
function textsOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textsOf(child, out)
    return out
  }
  if (node.children) for (const child of node.children) textsOf(child, out)
  if (node.props && typeof node.props.children !== 'undefined') textsOf(node.props.children, out)
  return out
}

test('展开面板：新标题、新标签、且一个字的多余统计都不留', () => {
  const module = registered.factory(() => ReactStub)
  let entry = null
  // 语言域桩照真服务的行为来：register 收下字典，bind 去字典里取中文。
  // 不这么做的话 t() 只会回显 key，断言就变成自欺欺人了。
  let dict = null
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    locale: {
      register: (_ns, value) => {
        dict = value
        return () => {}
      },
      bind: () => (key) => (dict && dict.zh && typeof dict.zh[key] === 'string' ? dict.zh[key] : key),
    },
    slots: {
      inject: (_owner, cb) => cb(),
      register: (options, Component) => {
        // 插件会注册三处 slot（控件 + toast 的生产者与渲染者）。这几个用例要验的是
        // 输入框里那个控件，所以按名字挑，别让"最后注册的那个"决定验的是谁。
        if (options.name === 'conversation.input.left') entry = { options, Component }
        return () => {}
      },
    },
  }
  module.apply(ctx)
  assert.ok(entry, '控件没有注册')

  ReactStub.__forceOpenOnce = true
  const tree = entry.Component({ sessionId: 'session-test' })
  const texts = textsOf(tree).join(' | ')

  assert.ok(texts.includes('硬邦邦！！！'), `面板标题不对：${texts}`)
  assert.ok(texts.includes('硬度'), `档位标签不对：${texts}`)
  assert.ok(!texts.includes('[object Object]'), '面板里不许出现 [object Object]')
  // 注意：「提示词」这个词本身还留在 hint 那句说明里，那是没让删的；
  // 这里守的是"统计那几行的格式与字样一个字都不剩"。
  for (const gone of ['已硬邦邦化', '模型改写', '规则兜底', '上次', '→']) {
    assert.ok(!texts.includes(gone), `统计块没删干净，还留着：${gone}`)
  }
  // 五个档位按钮的字都必须完整在场 —— 尤其"丧心病狂"四个字，它是这次修溢出的主角
  for (const label of ['关', '轻', '中', '重', '丧心病狂']) {
    assert.ok(texts.includes(label), `档位名没渲染：${label}`)
  }

  // 说明文案只有一行：短、带疯味，不靠换行排版
  const hint = textsOf(tree).find((x) => x.includes('提示词'))
  assert.ok(hint, '找不到说明文案')
  assert.ok(hint.includes('硬邦邦'), `说明要带硬邦邦的味：${hint}`)
  assert.ok(!hint.includes('硬汉风格'), `旧词应当已被替换掉：${hint}`)
  assert.ok(!hint.includes('\n'), `只保留一句，不该有换行：${hint}`)
  assert.ok(hint.includes('全量'), `要保住"全量重写"这层意思：${hint}`)
  assert.ok(hint.includes('提示词'), `要保住"按提示词"这层意思：${hint}`)
  assert.ok(hint.length <= 30, `面板说明太长（${hint.length} 字）：${hint}`)

  // 说明已定为单行，pre-line 随之下线。
  // 记着这个坑：哪天要把说明改回多行，字符串里光写 \n 不够，必须同时把
  // `white-space: pre-line` 加回 .ph-hint —— 否则 HTML 会把换行折成空格，改了等于没改。
  const styleTag = documentStub.head.children.find((node) => node.id === 'prompt-hardener-style')
  assert.ok(styleTag, '样式表没挂上')
})

/* ─────────────────── 拦截判据：不吞消息 / 不放跑审查 ─────────────────── */

const guards = registered.factory(() => ReactStub).__internals.createSendGuards

/**
 * 极简 DOM 节点：够 `contains` / `closest` / `getAttribute` 用就行。
 * @param {string} tag 标签名。
 * @param {object} [attrs] 属性表。
 * @returns {object} 节点。
 */
function el(tag, attrs = {}) {
  const node = {
    tag,
    attrs,
    parent: null,
    children: [],
    getAttribute(name) {
      return name in node.attrs ? node.attrs[name] : null
    },
    contains(other) {
      let cur = other
      while (cur) {
        if (cur === node) return true
        cur = cur.parent
      }
      return false
    },
    closest(selector) {
      let cur = node
      while (cur) {
        if (selector === 'button' && cur.tag === 'button') return cur
        if (selector === '[data-ph-owned]' && cur.attrs['data-ph-owned']) return cur
        cur = cur.parent
      }
      return null
    },
    append(child) {
      child.parent = node
      node.children.push(child)
      return child
    },
  }
  return node
}

/**
 * 造一份判据 + 一棵假输入卡片。
 *
 * 卡片结构照真实的来：我们自己的药丸也长在这张卡片里，所以"最后一个按钮"必须是
 * **跳过我们之后**的那个 —— 这条判错就会变成"点药丸弹出审查卡"。
 *
 * @param {object} [options] `draft` 当前草稿；`hasCard` 是否在会话页。
 * @returns {object} 判据与各个按钮。
 */
function makeGuards(options = {}) {
  const draft = options.draft ?? '帮我写个脚本'
  const dom = el('div')
  dom.append(el('div', { contenteditable: 'true' }))
  const pill = dom.append(el('button', { 'data-ph-owned': 'true' }))
  const attach = dom.append(el('button', { 'aria-label': '添加附件' }))
  const send = dom.append(el('button', { 'aria-label': '发送消息' }))
  const stop = dom.append(el('button', { 'aria-label': '停止生成' }))
  const plain = el('button') // 没有 aria-label 的按钮，用来测结构兜底
  const outside = el('button', { 'aria-label': '发送消息' })

  const api = guards({
    cardOf: () => (options.hasCard === false ? null : dom),
    draftOf: () => draft,
    isOurs: (node) => !!(node && node.closest && node.closest('[data-ph-owned]')),
    buttonOf: (target) => (target && target.closest ? target.closest('button') : null),
    lastButtonOf: (card) => {
      const list = card.children.filter((child) => child.tag === 'button' && !child.closest('[data-ph-owned]'))
      return list.length > 0 ? list[list.length - 1] : null
    },
    sendLabels: new Set(['发送消息', '排队发送', '插话发送']),
    stopLabels: new Set(['停止生成']),
    isNode: options.isNode ?? (() => true),
  })
  return { api, dom, pill, attach, send, stop, plain, outside }
}

/** 造一个 keydown 事件。 */
function keyEvent(target, overrides = {}) {
  return { key: 'Enter', target, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...overrides }
}

test('判据：卡片内普通回车该拦', () => {
  const { api, dom } = makeGuards()
  assert.equal(api.wantKey(keyEvent(dom)), null)
})

test('判据：不该拦的回车必须逐条放行（放行理由要能看出是哪一条）', () => {
  const { api, dom } = makeGuards()
  assert.equal(api.wantKey(keyEvent(dom, { key: 'a' })), 'not-plain-enter')
  assert.equal(api.wantKey(keyEvent(dom, { shiftKey: true })), 'not-plain-enter')
  assert.equal(api.wantKey(keyEvent(dom, { ctrlKey: true })), 'not-plain-enter')
  assert.equal(api.wantKey(keyEvent(dom, { altKey: true })), 'not-plain-enter')
  assert.equal(api.wantKey(keyEvent(dom, { isComposing: true })), 'composing', '中文输入法合成中绝不能吞')
  assert.equal(api.wantKey(keyEvent(dom, { keyCode: 229 })), 'composing')
  assert.equal(api.wantKey(keyEvent(el('div'))), 'focus-outside', '焦点不在输入卡片里就交还官方')
  const noCard = makeGuards({ hasCard: false })
  assert.equal(noCard.api.wantKey(keyEvent(noCard.dom)), 'no-card')
  const blank = makeGuards({ draft: '   ' })
  assert.equal(blank.api.wantKey(keyEvent(blank.dom)), 'empty-draft')
  const slash = makeGuards({ draft: '/clear' })
  assert.equal(slash.api.wantKey(keyEvent(slash.dom)), 'slash-command', '斜杠命令交还官方')
  const notNode = makeGuards({ isNode: () => false })
  assert.equal(notNode.api.wantKey(keyEvent(notNode.dom)), 'focus-outside')
})

test('判据：点发送键该拦', () => {
  const { api, send } = makeGuards()
  assert.equal(api.wantClick(send), null)
})

test('判据：绝不吞我们自己的按钮 —— 药丸就长在同一张卡片里', () => {
  const { api, pill } = makeGuards()
  assert.equal(api.wantClick(pill), 'our-own-button')
})

test('判据：停止键、附件键、卡片外的按钮一律放行', () => {
  const { api, stop, attach, outside } = makeGuards()
  assert.equal(api.wantClick(stop), 'stop-button', '吞了停止键就连中断都点不动')
  assert.equal(api.wantClick(attach), 'not-send-button')
  assert.equal(api.wantClick(outside), 'button-outside-card')
  assert.equal(api.wantClick(null), 'no-button')
})

test('判据：空草稿时不吞任何按钮（那时主按钮是停止生成）', () => {
  const { api, send } = makeGuards({ draft: '' })
  assert.equal(api.wantClick(send), 'empty-draft')
})

test('判据：发送键没有 aria-label 时靠"最后一个按钮"兜底', () => {
  const { api, dom, plain } = makeGuards()
  // 把无标签按钮接到卡片末尾：它就成了结构上的发送键。
  dom.append(plain)
  assert.equal(api.wantClick(plain), null, '结构兜底必须成立，否则换个语言就拦不住了')
})

test('判据：发送键靠 aria-label 认出来，跟它在不在最后一位无关', () => {
  const { api, dom, send } = makeGuards()
  dom.append(el('button', { 'aria-label': '别的什么' })) // 末尾塞个不是发送键的按钮
  assert.equal(api.wantClick(send), null, '认的是文案，不是位置')
})

test('审查相关的文案中英双语都得在', () => {
  const dict = registered.factory(() => ReactStub).__internals.DICT
  for (const lang of ['zh', 'en']) {
    for (const key of ['mode', 'auto', 'review', 'reviewTitle', 'rewriting', 'send', 'sendOriginal', 'cancel', 'retry', 'failed']) {
      assert.equal(typeof dict[lang][key], 'string', `${lang} 缺文案：${key}`)
    }
  }
})

test('英文语言域下，卡片与面板里不许再出现中文与全角标点', () => {
  // 这类漏译没有任何一处会抛：界面照样画出来，只是一个字都不认识的人在读中文。
  // 曾经有三处 `en` 值是直接抄了 `zh`（面板标题、副标题、行标签），卡片那两行的
  // 分隔符还是拼接时写死的全角冒号。所以这里**拿 en 字典真渲染一遍**再扫字符。
  const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/
  const module = registered.factory(() => ReactStub)
  let entry = null
  let dict = null
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    locale: {
      register: (_ns, value) => {
        dict = value
        return () => {}
      },
      bind: () => (key) => (dict && dict.en && typeof dict.en[key] === 'string' ? dict.en[key] : key),
    },
    slots: {
      inject: (_owner, cb) => cb(),
      register: (options, Component) => {
        if (options.name === 'conversation.input.left') entry = { options, Component }
        return () => {}
      },
    },
  }
  module.apply(ctx)

  const bag = module.__internals.holdBag()
  const props = { sessionId: 's-en', inputActions: { submit() {}, setDraft() {} } }

  // 卡片：就绪态与失败态各渲染一遍（失败态多出"改写失败 + 原因"那一行）。
  for (const phase of [
    { phase: 'ready', source: 'llm', error: '' },
    { phase: 'error', source: null, error: 'llm produced no text' },
  ]) {
    bag.byId = {}
    module.__internals.writeHold('s-en', {
      id: module.__internals.nextHoldId(),
      original: 'write me a script',
      text: 'Alright brother!',
      ...phase,
    })
    const texts = textsOf(entry.Component(props)).join(' | ')
    assert.ok(!CJK.test(texts), `en 的卡片里还有中文/全角标点：${texts}`)
    assert.ok(texts.includes('Original: write me a script'), `标签分隔符没跟语言走：${texts}`)
  }

  // 面板（含药丸的悬停提示：它也走同一个 `title` 键）。
  bag.byId = {}
  ReactStub.__forceOpenOnce = true
  const panelTree = entry.Component(props)
  ReactStub.__forceOpenOnce = false
  const panelTexts = textsOf(panelTree).join(' | ')
  assert.ok(!CJK.test(panelTexts), `en 的面板里还有中文/全角标点：${panelTexts}`)
  const pill = findNode(panelTree, (node) => node.props && node.props.className === 'ph-pill')
  assert.ok(pill, '找不到药丸')
  assert.ok(!CJK.test(String(pill.props.title)), `药丸悬停提示还是中文：${pill.props.title}`)

  // 状态提示那一条（第三个界面：shell.overlay 上的 toast）。
  const toastBag = module.__internals.toastBag()
  const Stack = module.__internals.makeToastStack((key) => (dict.en[key] || key))
  for (const kind of ['timeout']) {
    toastBag.items = []
    toastBag.seenAt = 0
    module.__internals.pushToast({ kind, detail: 'AbortError: timed out' })
    const toastTexts = textsOf(Stack({})).join(' | ')
    assert.ok(!CJK.test(toastTexts), `en 的提示条（${kind}）里还有中文/全角标点：${toastTexts}`)
  }
  toastBag.items = []

  // 反过来守一下：别顺手把中文那半边也翻译没了。
  for (const key of ['title', 'hint', 'level']) {
    assert.ok(CJK.test(module.__internals.DICT.zh[key]), `zh 的 ${key} 不该被改掉`)
  }

  // 副标题必须**一行装得下**。面板那一行的可用宽度是 **340px**：`.ph-panel` 写的是
  // `width: 340px` 且没声明 box-sizing ⇒ 那是**内容**宽，padding 与 border 加在它之外
  // （整框 366px）。这两条都拿真机截图量过：面板 bbox 722 图 px ÷ 366 = 1.97×，文字左边
  // 距 25 图 px = 13 CSS × 1.97，副标题墨迹 652 图 px ÷ 1.97 = 330px。
  //
  // 字宽按 **Liberation Sans**（Arial 度量）估：本机 Chromium 从 DSH 的字体栈里实际取到的
  // 就是它（`-apple-system`…`Helvetica Neue` 都缺，落到 `Helvetica` → fontconfig → Liberation；
  // Chromium 并不认 `Segoe UI` → Adwaita 这种别名）。系数是拿真实字符串最小二乘拟合的，
  // 在这一类文案上偏差约 ±3%。全角字较特殊：字宽精确等于 1em（与字体无关），单独按 1em 计。
  const lineEm = 340 / 12
  const widthEm = (text) => [...text].reduce((sum, ch) => {
    if (/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/.test(ch)) return sum + 1
    if (ch === ' ') return sum + 0.2282
    if (ch === '!') return sum + 0.3243
    if (ch === ch.toUpperCase() && ch !== ch.toLowerCase()) return sum + 0.7313
    return sum + 0.4595
  }, 0)
  for (const lang of ['zh', 'en']) {
    const hint = module.__internals.DICT[lang].hint
    assert.ok(widthEm(hint) <= lineEm,
      `${lang} 的副标题一行装不下（估宽 ${widthEm(hint).toFixed(1)}em > ${lineEm.toFixed(1)}em = 340px）：${hint}`)
  }

  bag.byId = {}
})

/* ─────────────── 审查态：window 上的袋子是唯一真相 ─────────────── */

const internals = registered.factory(() => ReactStub).__internals

test('写审查态会叫醒所有订阅者（卡片不能停在"改写中"）', () => {
  // 在飞的改写请求回来时，挂载着的组件必须收到通知去读袋子里的新状态；否则它一直显示
  // 自己的旧快照 ⇒ 卡片永远停在"改写中"。这条用例守的就是那句通知。
  const { holdBag, readHold, writeHold, nextHoldId } = internals
  const bag = holdBag()
  bag.byId = {}
  let woke = 0
  let seen = null
  const sub = () => {
    woke += 1
    seen = readHold('s1')
  }
  bag.subs.push(sub)
  try {
    const hold = { id: nextHoldId(), phase: 'working', original: 'x', text: 'x' }
    writeHold('s1', hold)
    assert.equal(woke, 1, '写袋子必须通知订阅者')
    assert.equal(seen.phase, 'working')

    // 被"另一个实例"（HMR 之后挂载的那个）改写，订阅者同样要被叫醒。
    writeHold('s1', { ...hold, phase: 'ready', text: '定稿' })
    assert.equal(woke, 2)
    assert.equal(readHold('s1').text, '定稿', '读者读到的必须是袋子里的最新那份')

    writeHold('s1', null)
    assert.equal(woke, 3)
    assert.equal(readHold('s1'), null, '清掉也要通知')
  } finally {
    bag.subs.splice(bag.subs.indexOf(sub), 1)
    bag.byId = {}
  }
})

test('插件重载：在飞的审查态落成失败态，已就绪的不动', () => {
  const { holdBag, readHold, writeHold, interruptInflightHolds, nextHoldId } = internals
  holdBag().byId = {}
  writeHold('a', { id: nextHoldId(), phase: 'working', original: '甲', text: '甲' })
  writeHold('b', { id: nextHoldId(), phase: 'sending', original: '乙', text: '乙' })
  writeHold('c', { id: nextHoldId(), phase: 'ready', original: '丙', text: '丙' })

  interruptInflightHolds()

  assert.equal(readHold('a').phase, 'error')
  assert.equal(readHold('a').reason, 'interrupted')
  assert.equal(readHold('a').text, '甲', '正文一个字都不能丢')
  assert.equal(readHold('b').phase, 'error')
  assert.equal(readHold('c').phase, 'ready', '已经就绪的卡片不该被动')
  holdBag().byId = {}
})

/** 在 React 元素树里找第一个满足条件的节点。 */
function findNode(node, match) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, match)
      if (hit) return hit
    }
    return null
  }
  if (match(node)) return node
  for (const child of node.children || []) {
    const hit = findNode(child, match)
    if (hit) return hit
  }
  return null
}

test('审查卡片能渲染出来，三个出口齐全，正文可编辑', () => {
  const module = registered.factory(() => ReactStub)
  let entry = null
  let dict = null
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    locale: {
      register: (_ns, value) => {
        dict = value
        return () => {}
      },
      bind: () => (key) => (dict && dict.zh && typeof dict.zh[key] === 'string' ? dict.zh[key] : key),
    },
    slots: {
      inject: (_owner, cb) => cb(),
      register: (options, Component) => {
        // 插件会注册三处 slot（控件 + toast 的生产者与渲染者）。这几个用例要验的是
        // 输入框里那个控件，所以按名字挑，别让"最后注册的那个"决定验的是谁。
        if (options.name === 'conversation.input.left') entry = { options, Component }
        return () => {}
      },
    },
  }
  module.apply(ctx)
  module.__internals.holdBag().byId = {}
  module.__internals.writeHold('session-test', {
    id: module.__internals.nextHoldId(),
    phase: 'ready',
    original: '帮我写个脚本',
    text: '老哥们，搞快点！',
    source: 'llm',
    error: '',
  })

  const tree = entry.Component({ sessionId: 'session-test', inputActions: { submit() {}, setDraft() {} } })
  const texts = textsOf(tree).join(' | ')
  assert.ok(texts.includes('硬邦邦审查！！！'), `卡片标题不对：${texts}`)
  // 卡片正文区不放字数统计（样式表那条 min-height 由下面的"样式表"用例守）；
  // 这里守的是"它真的不在树里"。
  assert.ok(!/\d\s*字/.test(texts), `字数统计没删干净：${texts}`)
  assert.equal(findNode(tree, (node) => node.props && node.props.className === 'ph-meta'), null,
    '字数统计那一行必须整行消失')
  for (const label of ['发出', '按原文发出', '撤回']) {
    assert.ok(texts.includes(label), `出口缺失：${label}`)
  }
  assert.ok(texts.includes('帮我写个脚本'), '原文要在卡片上，好让人对照')
  assert.ok(!texts.includes('[object Object]'))

  const edit = findNode(tree, (node) => node.props && node.props.className === 'ph-edit')
  assert.ok(edit, '找不到正文编辑区')
  assert.equal(edit.props.value, '老哥们，搞快点！', '定稿要在编辑区里')
  assert.equal(edit.props.disabled, false, '就绪之后必须能改')
  assert.equal(edit.type, 'textarea')

  module.__internals.holdBag().byId = {}
})

test('审查卡片：改写中时正文禁用，但"按原文发出"必须还开着（不能把人关在卡片里）', () => {
  const module = registered.factory(() => ReactStub)
  let entry = null
  let dict = null
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    locale: {
      register: (_ns, value) => {
        dict = value
        return () => {}
      },
      bind: () => (key) => (dict && dict.zh && typeof dict.zh[key] === 'string' ? dict.zh[key] : key),
    },
    slots: {
      inject: (_owner, cb) => cb(),
      register: (options, Component) => {
        // 插件会注册三处 slot（控件 + toast 的生产者与渲染者）。这几个用例要验的是
        // 输入框里那个控件，所以按名字挑，别让"最后注册的那个"决定验的是谁。
        if (options.name === 'conversation.input.left') entry = { options, Component }
        return () => {}
      },
    },
  }
  module.apply(ctx)
  module.__internals.holdBag().byId = {}
  module.__internals.writeHold('s-working', {
    id: module.__internals.nextHoldId(),
    phase: 'working',
    original: '帮我写个脚本',
    text: '帮我写个脚本',
    source: null,
    error: '',
  })

  const tree = entry.Component({ sessionId: 's-working', inputActions: { submit() {}, setDraft() {} } })
  const texts = textsOf(tree).join(' | ')
  assert.ok(texts.includes('改写中'), `改写中标记不在：${texts}`)

  const edit = findNode(tree, (node) => node.props && node.props.className === 'ph-edit')
  assert.equal(edit.props.disabled, true, '改写中正文先别让人改（结果还没回来，改了也会被覆盖）')

  const original = findNode(tree, (node) => node.props && node.children && node.children.includes('按原文发出'))
  assert.ok(original, '找不到"按原文发出"')
  assert.equal(original.props.disabled, undefined, '这条逃生口在改写中也不许禁用')
  module.__internals.holdBag().byId = {}
})

test('药丸只留名字：档位靠颜色和力量条标识', () => {
  const module = registered.factory(() => ReactStub)
  let entry = null
  let dict = null
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    locale: {
      register: (_ns, value) => {
        dict = value
        return () => {}
      },
      bind: () => (key) => (dict && dict.zh && typeof dict.zh[key] === 'string' ? dict.zh[key] : key),
    },
    slots: {
      inject: (_owner, cb) => cb(),
      register: (options, Component) => {
        // 插件会注册三处 slot（控件 + toast 的生产者与渲染者）。这几个用例要验的是
        // 输入框里那个控件，所以按名字挑，别让"最后注册的那个"决定验的是谁。
        if (options.name === 'conversation.input.left') entry = { options, Component }
        return () => {}
      },
    },
  }
  module.apply(ctx)
  module.__internals.holdBag().byId = {}

  const tree = entry.Component({ sessionId: 's-pill', inputActions: { submit() {}, setDraft() {} } })
  const pill = findNode(tree, (node) => node.props && node.props.className === 'ph-pill')
  assert.ok(pill, '找不到硬邦邦药丸')
  const pillTexts = textsOf(pill).join('')
  assert.equal(pillTexts, '硬邦邦', `药丸上只该剩名字，实际是：${pillTexts}`)
  // 名字可以省，力量条不能省 —— 档位全靠它和颜色来报。
  const bars = findNode(pill, (node) => node.props && node.props.className === 'ph-bars')
  assert.ok(bars, '力量条不见了，档位就没有任何标识了')
})

/**
 * 样式表里有两处"写错了也照样跑，只有肉眼能看出来"的坑，没有任何别的手段能离线守住：
 * 1. 主按钮悬停被通用悬停规则洗白（权重打平 + 书写顺序输掉）；
 * 2. 药丸去掉描边后靠 box-sizing 维持与旁边官方控件同高。
 */
test('样式表：主按钮悬停不许被通用悬停洗白；药丸无边框、与邻居同高、圆角顺齐官方', () => {
  const module = registered.factory(() => ReactStub)
  const css = module.__internals.CSS
  assert.equal(typeof css, 'string', 'CSS 没有通过测试缝暴露出来')

  const primaryHover = '.ph-btn.ph-btn-primary:hover:not(:disabled)'
  const primaryAt = css.indexOf(primaryHover)
  assert.ok(primaryAt > -1, '主按钮没有声明自己的悬停规则')
  const genericAt = css.indexOf('.ph-btn:hover:not(:disabled)')
  assert.ok(genericAt > -1, '通用悬停规则不见了')
  assert.ok(primaryAt > genericAt, '主按钮悬停规则必须写在通用悬停之后（同权重时后写的赢）')
  const primaryBody = css.slice(primaryAt, css.indexOf('}', primaryAt))
  assert.match(primaryBody, /var\(--dsw-alias-button-primary-hover\)/,
    '主按钮悬停要用官方 hover 令牌（浅色主题下是深灰，不是洗白）')
  assert.doesNotMatch(primaryBody, /interactive-bg-hover/, '主按钮悬停不许退回通用灰底')

  const pillAt = css.indexOf('.ph-pill {')
  assert.ok(pillAt > -1, '找不到药丸样式')
  const pill = css.slice(pillAt, css.indexOf('}', pillAt))
  assert.match(pill, /border:\s*none/, '药丸还带着边框')
  assert.match(pill, /height:\s*28px/, '药丸高度要和旁边官方控件一致（28px）')
  assert.match(pill, /box-sizing:\s*border-box/, '没有 border-box 的话，去掉描边后高度会塌 2px')
  assert.match(pill, /border-radius:\s*var\(--dsw-radius-sm\)/, '圆角要顺齐官方（8px）')

  // 正文输入框起步 126px。
  const editAt = css.indexOf('.ph-edit {')
  assert.ok(editAt > -1, '找不到正文输入框样式')
  const edit = css.slice(editAt, css.indexOf('}', editAt))
  assert.match(edit, /min-height:\s*126px/, '输入框高度不对')
  assert.equal(css.includes('.ph-meta'), false, '.ph-meta 不该有规则')

  // 按钮行与输入框之间的 12px 间隙由这条 margin-top 提供；没有它两者贴死。
  const actionsAt = css.indexOf('.ph-actions {')
  assert.ok(actionsAt > -1, '找不到按钮行样式')
  const actions = css.slice(actionsAt, css.indexOf('}', actionsAt))
  assert.match(actions, /margin-top:\s*12px/, '按钮行必须与正文输入框留出 12px 间隙')

  // 卡片要能压住官方的"滚动到底部"圆钮。圆钮所在槽位是输入框底栏的**兄弟**且 z-index 为 8，
  // 底栏自己是 7，而卡片住在底栏里 —— 自己写多高的 z-index 都出不去（聊天视图里没有
  // 层叠上下文挡着，8 直接压 7）。唯一出路是卡片打开时把整条底栏抬到 8 之上。
  // 这条规则一丢，真机上就是"圆钮浮在卡片上遮住内容"，而所有测试照样全绿。
  const seat = css.match(/body:has\(\.ph-root\[data-card="true"\]\)\s*\[data-composer-seat\]\s*\{\s*z-index:\s*(\d+)/)
  assert.ok(seat, '缺少"卡片打开时抬高输入框底栏"的规则（会被滚动到底部按钮压住）')
  assert.ok(Number(seat[1]) > 8, `底栏 z-index 必须高于滚动到底部槽位的 8，实际 ${seat[1]}`)
})

/* ───────────────── 放行哪一份正文（触发前缀的暗号不许进对话） ───────────────── */

test('放行时发 host 洗过的那份：草稿里的 `??` 不许跟着消息进对话', () => {
  // 这个判据错起来**特别安静**：消息照样发出去了，只是正文不对，没有任何一处会抛。
  assert.equal(internals.releaseTextFor({ text: '剥掉暗号' }, '?? 剥掉暗号'), '剥掉暗号')
  assert.equal(internals.releaseTextFor({ text: '' }, '草稿'), '草稿', '空串不算数，退回草稿')
  assert.equal(internals.releaseTextFor({}, '草稿'), '草稿')
  assert.equal(internals.releaseTextFor(null, '草稿'), '草稿')
  assert.equal(internals.releaseTextFor({ text: 'x' }, undefined), 'x')
  assert.equal(internals.releaseTextFor(null, undefined), '', '两边都没有就是空串，不许是 undefined')
})

/* ───────────── 卡片延迟露面：即时就有答案的不许闪一张卡 ───────────── */

test('卡片延迟露面：`??` 放行 / 本来就够硬这类秒回，连一眼都不该看到卡片', () => {
  // 卡片先弹后等是刻意的（改写要几秒，不先弹用户只能干等）；但宿主对"这次不用审"的回答
  // 是秒回的，当场弹出来只会闪一下。判据分成两半：露面时间有下限，且到点时还要复查。
  const { cardVisible, onReveal, CARD_DELAY_MS } = internals
  // 上限压住是因为它是用户按完回车的空窗 —— 量过：渲染进程里那条秒回的路 max 10ms，
  // 所以几十毫秒就有几倍余量，过了百毫秒人就能感觉到"卡片来得慢"。
  assert.ok(CARD_DELAY_MS >= 20 && CARD_DELAY_MS <= 150,
    `延迟要够长（秒回抢不上）又不能让人等，实际 ${CARD_DELAY_MS}`)

  // 压着的卡片不上屏；露过面的、以及"没有卡片"时按常理来。
  assert.equal(cardVisible(null), false)
  assert.equal(cardVisible({ id: 7, hidden: true }), false, '压着的时候屏幕上只该有药丸')
  assert.equal(cardVisible({ id: 7, hidden: false }), true)
  assert.equal(cardVisible({ id: 7 }), true, '没标 hidden 的（比如 HMR 留下的）照常显示')

  // 到点了：还是那张压着的卡 → 显示；
  const shown = onReveal({ id: 7, hidden: true, phase: 'working' }, 7)
  assert.equal(cardVisible(shown), true)
  assert.equal(shown.phase, 'working', '复查时不能把期间变化的阶段抹掉')
  // 回答已经先到、卡片被收掉 → 什么都不做（这一条就是"不闪"本身）；
  assert.equal(onReveal(null, 7), null, '卡片已经收掉了，绝不许把它写回来')
  // 换了一张卡（撤回后重开 / 上一个实例的）→ 不动别人的；
  assert.equal(onReveal({ id: 8, hidden: true }, 7), null)
  // 已经露过面了（正常改写，等了几秒）→ 不动。
  assert.equal(onReveal({ id: 7, hidden: false }, 7), null)
})

/* ───────────────────── 状态提示：改写出事时的那一条 ───────────────────── */

test('toast：同一件事只弹一次，新事件才再弹（不然每回合结束都重弹一遍）', () => {
  const bag = internals.toastBag()
  bag.items = []
  bag.seenAt = 0
  const fresh = internals.LOADED_AT + 1000

  assert.ok(internals.reportIssue({ lastIssue: { at: fresh, kind: 'llm-failed', error: 'boom' } }), '第一次要弹')
  assert.equal(bag.items.length, 1)
  assert.equal(
    internals.reportIssue({ lastIssue: { at: fresh, kind: 'llm-failed', error: 'boom' } }),
    null,
    '同一个时间戳不许重复弹')
  assert.equal(bag.items.length, 1)

  assert.ok(internals.reportIssue({ lastIssue: { at: fresh + 1, kind: 'timeout' } }), '新事件要弹')
  assert.equal(bag.items.length, 2)

  // 没有 issue 的各种形状都不许有事
  assert.equal(internals.reportIssue({}), null)
  assert.equal(internals.reportIssue(null), null)
  assert.equal(internals.reportIssue({ lastIssue: { kind: 'llm-failed' } }), null, '没有时间戳就没法判断新旧')

  bag.items = []
  bag.seenAt = 0
})

test('toast：重启后不许为上一次运行留在盘上的旧事弹提示', () => {
  // stats 落在盘上，上一次运行的 `lastIssue` 会被读回来；而水位线在 window 上，刷新即归零。
  // 少了 `LOADED_AT` 这道闸，重启后第一轮结束就会为几小时前那次失败弹一条 —— 那句话是假的。
  const bag = internals.toastBag()
  bag.items = []
  bag.seenAt = 0

  assert.equal(
    internals.reportIssue({ lastIssue: { at: internals.LOADED_AT - 1, kind: 'timeout', error: '旧事' } }),
    null,
    '比这次加载还早的都不算这一轮的事')
  assert.equal(bag.items.length, 0)
  assert.ok(internals.reportIssue({ lastIssue: { at: internals.LOADED_AT + 1, kind: 'timeout' } }), '这一轮的才算')

  bag.items = []
  bag.seenAt = 0
})

test('toast：最多留三条，能点掉，关不存在的 id 不许有副作用', () => {
  const bag = internals.toastBag()
  bag.items = []
  bag.seenAt = 0

  for (let i = 0; i < 5; i += 1) internals.pushToast({ kind: 'llm-failed', detail: `第 ${i} 条` })
  assert.equal(bag.items.length, 3, '一屏堆满提示等于什么都没说')
  assert.ok(bag.items[2].detail.includes('第 4 条'), '留的是最新的几条')

  internals.dismissToast(bag.items[0].id)
  assert.equal(bag.items.length, 2)
  internals.dismissToast(999999)
  assert.equal(bag.items.length, 2)

  bag.items = []
  bag.seenAt = 0
})

test('toast 渲染者：平时渲染 null，有事时把话说清楚', () => {
  ReactStub.__forceOpenOnce = false
  const Stack = internals.makeToastStack((key) => internals.DICT.zh[key] || key)
  const bag = internals.toastBag()
  bag.items = []
  bag.seenAt = 0

  assert.equal(Stack({}), null, 'overlay 是 frame 级的：没内容时必须整块不渲染')

  internals.pushToast({ kind: 'timeout', detail: 'AbortError: timed out' })
  const tree = Stack({})
  const texts = textsOf(tree).join(' | ')
  assert.equal(tree.props.className, 'ph-toasts')
  assert.ok(texts.includes(internals.DICT.zh.toastTimeout), `超时要单独说人话：${texts}`)
  assert.ok(texts.includes('AbortError'), '原因要带上，不然只知道出事、不知道出了什么事')
  assert.ok(texts.includes(internals.DICT.zh.toastDismiss), '得能点掉')
  assert.ok(internals.CSS.includes('.ph-toasts'), 'CSS 里必须真有这一块，不然渲染出来是散的')

  bag.items = []
  bag.seenAt = 0
})

test('toast 生产者：没有 useSession 的老客户端上整个不渲染（hook 规则）', () => {
  const Producer = internals.makeToastProducer((key) => key)
  assert.equal(Producer({}), null)
  assert.equal(Producer({ useSession: 'not-a-function' }), null)
  const tree = Producer({ useSession: () => false })
  assert.ok(tree && typeof tree.type === 'function', '有 useSession 时才把真正的生产者挂上去')
})

test('toast：用户自己撤回的回合不弹（不许把责任推给模型）', () => {
  const bag = internals.toastBag()
  bag.items = []
  bag.seenAt = 0

  assert.equal(
    internals.reportIssue({ lastIssue: { at: internals.LOADED_AT + 5, kind: 'aborted', error: 'boom' } }),
    null,
    '撤回是用户按的，不是模型出错')
  assert.equal(bag.items.length, 0)
  assert.equal(bag.seenAt, internals.LOADED_AT + 5, '水位线照样推进，免得以后翻旧账')

  bag.items = []
  bag.seenAt = 0
})
