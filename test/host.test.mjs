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
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

const HOME = await mkdtemp(join(tmpdir(), 'ph-test-'))
process.env.DSH_HOME = HOME

const mod = await import('../index.js')
const {
  DEFAULTS,
  collectText,
  dataDirectory,
  defaultsFromConfig,
  isTypedByUser,
  legacyDataDirectory,
  migrateDataDirectory,
  normalizeMode,
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
  assert.equal(dataDirectory(), join(HOME, 'prompt-hardener'))
  assert.equal(stateFile(), join(HOME, 'prompt-hardener', 'state.json'))
  assert.equal(promptFile(), join(HOME, 'prompt-hardener', 'prompt.md'))
  assert.equal(legacyDataDirectory(), join(HOME, 'ybb-optimizer'), '旧目录只留给迁移用')
})

/* ───────────────────────────── 目录迁移 ───────────────────────────── */

test('改名迁移：旧目录整体改名过来，用户文件一件不少', async () => {
  const before = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'ph-migrate-'))
  process.env.DSH_HOME = home
  try {
    const legacy = join(home, 'ybb-optimizer')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'prompt.md'), '用户手改过的提示词', 'utf8')
    await writeFile(join(legacy, 'state.json'), '{"intensity":"brutal"}', 'utf8')

    assert.equal(await migrateDataDirectory(), 'migrated')
    assert.equal(await readFile(promptFile(), 'utf8'), '用户手改过的提示词')
    assert.equal(await readFile(stateFile(), 'utf8'), '{"intensity":"brutal"}')
    await assert.rejects(() => stat(legacy), '旧目录不该还留在原地')
  } finally {
    process.env.DSH_HOME = before
  }
})

test('改名迁移：新目录已存在就收手，绝不拿旧数据覆盖', async () => {
  const before = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'ph-migrate-existing-'))
  process.env.DSH_HOME = home
  try {
    await mkdir(join(home, 'prompt-hardener'), { recursive: true })
    await writeFile(promptFile(), '新目录里的那份', 'utf8')
    const legacy = join(home, 'ybb-optimizer')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'prompt.md'), '旧目录里的那份', 'utf8')

    assert.equal(await migrateDataDirectory(), 'in-use', '已经有新目录了 = in-use，不是"没东西可迁"')
    assert.equal(await readFile(promptFile(), 'utf8'), '新目录里的那份')
    assert.equal(await readFile(join(legacy, 'prompt.md'), 'utf8'), '旧目录里的那份', '旧目录原封不动')
  } finally {
    process.env.DSH_HOME = before
  }
})

test('改名迁移：两个目录都没有时什么都不做（全新安装）', async () => {
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'ph-migrate-fresh-'))
  try {
    assert.equal(await migrateDataDirectory(), 'none')
  } finally {
    process.env.DSH_HOME = before
  }
})

test('回归：迁移必须排在激活信标之前（真机实测踩到的那条乱序）', async () => {
  // 这条在假 ctx 上原本看不见：假的 `effect` 是当场跑回调的，真 cordis 会延后。
  // 延后之后 enter 信标（它要 mkdir 数据目录）就可能先落地，而迁移一旦看见"新目录
  // 已经在用"就收手 —— 于是谁先谁后只取决于微任务怎么排，信标里那句 dataMigration
  // 也就不再是"这次到底迁了没"的可靠记录。
  // 所以这里把 effect 也做成延后的，把顺序钉死成显式的 await。
  const before = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'ph-order-'))
  process.env.DSH_HOME = home
  try {
    const legacy = join(home, 'ybb-optimizer')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'prompt.md'), '迁移哨兵', 'utf8')
    await writeFile(join(legacy, 'state.json'), '{"intensity":"brutal"}', 'utf8')

    const { ctx } = makeCtx(makeLlm(['x']), { deferEffect: true })
    mod.apply(ctx, { enabled: true, intensity: 'standard' })
    await new Promise((resolve) => setTimeout(resolve, 60))

    assert.equal(await readFile(promptFile(), 'utf8'), '迁移哨兵', '迁移必须赢，旧目录里的东西必须搬过来')
    assert.equal(JSON.parse(await readFile(stateFile(), 'utf8')).intensity, 'brutal', '开关状态也要一起过来')
    await assert.rejects(() => stat(legacy), '搬完就不该留着旧目录')

    const beacon = JSON.parse(await readFile(statusFile(), 'utf8'))
    assert.equal(beacon.dataMigration, 'migrated', '信标要如实记下"这次真的迁移了"')
    assert.equal(beacon.legacyLeftover, false, '没有残留才说明没把用户数据落在原地')
  } finally {
    process.env.DSH_HOME = before
  }
})

