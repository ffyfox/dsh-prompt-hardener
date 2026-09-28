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
  assert.equal(registered.id, 'dsh-ybb-optimizer')
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
  assert.equal(module.name, 'dsh-ybb-optimizer')
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

  assert.ok(calls.locale.includes('ybb-optimizer'))
  assert.ok(calls.inject.includes('conversation.input.left'))
  assert.equal(calls.slots.length, 1)
  const entry = calls.slots[0]
  assert.equal(entry.options.name, 'conversation.input.left')
  assert.equal(entry.options.id, 'ybb-optimizer')
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
  // `white-space: pre-line` 加回 .ybb-hint —— 否则 HTML 会把换行折成空格，改了等于没改。
  const styleTag = documentStub.head.children.find((node) => node.id === 'ybb-optimizer-style')
  assert.ok(styleTag, '样式表没挂上')
})
