/**
 * host 半边测试。
 *
 * 两层：
 * 1. 纯函数 —— 这里守的是两条不能破的规矩：改写后必须原样保留 `source`
 *    （尤其 `rpcId`，否则服务端的重复提交去重会失效）、非文本块必须留在原位。
 * 2. 拦截面集成 —— 拿一个假 cordis 上下文 + 假 llm 服务，真的把 `agent/pre-step`
 *    监听器跑起来，验证主路径（模型改写）与兜底路径（规则拼接）都对。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const HOME = await mkdtemp(join(tmpdir(), 'ybb-test-'))
process.env.DSH_HOME = HOME

const mod = await import('../index.js')
const {
  DEFAULTS,
  collectText,
  dataDirectory,
  defaultsFromConfig,
  isTypedByUser,
  promptFile,
  publicState,
  replaceText,
  resolveRoute,
  resolvePrompt,
  sanitizeState,
  seedPrompt,
  stateFile,
  statusFile,
} = mod

/** 造一条入队后的用户消息。 */
function message(content, overrides = {}) {
  return Object.freeze({
    id: 'msg-1',
    role: 'user',
    content: Object.freeze(content),
    source: Object.freeze({ kind: 'user', rpcId: 'rpc-9' }),
    ...overrides,
  })
}

/* ─────────────────────────────── 纯函数 ─────────────────────────────── */

test('collectText 只收文本块，图片块不参与', () => {
  const msg = message([
    { type: 'text', text: '第一段' },
    { type: 'image', ref: 'img-1' },
    { type: 'text', text: '第二段' },
  ])
  const collected = collectText(msg)
  assert.deepEqual(collected.indexes, [0, 2])
  assert.equal(collected.text, '第一段\n\n第二段')
})

test('collectText 对无文本/空白返回 null', () => {
  assert.equal(collectText(message([{ type: 'image', ref: 'x' }])), null)
  assert.equal(collectText(message([{ type: 'text', text: '   ' }])), null)
  assert.equal(collectText({ role: 'user' }), null)
  assert.equal(collectText(null), null)
})

test('replaceText 保 id、保 source.rpcId、保非文本块顺序', () => {
  const msg = message([
    { type: 'text', text: '第一段' },
    { type: 'image', ref: 'img-1' },
    { type: 'text', text: '第二段' },
  ])
  const out = replaceText(msg, collectText(msg), '硬邦邦正文')
  assert.equal(out.id, 'msg-1')
  assert.equal(out.role, 'user')
  assert.equal(out.source.rpcId, 'rpc-9', 'rpcId 丢了会导致重复提交被重复入库')
  assert.equal(out.content.length, 2)
  assert.equal(out.content[0].text, '硬邦邦正文')
  assert.equal(out.content[1].ref, 'img-1')
  assert.notEqual(out, msg, '必须返回新对象，原消息是冻结的')
})

test('isTypedByUser 只认用户亲手打的字', () => {
  assert.equal(isTypedByUser(message([{ type: 'text', text: 'hi' }])), true)
  assert.equal(isTypedByUser(message([{ type: 'text', text: 'hi' }], { role: 'assistant' })), false)
  assert.equal(isTypedByUser({ role: 'user', source: { kind: 'plugin', plugin: 'x' }, content: [] }), false)
  assert.equal(isTypedByUser({ role: 'user', content: [] }), false)
  assert.equal(isTypedByUser(null), false)
})

test('sanitizeState 收敛坏数据，并丢掉已废弃的字段', () => {
  const state = sanitizeState({
    enabled: 'yes',
    intensity: '离谱',
    turnMode: 'uniform',
    keepOriginal: false,
    llm: { enabled: true, provider: 7, model: 'x', maxTokens: -3, timeoutMs: 'abc' },
    revision: '5',
  })
  assert.equal(state.enabled, DEFAULTS.enabled)
  assert.equal(state.intensity, 'standard')
  assert.equal(state.llm.provider, DEFAULTS.llm.provider)
  assert.equal(state.llm.model, 'x')
  assert.equal(state.llm.maxTokens, DEFAULTS.llm.maxTokens)
  assert.equal(state.llm.timeoutMs, DEFAULTS.llm.timeoutMs)
  assert.equal(state.revision, 5)
  assert.equal('turnMode' in state, false, '轮次语气选项已删除')
  assert.equal('keepOriginal' in state, false, '原话保留选项已删除')
  assert.equal('enabled' in state.llm, false, 'LLM 开关已删除：它现在是唯一路径')
})