test('重复实例化（真机上插件被应用两次）：数据不许漏在原地，信标也要说人话', async () => {  // 2026-10-02 真机实测：插件被应用了两次，第二次的信标写着 `dataMigration: none`，
  // 看起来像"迁移没跑、用户数据被落在原地了"，其实第一次早就迁完了 —— 是**报告**在误导人。
  // 现在 `in-use`（有新目录了）和 `none`（压根没旧目录）分开，再配上 legacyLeftover，
  // 一眼就能分清"有人先动过手"和"真的漏了"。
  const before = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'ph-migrate-twice-'))
  process.env.DSH_HOME = home
  try {
    const legacy = join(home, 'ybb-optimizer')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'prompt.md'), '迁移哨兵', 'utf8')

    const first = makeCtx(makeLlm(['x']))
    mod.apply(first.ctx, { enabled: true, intensity: 'standard' })
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(JSON.parse(await readFile(statusFile(), 'utf8')).dataMigration, 'migrated')
    assert.equal(await readFile(promptFile(), 'utf8'), '迁移哨兵')

    // 第二次实例化 —— 真机上就是"插件又被 apply 了一遍"。
    const second = makeCtx(makeLlm(['x']))
    mod.apply(second.ctx, { enabled: true, intensity: 'standard' })
    await new Promise((resolve) => setTimeout(resolve, 40))

    const beacon = JSON.parse(await readFile(statusFile(), 'utf8'))
    assert.equal(beacon.dataMigration, 'in-use', '第二次该说实话：新目录已经有人在用了')
    assert.equal(beacon.legacyLeftover, false, '旧目录必须已经不在原地')
    assert.equal(await readFile(promptFile(), 'utf8'), '迁移哨兵', '数据仍然完好')
  } finally {
    process.env.DSH_HOME = before
  }
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
 * @param options.registerThrowsFor 只让**路径含这段字**的注册抛；用来验证"一条路由烂了不牵连另一条"。
 * @param options.deferEffect 让 `effect` 的回调**延后**跑 —— 真 cordis 就是这样，
 *   而"延后"正是"迁移被信标抢先"那条竞态的成因，所以复现它必须照抄这一点。
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
      const only = options.registerThrowsFor
      if (options.registerThrows) throw new Error(options.registerThrows)
      if (only && String(route.path).includes(only)) {
        throw new Error(`webserver: duplicate exact route "${route.path}"`)
      }
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
      if (options.deferEffect) {
        // 真 cordis 的子效应不是当场跑完的。照抄这一点，才能测出"谁先创建数据目录"。
        let dispose = null
        queueMicrotask(() => {
          dispose = fn()
        })
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      }
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
      if (options.services && name in options.services) return options.services[name]
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
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'ph-boot-'))
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

/**
 * 把一次请求真的打给某条已注册路由。
 *
 * `req` 用 `PassThrough`：`readJsonBody` 是流式读的，而 handler 会先 `await load()` 才去挂
 * 监听器。用 PassThrough 的暂停模式，body 会一直缓存到监听器挂上，不靠时序赌。
 *
 * @param routes makeCtx 收到的路由表。
 * @param path 目标路径。
 * @param options.method HTTP 方法；options.body 会被 JSON 序列化后作为请求体。
 * @returns {Promise<{status: number, body: object|null}>}
 */
