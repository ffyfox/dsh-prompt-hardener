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
  assert.equal(calls.slots.length, 1)
  const entry = calls.slots[0]
  assert.equal(entry.options.name, 'conversation.input.left')
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
        entry = { options, Component }
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

  // 说明文案必须是两行，"模型不可用"那句单独落在第二行
  const hint = textsOf(tree).find((x) => x.includes('提示词'))
  assert.ok(hint, '找不到说明文案')
  // 现在是单行疯味版。以前是两行、靠 CSS 的 pre-line 才不被折叠成一行 ——
  // 那个坑值得记着：只要说明里还想带 \n，就务必同时把 white-space 配好，否则等于没改。
  assert.ok(hint.includes('硬邦邦'), `说明要带硬邦邦的味：${hint}`)
  assert.ok(!hint.includes('硬汉风格'), `旧词应当已被替换掉：${hint}`)
  assert.ok(!hint.includes('\n'), `现在只保留一句，不该再有换行：${hint}`)
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

/* ─────────────── 审查态：window 上的袋子是唯一真相 ─────────────── */

const internals = registered.factory(() => ReactStub).__internals

test('写审查态会叫醒所有订阅者（"卡片永远停在改写中"那个 bug 的回归）', () => {
  // 真机实测踩到（2026-10-02）：在飞的改写请求回来时写的是 window 里那份，而挂载着的
  // 组件还在显示自己的旧快照 ⇒ 卡片永远停在"改写中"。修法是"写袋子 + 通知订阅者"，
  // 这条用例守的就是那句通知。
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
        entry = { options, Component }
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
  // 字数统计那一行整行删掉了，空出来的高度给了正文输入框（样式表那条 min-height 由
  // 下面的"样式表"用例守）。这里守的是"那一行真的不在树里了"。
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
        entry = { options, Component }
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

test('药丸只留名字：档位靠颜色和力量条标识，不再写"关/轻/中/重/狂"', () => {
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
        entry = { options, Component }
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
  // 名字可以省，力量条不能省 —— 它是现在唯一还在报档位的东西。
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

  // 字数统计那一行删掉后，空出来的 34px 必须还给正文输入框（92 → 126）。
  const editAt = css.indexOf('.ph-edit {')
  assert.ok(editAt > -1, '找不到正文输入框样式')
  const edit = css.slice(editAt, css.indexOf('}', editAt))
  assert.match(edit, /min-height:\s*126px/, '输入框没有吃掉字数统计空出来的高度')
  assert.equal(css.includes('.ph-meta'), false, '.ph-meta 已经没人用了，规则该删掉')

  // 删掉字数统计那一行时，按钮行与输入框之间就贴死了 —— 间隙原来是靠那一行的
  // 上下边距"顺带"提供的。这里把它钉住：真机上表现为输入框挤着按钮，只有肉眼看得见。
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