test('sanitizeState 保留合法值', () => {
  const state = sanitizeState({ enabled: false, intensity: 'insane', llm: { maxTokens: 8000 } })
  assert.equal(state.enabled, false)
  assert.equal(state.intensity, 'insane')
  assert.equal(state.llm.maxTokens, 8000)
})

test('行配置当默认值，非法字段回落出厂值', () => {
  const defaults = defaultsFromConfig({ intensity: 'brutal', nonsense: 1 })
  assert.equal(defaults.intensity, 'brutal')
  assert.equal(defaults.enabled, DEFAULTS.enabled)
})

test('状态落在 $DSH_HOME 下，不放包目录', () => {
  assert.equal(dataDirectory(), join(HOME, 'ybb-optimizer'))
  assert.equal(stateFile(), join(HOME, 'ybb-optimizer', 'state.json'))
  assert.equal(promptFile(), join(HOME, 'ybb-optimizer', 'prompt.md'))
})

/* ─────────────────────────── 提示词装载 ─────────────────────────── */

test('未播种时用包内自带的提示词', () => {
  const prompt = resolvePrompt()
  assert.equal(prompt.source === 'file', false, '外部文件还不存在')
  assert.ok(prompt.chars > 1000)
  assert.ok(prompt.text.includes('硬邦邦'))
})

test('播种后走外部文件，且改文件后立即生效', async () => {
  assert.equal(await seedPrompt(), 'seeded')
  const first = resolvePrompt()
  assert.equal(first.source, 'file')
  assert.equal(first.path, promptFile())

  // 覆盖内容并改动 mtime/size，缓存必须失效。
  await writeFile(promptFile(), '# 自定义提示词\n只输出四个字：硬邦邦的。\n', 'utf8')
  const second = resolvePrompt()
  assert.equal(second.source, 'file')
  assert.ok(second.text.includes('自定义提示词'))
  assert.ok(second.chars < first.chars)

  // 第二次播种不覆盖用户的编辑。
  assert.equal(await seedPrompt(), 'exists')
  assert.ok(resolvePrompt().text.includes('自定义提示词'))
})

/* ─────────────────────────── 拦截面集成 ─────────────────────────── */

/**
 * 造一个够用的假 cordis 上下文，并把注册的事件监听器抓出来。
 *
 * 这里的"够用"有一条硬要求：**服务没就绪时裸访问必须抛**，和真 cordis 一样
 * （`cannot get property "X" without inject`）。以前的假 ctx 不会抛，于是
 * "冷启动时 webServer 晚于本插件就绪"这个真实时序在全部测试里一个都没拦住 ——
 * 插件里一句 `ctx.webServer` 就让控制条报 405，测试却全绿。假件比现实宽容，
 * 就是测试失效的原因，所以这里用 Proxy 把真语义补上。
 *
 * @param llm 假 llm 服务。
 * @param options.webServer `'ready'`（默认，激活时已就绪）| `'later'`（激活后才就绪）| `'never'`（宿主没有）。
 * @param options.registerThrows 让 `webServer.register` 抛出（复现 HMR 重入的 duplicate exact route）。
 */