async function callRoute(routes, path, options = {}) {
  const route = routes.find((item) => item.path === path)
  assert.ok(route, `路由没注册：${path}`)
  const method = options.method ?? 'GET'
  const req = new PassThrough()
  req.method = method
  // 同源写请求：isTrustedWrite 会看 origin 与 host 是否同一个。
  req.headers = { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387', 'sec-fetch-site': 'same-origin' }
  const res = {
    status: 0,
    raw: '',
    writeHead(code) {
      res.status = code
    },
    end(text) {
      res.raw = typeof text === 'string' ? text : ''
    },
  }
  const done = route.handler(req, res)
  req.end(options.body === undefined ? '' : JSON.stringify(options.body))
  await done
  return { status: res.status, body: res.raw.length > 0 ? JSON.parse(res.raw) : null }
}

/** 宿主的默认模型服务（真机上由 `dsh-agent-default-model` 提供）。 */
const DEFAULT_MODEL_SERVICE = {
  currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }),
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

test('两条路由都注册在 webServer 上', async () => {
  const llm = makeLlm(['x'])
  const { ctx, routes } = makeCtx(llm)
  await boot(ctx, { enabled: true, intensity: 'standard' })
  assert.equal(routes.length, 2)
  assert.deepEqual(
    routes.map((route) => route.path).sort(),
    [mod.REVIEW_ROUTE, mod.STATE_ROUTE].sort())
  assert.ok(routes.every((route) => route.kind === 'exact'))
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
  assert.equal(routes.length, 2, 'webServer 一就绪，两条路由都必须自己补上')
  assert.deepEqual(
    routes.map((route) => route.path).sort(),
    [mod.REVIEW_ROUTE, mod.STATE_ROUTE].sort())

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
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'ph-fidelity-'))
  await mkdir(join(process.env.DSH_HOME, 'prompt-hardener'), { recursive: true })
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