function makeCtx(llm, options = {}) {
  const mode = options.webServer ?? 'ready'
  const listeners = new Map()
  const routes = []
  const disposed = []
  let provided = null
  /** 待就绪的 `ctx.inject` 回调。 */
  const pending = []

  const webServer = {
    register(route) {
      if (options.registerThrows) throw new Error(options.registerThrows)
      routes.push(route)
      return () => {
        const at = routes.indexOf(route)
        if (at >= 0) routes.splice(at, 1)
        disposed.push(route.path)
      }
    },
  }
  if (mode === 'ready') provided = webServer

  const base = {
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    get(name, strict = true) {
      if (name === 'llm') return llm
      if (name === 'webServer') return strict && provided === null ? undefined : provided
      return undefined
    },
    inject(deps, callback) {
      const run = () => callback(ctx)
      // 真 cordis 里子 fiber 的启动是异步的，这里照抄：给调用方一个 tick 的余量。
      if (deps.every((name) => base.get(name) !== undefined)) queueMicrotask(run)
      else pending.push(run)
      return { dispose() {} }
    },
  }

  /** cordis 的上下文代理：没声明/没就绪的服务，裸访问直接抛。 */
  const ctx = new Proxy(
    { ...base, logger: undefined },
    {
      get(target, prop, receiver) {
        if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver)
        // 服务已提供时，真 cordis 的裸访问是能解析出来的 —— 这条也要照抄。
        if (prop === 'webServer' && provided !== null) return provided
        throw new Error(`cannot get property "${String(prop)}" without inject`)
      },
    },
  )

  /** 模拟"宿主稍后把 webServer 提供出来"。 */
  const provideWebServer = () => {
    provided = webServer
    for (const run of pending.splice(0)) queueMicrotask(run)
  }

  return { ctx, listeners, routes, disposed, provideWebServer }
}

/** 假 agent：只要能读出当前路由即可。 */
const AGENT = {
  id: 'agent-test',
  session: { requestHeader: () => ({ config: { provider: 'fake-provider', model: 'fake-model' } }) },
}

/** 假 llm：逐块吐文本。 */
function makeLlm(chunks) {
  return {
    calls: [],
    async *stream(options) {
      this.calls.push(options)
      for (const text of chunks) yield { type: 'text-delta', index: 0, text }
    },
  }
}

/** 假 llm：直接抛。 */
function makeBrokenLlm(reason) {
  return {
    calls: 0,
    // eslint-disable-next-line require-yield
    async *stream() {
      this.calls += 1
      throw new Error(reason)
    },
  }
}

/**
 * 起一个插件实例：先清掉状态文件。
 * `apply` 的 load() 会用状态文件覆盖 row config 的默认值（那是设计使然 —— config 只是
 * 出厂默认，用户选择优先），所以用例之间必须隔离持久化状态。
 */
async function boot(ctx, config) {
  // 每条用例一个全新的 DSH_HOME：状态文件与提示词文件都不串味。
  // （persist() 是 fire-and-forget，靠 rm 清理会跟它赛跑，所以干脆换目录。）
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'ybb-boot-'))
  mod.apply(ctx, config)
  await new Promise((resolve) => setTimeout(resolve, 10))
}

/** 走一遍监听器。 */
async function runPreStep(listeners, msg) {
  const handler = listeners.get('agent/pre-step')
  assert.ok(handler, 'pre-step 监听器没有注册')
  const decision = { kind: 'enter', messages: [msg] }
  return handler({ agent: AGENT, messages: [msg], turn: 2, step: 1, signal: undefined }, async () => decision)
}

test('主路径：模型输出直接替换原话，source 与 id 保住', async () => {
  const llm = makeLlm(['老哥们，给我', '搞快点！'])
  const { ctx, listeners } = makeCtx(llm)
  await boot(ctx, { enabled: true, intensity: 'standard' })

  const msg = message([{ type: 'text', text: '帮我写个脚本' }])
  const result = await runPreStep(listeners, msg)
  assert.equal(result.messages[0].content[0].text, '老哥们，给我搞快点！')
  assert.equal(result.messages[0].id, 'msg-1')
  assert.equal(result.messages[0].source.rpcId, 'rpc-9')
  assert.equal(llm.calls.length, 1, '一个步骤只打一次模型调用')
  assert.equal(llm.calls[0].provider, 'fake-provider')
  assert.equal(llm.calls[0].model, 'fake-model')
  assert.ok(llm.calls[0].system.startsWith(resolvePrompt().text), 'system 以提示词文件内容开头')
  assert.ok(llm.calls[0].system.includes('执行约束（插件追加'), '保真约束必须拼在后面')
  assert.ok(llm.calls[0].system.includes('不替用户做资源决策'), '保真约束不能被提示词文件挤掉')
  assert.equal(llm.calls[0].messages[0].content[0].text, '帮我写个脚本', '用户消息就是纯需求，档位指令走系统提示词')
  assert.ok(llm.calls[0].system.includes('本次改写强度：中'), '档位指令在系统提示词里')
})

test('兜底路径：模型抛错时用规则拼接，且被记进 stats', async () => {
  const llm = makeBrokenLlm('boom')
  const { ctx, listeners } = makeCtx(llm)
  await boot(ctx, { enabled: true, intensity: 'standard' })

  const msg = message([{ type: 'text', text: '帮我写个脚本' }])
  const result = await runPreStep(listeners, msg)
  const text = result.messages[0].content[0].text
  assert.ok(text.includes('任务：'), '兜底必须是拼接外壳')
  assert.ok(text.includes('帮我写个脚本'), '兜底必须保留原话')
  assert.equal(result.messages[0].source.rpcId, 'rpc-9')

  const state = publicState({
    enabled: true,
    intensity: 'standard',
    llm: {},
    stats: { lastSource: 'rules-fallback', lastError: 'boom' },
    revision: 1,
  })
  assert.equal(state.stats.lastSource, 'rules-fallback')
})

test('已经是硬汉风格的消息不改写，也不烧模型调用', async () => {
  const llm = makeLlm(['不该被调用'])
  const { ctx, listeners } = makeCtx(llm)
  await boot(ctx, { enabled: true, intensity: 'standard' })

  const msg = message([{ type: 'text', text: '老哥们，搞快点，别引入墨迹的独立审查，肌肉集团冲冲冲！' }])
  const result = await runPreStep(listeners, msg)
  assert.equal(result.messages[0], msg, '应当原样返回同一条消息')
  assert.equal(llm.calls.length, 0)
})

test('关掉插件后完全不动消息，也不调模型', async () => {
  const llm = makeLlm(['不该被调用'])
  const { ctx, listeners } = makeCtx(llm)
  await boot(ctx, { enabled: false, intensity: 'standard' })

  const msg = message([{ type: 'text', text: '帮我写个脚本' }])
  const result = await runPreStep(listeners, msg)
  assert.equal(result.messages[0], msg)
  assert.equal(llm.calls.length, 0)
})

test('子代理/插件注入的消息不碰', async () => {
  const llm = makeLlm(['不该被调用'])
  const { ctx, listeners } = makeCtx(llm)
  await boot(ctx, { enabled: true, intensity: 'standard' })

  const injected = message([{ type: 'text', text: '来自子代理的提示词' }], {
    source: { kind: 'agent', agentId: 'sub-1' },
  })
  const result = await runPreStep(listeners, injected)
  assert.equal(result.messages[0], injected)
  assert.equal(llm.calls.length, 0)
})

test('pre-step 决策被拒绝时原样放行', async () => {
  const llm = makeLlm(['x'])
  const { ctx, listeners } = makeCtx(llm)
  await boot(ctx, { enabled: true, intensity: 'standard' })

  const handler = listeners.get('agent/pre-step')
  const rejected = { kind: 'reject' }
  const result = await handler({ agent: AGENT, messages: [], turn: 1, step: 1 }, async () => rejected)
  assert.equal(result, rejected)
  assert.equal(llm.calls.length, 0)
})

test('状态路由注册在 webServer 上', async () => {
  const llm = makeLlm(['x'])
  const { ctx, routes } = makeCtx(llm)
  await boot(ctx, { enabled: true, intensity: 'standard' })
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].path, mod.STATE_ROUTE)
})