test('回归：一条路由注册失败也不许拖垮整个插件（"插件加载失败"那个故障）', async () => {
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'ph-mount-'))
  const llm = makeLlm(['x'])
  // HMR 重入时旧路由 disposer 还没跑，重复注册直接抛 duplicate exact route。
  // 只让**状态路由**抛：这样才能同时验证"烂掉的那条只记一笔"和"另一条照常注册上"。
  const { ctx, listeners, routes, provideWebServer } = makeCtx(llm, {
    webServer: 'later',
    registerThrowsFor: mod.STATE_ROUTE,
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
  assert.deepEqual(routes.map((route) => route.path), [mod.REVIEW_ROUTE], '烂的是状态路由，审查路由必须照常上')

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

/* ───────────────────── 审查模式：卡片与放行 ───────────────────── */
test('审查模式收敛进状态，出厂默认必须是自动', () => {
  assert.equal(DEFAULTS.mode, 'auto', '默认自动 = 老行为，不能让升级改变现有手感')
  assert.equal(sanitizeState({ mode: 'review' }).mode, 'review')
  assert.equal(sanitizeState({ mode: ' REVIEW ' }).mode, 'review')
  assert.equal(sanitizeState({ mode: '审查' }).mode, 'auto', '认不出的值回落到默认，不是报错')
  assert.equal(sanitizeState({}).mode, 'auto')
  assert.equal(normalizeMode('auto'), 'auto')
})

test('publicState 带上审查模式，浏览器半边才知道该不该拦', () => {
  assert.equal(publicState(sanitizeState({ mode: 'review' })).mode, 'review')
  assert.equal(publicState(sanitizeState({})).mode, 'auto')
})

test('审查路由：改写一遍并回传候选，路由来自宿主的默认模型服务', async () => {
  const llm = makeLlm(['老哥们，给我', '搞快点！'])
  const { ctx, routes } = makeCtx(llm, { services: { agentDefaultModel: DEFAULT_MODEL_SERVICE } })
  await boot(ctx, { enabled: true, intensity: 'standard', mode: 'review' })

  const answer = await callRoute(routes, mod.REVIEW_ROUTE, { method: 'POST', body: { text: '帮我写个脚本' } })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.ok, true)
  assert.equal(answer.body.text, '老哥们，给我搞快点！')
  assert.equal(answer.body.source, 'llm')
  assert.equal(answer.body.changed, true)
  assert.equal(answer.body.error, null)
  // 这条路上**没有 agent**（不是回合发起的），所以只能靠默认模型服务兜住。
  assert.equal(llm.calls.length, 1)
  assert.equal(llm.calls[0].provider, 'default-provider')
  assert.equal(llm.calls[0].model, 'default-model')
})

test('审查路由：插件显式配置优先于宿主默认模型', async () => {
  const llm = makeLlm(['x'])
  const { ctx, routes } = makeCtx(llm, { services: { agentDefaultModel: DEFAULT_MODEL_SERVICE } })
  await boot(ctx, {
    enabled: true,
    intensity: 'standard',
    llm: { provider: 'pinned-provider', model: 'pinned-model' },
  })

  const answer = await callRoute(routes, mod.REVIEW_ROUTE, { method: 'POST', body: { text: '帮我写个脚本' } })
  assert.equal(answer.body.ok, true)
  assert.equal(llm.calls[0].provider, 'pinned-provider')
  assert.equal(llm.calls[0].model, 'pinned-model')
})

test('审查路由：模型挂了就回落到规则拼接，并把原因原样带回卡片', async () => {
  const llm = makeBrokenLlm('boom')
  const { ctx, routes } = makeCtx(llm, { services: { agentDefaultModel: DEFAULT_MODEL_SERVICE } })
  await boot(ctx, { enabled: true, intensity: 'standard' })

  const answer = await callRoute(routes, mod.REVIEW_ROUTE, { method: 'POST', body: { text: '帮我写个脚本' } })
  assert.equal(answer.body.ok, true, '兜底成功就不算失败')
  assert.equal(answer.body.source, 'rules-fallback')
  assert.equal(answer.body.changed, true)
  assert.match(answer.body.error, /boom/, '原因必须带回卡片：审查模式下不许瞒着用户')
})

test('审查路由：关掉 / 火力关掉 / 本来就够硬，都直接回"不用改"', async () => {
  const disabled = makeCtx(makeLlm(['不该被调用']), { services: { agentDefaultModel: DEFAULT_MODEL_SERVICE } })
  await boot(disabled.ctx, { enabled: false, intensity: 'brutal' })
  const a = await callRoute(disabled.routes, mod.REVIEW_ROUTE, { method: 'POST', body: { text: '帮我写个脚本' } })
  assert.equal(a.body.skipped, 'disabled')
  assert.equal(a.body.changed, false)
  assert.equal(a.body.text, '帮我写个脚本', '不改就必须把原文还回去')

  const off = makeCtx(makeLlm(['不该被调用']), { services: { agentDefaultModel: DEFAULT_MODEL_SERVICE } })
  await boot(off.ctx, { enabled: true, intensity: 'off' })
  const b = await callRoute(off.routes, mod.REVIEW_ROUTE, { method: 'POST', body: { text: '帮我写个脚本' } })
  assert.equal(b.body.skipped, 'disabled')

  const hard = makeCtx(makeLlm(['不该被调用']), { services: { agentDefaultModel: DEFAULT_MODEL_SERVICE } })
  await boot(hard.ctx, { enabled: true, intensity: 'standard' })
  const c = await callRoute(hard.routes, mod.REVIEW_ROUTE, {
    method: 'POST',
    body: { text: '老哥们，搞快点，肌肉集团冲冲冲！' },
  })
  assert.equal(c.body.skipped, 'already-hardman')
  assert.equal(c.body.changed, false)
  assert.equal(hard.routes.length > 0, true)
})

test('审查路由：空正文与不认识的方法都被挡掉', async () => {
  const { ctx, routes } = makeCtx(makeLlm(['x']), { services: { agentDefaultModel: DEFAULT_MODEL_SERVICE } })
  await boot(ctx, { enabled: true, intensity: 'standard' })

  const empty = await callRoute(routes, mod.REVIEW_ROUTE, { method: 'POST', body: { text: '   ' } })
  assert.equal(empty.status, 400)
  assert.equal(empty.body.ok, false)

  const wrong = await callRoute(routes, mod.REVIEW_ROUTE, { method: 'DELETE' })
  assert.equal(wrong.status, 405)
})

test('放行登记：确认过的定稿不再被改写，而且只免检一次', async () => {
  const llm = makeLlm(['改写结果'])
  const { ctx, listeners, routes } = makeCtx(llm, { services: { agentDefaultModel: DEFAULT_MODEL_SERVICE } })
  await boot(ctx, { enabled: true, intensity: 'standard' })

  // 用户手工改温和了的定稿 —— 正是 looksHardman 判不出来的那种。
  const final = '帮我写个脚本（我改过的版本）'
  const ack = await callRoute(routes, mod.REVIEW_ROUTE, { method: 'PUT', body: { text: final } })
  assert.equal(ack.status, 200)
  assert.equal(ack.body.ok, true)

  const first = await runPreStep(listeners, message([{ type: 'text', text: final }]))
  assert.equal(first.messages[0].content[0].text, final, '确认过的定稿必须原样通过，不许被二次改写')
  assert.equal(llm.calls.length, 0, '不该为它再烧一次模型调用')

  // 一次性：同一条正文第二次出现时照常改写 —— 免检不能变成永久后门。
  const second = await runPreStep(listeners, message([{ type: 'text', text: final }]))
  assert.equal(second.messages[0].content[0].text, '改写结果')
  assert.equal(llm.calls.length, 1)
})

test('放行登记：比对时压掉空白差异，别让一个换行把免检搞失效', async () => {
  const llm = makeLlm(['不该被调用'])
  const { ctx, listeners, routes } = makeCtx(llm, { services: { agentDefaultModel: DEFAULT_MODEL_SERVICE } })
  await boot(ctx, { enabled: true, intensity: 'standard' })

  await callRoute(routes, mod.REVIEW_ROUTE, { method: 'PUT', body: { text: '帮我   写个脚本' } })
  const out = await runPreStep(listeners, message([{ type: 'text', text: '帮我 写个脚本\n' }]))
  assert.equal(out.messages[0].content[0].text, '帮我 写个脚本\n')
  assert.equal(llm.calls.length, 0)
})

test('放行登记：空正文不许登记（否则等于给"什么都不发"开后门）', async () => {
  const { ctx, routes } = makeCtx(makeLlm(['x']), { services: { agentDefaultModel: DEFAULT_MODEL_SERVICE } })
  await boot(ctx, { enabled: true, intensity: 'standard' })
  const answer = await callRoute(routes, mod.REVIEW_ROUTE, { method: 'PUT', body: { text: '  ' } })
  assert.equal(answer.status, 400)
})

test('放行登记不跨实例：HMR 换了实例，旧登记不生效', async () => {
  // 登记簿是**每个 apply 实例一份**的内存态。模块级放一份的话，热重载后旧登记会留着，
  // 而那正是"免检后门"最危险的样子：一次登记，之后同一条正文永远免检。
  const first = makeCtx(makeLlm(['x']), { services: { agentDefaultModel: DEFAULT_MODEL_SERVICE } })
  await boot(first.ctx, { enabled: true, intensity: 'standard' })
  const text = '帮我写个脚本'
  await callRoute(first.routes, mod.REVIEW_ROUTE, { method: 'PUT', body: { text } })

  const llm = makeLlm(['改写结果'])
  const second = makeCtx(llm, { services: { agentDefaultModel: DEFAULT_MODEL_SERVICE } })
  await boot(second.ctx, { enabled: true, intensity: 'standard' })
  const out = await runPreStep(second.listeners, message([{ type: 'text', text }]))
  assert.equal(out.messages[0].content[0].text, '改写结果', '新实例不认旧实例的登记')
})

test('回归：迁移过来的设置必须真的被读进来，不许被出厂默认覆盖写掉', async () => {
  // 真机实测踩到（2026-10-02）：迁移和"读状态文件"是同时起跑的，而迁移是异步改名。
  // 读盘那一刻新路径上还是空的 ⇒ 读到 ENOENT ⇒ 内存里是**出厂默认**（intensity=standard、
  // mode=auto）。用户自己选的档位与审查模式就此消失，而且第一轮统计一写盘还会把
  // 默认值**落回**状态文件，等于把用户的设置覆盖掉。
  // 所以 `load()` 必须等迁移跑完。
  const before = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'ph-migrate-state-'))
  process.env.DSH_HOME = home
  try {
    const legacy = join(home, 'ybb-optimizer')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'state.json'), JSON.stringify({
      enabled: true,
      intensity: 'insane',
      mode: 'review',
      stats: { rewrites: 3 },
      revision: 7,
    }), 'utf8')

    const { ctx, routes } = makeCtx(makeLlm(['x']))
    mod.apply(ctx, { enabled: true, intensity: 'standard', mode: 'auto' })
    await new Promise((resolve) => setTimeout(resolve, 60))

    const answer = await callRoute(routes, mod.STATE_ROUTE, { method: 'GET' })
    assert.equal(answer.body.ok, true)
    assert.equal(answer.body.state.intensity, 'insane', '用户选的档位必须活下来')
    assert.equal(answer.body.state.mode, 'review', '用户选的审查模式必须活下来')
    assert.equal(answer.body.state.revision, 7, 'revision 也要是文件里那份，而不是默认的 0')
  } finally {
    process.env.DSH_HOME = before
  }
})