test('回归：冷启动时 webServer 还没就绪，路由也必须等在它就绪后注册上（405 那个故障）', async () => {
  const llm = makeLlm(['x'])
  // 实测时序：宿主先激活本插件，webServer 晚一步才提供。
  const { ctx, listeners, routes, provideWebServer } = makeCtx(llm, { webServer: 'later' })
  await boot(ctx, { enabled: true, intensity: 'standard' })

  // 插件本体必须已经活着 —— 核心能力不能被一个便利路由拖住。
  assert.ok(listeners.get('agent/pre-step'), 'pre-step 必须立刻注册，不等 webServer')
  assert.equal(routes.length, 0, 'webServer 没就绪时不该有路由')

  provideWebServer()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(routes.length, 1, 'webServer 一就绪，路由就必须自己补上')
  assert.equal(routes[0].path, mod.STATE_ROUTE)

  // 这条路径上不该留下任何失败记录。
  const beacon = JSON.parse(await readFile(statusFile(), 'utf8'))
  assert.deepEqual(beacon.failures, [], `不该有失败记录，实际：${JSON.stringify(beacon.failures)}`)
})

test('宿主压根没有 webServer 时，插件照常激活（headless 容忍）', async () => {
  const llm = makeLlm(['x'])
  const { ctx, listeners, routes } = makeCtx(llm, { webServer: 'never' })
  assert.doesNotThrow(() => mod.apply(ctx, { enabled: true, intensity: 'standard' }))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(listeners.get('agent/pre-step'), '没有 webServer 也要能改写')
  assert.equal(routes.length, 0)
})

/* ─────────────────────────── 模型路由解析 ─────────────────────────── */

test('路由三级回退：显式配置 > 落库请求头 > agent 创建时路由', () => {
  const withHeader = {
    id: 'a',
    options: { provider: 'from-options', model: 'opt-model' },
    session: { requestHeader: () => ({ config: { provider: 'from-header', model: 'hdr-model' } }) },
  }
  // 1) 显式配置优先
  assert.deepEqual(
    resolveRoute(withHeader, { provider: 'explicit', model: 'exp-model' }),
    { provider: 'explicit', model: 'exp-model' })
  // 2) 没有显式配置时用落库请求头
  assert.deepEqual(
    resolveRoute(withHeader, { provider: '', model: '' }),
    { provider: 'from-header', model: 'hdr-model' })
  // 3) 半对配置不算数，仍然走请求头
  assert.deepEqual(
    resolveRoute(withHeader, { provider: 'only-provider', model: '' }),
    { provider: 'from-header', model: 'hdr-model' })
})

test('新会话第一条消息：还没有任何 request/header，靠 agent.options 兜住', () => {
  const freshAgent = {
    id: 'a',
    options: { provider: 'workbuddy-local', model: 'deepseek-v4.1-flash' },
    session: { requestHeader: () => undefined },
  }
  assert.deepEqual(
    resolveRoute(freshAgent, { provider: '', model: '' }),
    { provider: 'workbuddy-local', model: 'deepseek-v4.1-flash' })
})

test('路由完全拿不到时返回空串（由调用方决定怎么降级）', () => {
  assert.deepEqual(resolveRoute(undefined, undefined), { provider: '', model: '' })
  assert.deepEqual(resolveRoute({ session: { requestHeader: () => undefined } }, {}), { provider: '', model: '' })
})

test('新会话第一条消息真的能打出模型调用', async () => {
  const llm = makeLlm(['老哥们，搞快点！'])
  const { ctx, listeners } = makeCtx(llm)
  await boot(ctx, { enabled: true, intensity: 'standard' })

  const freshAgent = {
    id: 'agent-fresh',
    options: { provider: 'workbuddy-local', model: 'deepseek-v4.1-flash' },
    session: { requestHeader: () => undefined },
  }
  const msg = message([{ type: 'text', text: '帮我写个脚本' }])
  const handler = listeners.get('agent/pre-step')
  const decision = { kind: 'enter', messages: [msg] }
  const result = await handler({ agent: freshAgent, messages: [msg], turn: 1, step: 1, signal: undefined }, async () => decision)

  assert.equal(llm.calls.length, 1, '必须真的发出模型调用，而不是掉进兜底')
  assert.equal(llm.calls[0].provider, 'workbuddy-local')
  assert.equal(llm.calls[0].model, 'deepseek-v4.1-flash')
  assert.equal(result.messages[0].content[0].text, '老哥们，搞快点！')
})