test('迁移：目标只剩个空壳目录时也要把数据搬过来（Windows 上尤其致命）', async () => {
  // 场景：上一次迁移半途失败（Windows 上 `rename` 会因为目录里有文件被占用而失败，
  // 杀软/编辑器都可能造成这种占用），只留下一个**空**的新目录。
  // 如果按"新目录已存在就收手"处理，这个空壳会把此后每一次迁移都堵死 —— 用户的旧数据
  // 永远搬不过来，而且没有任何报错。所以她必须让路。
  const before = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'ph-migrate-shell-'))
  process.env.DSH_HOME = home
  try {
    await mkdir(join(home, 'prompt-hardener'), { recursive: true })
    const legacy = join(home, 'ybb-optimizer')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'prompt.md'), '迁移哨兵', 'utf8')
    await writeFile(join(legacy, 'state.json'), '{"intensity":"insane"}', 'utf8')

    assert.equal(await migrateDataDirectory(), 'migrated', '一个空壳不配挡住迁移')
    assert.equal(await readFile(promptFile(), 'utf8'), '迁移哨兵')
    assert.equal(JSON.parse(await readFile(stateFile(), 'utf8')).intensity, 'insane')
    await assert.rejects(() => stat(legacy), '搬完就不该留着旧目录')
  } finally {
    process.env.DSH_HOME = before
  }
})

test('状态路由：stats 按字段合并，不许整体替换（一次探针不能抹掉全部计数器）', async () => {
  // 2026-10-02 实测踩到：为了写一个诊断字段发 `{stats:{probeStage}}`，结果宿主的
  // rewrites / reviewCalls 全被抹平了 —— 因为状态路由对 `stats` 是整体替换。
  // 计数器之间互不相关，调用方只会想更新其中一个，所以必须是合并。
  const { ctx, routes } = makeCtx(makeLlm(['x']))
  await boot(ctx, { enabled: true, intensity: 'standard' })

  await callRoute(routes, mod.STATE_ROUTE, { method: 'PUT', body: { state: { stats: { reviewCalls: 7, rewrites: 3 } } } })
  await callRoute(routes, mod.STATE_ROUTE, { method: 'PUT', body: { state: { stats: { probeStage: 'x' } } } })

  const answer = await callRoute(routes, mod.STATE_ROUTE, { method: 'GET' })
  assert.equal(answer.body.state.stats.probeStage, 'x')
  assert.equal(answer.body.state.stats.reviewCalls, 7, '别的计数器不许被抹掉')
  assert.equal(answer.body.state.stats.rewrites, 3, '别的计数器不许被抹掉')
})