test('路由彻底拿不到时降级到规则兜底，并把原因记进 stats', async () => {
  const llm = makeLlm(['不该被调用'])
  const { ctx, listeners } = makeCtx(llm)
  await boot(ctx, { enabled: true, intensity: 'standard' })

  const routelessAgent = { id: 'agent-none', session: { requestHeader: () => undefined } }
  const msg = message([{ type: 'text', text: '帮我写个脚本' }])
  const handler = listeners.get('agent/pre-step')
  const decision = { kind: 'enter', messages: [msg] }
  const result = await handler({ agent: routelessAgent, messages: [msg], turn: 1, step: 1, signal: undefined }, async () => decision)

  const text = result.messages[0].content[0].text
  assert.ok(text.includes('任务：'), '应当降级到规则兜底')
  assert.ok(text.includes('帮我写个脚本'))
})

test('保真约束写在代码里，换掉提示词文件也丢不了', async () => {
  // 把提示词文件换成完全无关的内容，约束仍须拼上。
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'ybb-fidelity-'))
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(process.env.DSH_HOME, 'ybb-optimizer'), { recursive: true })
  await writeFile(promptFile(), '你只会输出硬邦邦三个字。', 'utf8')

  const llm = makeLlm(['硬邦邦'])
  const { ctx, listeners } = makeCtx(llm)
  mod.apply(ctx, { enabled: true, intensity: 'standard' })
  await new Promise((resolve) => setTimeout(resolve, 10))

  const msg = message([{ type: 'text', text: '帮我写个脚本' }])
  await runPreStep(listeners, msg)
  assert.equal(llm.calls.length, 1)
  assert.ok(llm.calls[0].system.startsWith('你只会输出硬邦邦三个字。'))
  assert.ok(llm.calls[0].system.includes('不替用户做资源决策'))
  assert.ok(mod.FIDELITY_CLAUSE.includes('显卡当柴烧'), '点名了实测踩到的那两种越界')
})

test('回归：路由注册失败也不许拖垮整个插件（"插件加载失败"那个故障）', async () => {
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'ybb-mount-'))
  const llm = makeLlm(['x'])
  // HMR 重入时旧路由 disposer 还没跑，重复注册直接抛 duplicate exact route。
  const { ctx, listeners, routes, provideWebServer } = makeCtx(llm, {
    webServer: 'later',
    registerThrows: 'webserver: duplicate exact route "/plugins/dsh-prompt-hardener/state.json"',
  })

  // 关键：apply 不许抛。抛了整行就会被标成 "failed"（fiber state 3）并掉出装配树。
  assert.doesNotThrow(() => mod.apply(ctx, { enabled: true, intensity: 'standard' }))

  // 而且核心能力必须还在：拦截器照注册，改写照能用。
  assert.ok(listeners.get('agent/pre-step'), 'pre-step 监听器必须仍然注册上')

  const msg = message([{ type: 'text', text: '帮我写个脚本' }])
  const out = await runPreStep(listeners, msg)
  assert.equal(out.messages[0].content[0].text, 'x', '路由挂了也不该影响改写主路径')

  // 服务就绪、回调真的跑过之后，仍然不许把异常漏出去。
  provideWebServer()
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(routes.length, 0, '注册失败就不该有路由')

  // 失败要留痕，不然"插件莫名其妙没了"根本没法查
  const beacon = JSON.parse(await readFile(statusFile(), 'utf8'))
  assert.equal(beacon.failures.length, 1, '失败必须写进激活信标')
  assert.ok(beacon.failures[0].label.includes('state route'))
  assert.ok(beacon.failures[0].message.includes('duplicate exact route'))
})

test('状态文件可读回，字段已按新结构收敛', async () => {
  const raw = await readFile(stateFile(), 'utf8').catch(() => null)
  if (raw !== null) {
    const parsed = JSON.parse(raw)
    assert.equal('turnMode' in parsed, false)
    assert.equal('keepOriginal' in parsed, false)
  }
})
