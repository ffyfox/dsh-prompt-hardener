/**
 * dsh-ybb-optimizer — host 半边。
 *
 * 只做四件事：
 *
 * 1. **拦截提示词**。在 `agent/pre-step` waterfall 上把用户原话换成硬邦邦版。
 *    这是官方文档记载的提示词拦截点：`decision.messages` 就是最终落库成
 *    `user/message`、也是模型真正读到的那份文本。`agent/request` 做不到
 *    （它的 `LlmCallConfig` 没有 messages 通道，且 invariant 要求请求等于日志的
 *    纯函数派生），所以这里没有第二条路。
 * 2. **做主路径改写**：把原话交给模型，按 `lib/prompt.md`（可外部编辑）全量重写。
 *    模型调用失败时回落到 `lib/fallback.js` 的规则拼接，保证这一轮不白跑。
 * 3. **持久化开关**。状态写在 `$DSH_HOME/ybb-optimizer/state.json`，不放在包目录里
 *    —— 包目录会被插件升级整体替换掉。
 * 4. **给浏览器半边供数**。注册一条 `webServer` 路由，供输入框控制条读写状态。
 *
 * 三条实现纪律：
 * - 只改写 `source.kind === 'user'` 的消息。子代理提示词、插件注入的上下文、
 *   运行时挂上来的 context 消息一律不碰。
 * - 改写时保留原 `source`（尤其 `source.rpcId`）：服务端靠它给重复提交去重，
 *   丢了会导致重试/重发被重复入库。
 * - 往回传决策时展开 `decision`（`{ ...decision, messages }`），否则会丢掉
 *   `startsRequestSeries` 之类的字段。
 *
 * @module dsh-ybb-optimizer
 */

import { readFileSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { INTENSITIES, assembleFallback, normalizeIntensity } from './lib/fallback.js'
import { looksHardman } from './lib/phrases.js'

/** Cordis 插件名。也是浏览器半边模块表的 key。 */
export const name = 'ybb-optimizer'

/**
 * 不硬依赖任何服务，这样"改写提示词"这个核心能力永远不会因为某个便利设施没就绪而上不来。
 *
 * 两个服务走两条不同的路，这个区别是实测踩出来的：
 * - `llm`：`ctx.get('llm')` 惰性获取。缺失时自动回落到规则拼接。
 * - `webServer`：**必须走 `ctx.inject(['webServer'], child => …)` 等它就绪**，不能裸访问。
 *   cordis 的上下文代理在服务没声明/没就绪时，裸访问 `ctx.webServer` 会直接抛
 *   `cannot get property "webServer" without inject`；而冷启动时 webServer 通常晚于
 *   本插件就绪，于是路由永远注册不上（控制条读到 405），插件本体却看着"正常"。
 *   `ctx.inject` 是 cordis 正规的"等依赖就绪"入口：服务一就绪就回调，回调拿到的子
 *   上下文里 webServer 是真正注入好的。若宿主根本没有 webServer，本插件照常激活，
 *   只是没有控制条（headless 宿主）。
 */
export const inject = []

/** 插件自己的数据目录名。 */
const DATA_DIRNAME = 'ybb-optimizer'
/** 状态文件名。 */
const STATE_FILENAME = 'state.json'
/** 外部可编辑的提示词文件名。 */
const PROMPT_FILENAME = 'prompt.md'
/** 浏览器半边读写的路由。 */
export const STATE_ROUTE = '/plugins/dsh-ybb-optimizer/state.json'
/** 请求体大小上限，避免被塞爆内存。 */
const MAX_BODY_BYTES = 64 * 1024

/** 出厂默认值。profile patch 里的 row config 覆盖它，用户界面的选择再覆盖两者。 */
const DEFAULTS = Object.freeze({
  enabled: true,
  intensity: 'standard',
  llm: Object.freeze({
    provider: '',
    model: '',
    /** 0 = 按原文长度自动估算。 */
    maxTokens: 0,
    timeoutMs: 30000,
  }),
})

/**
 * 火力档位说明，拼在用户消息前面一起发给模型。
 * `off` 不会走到这里（插件整体关掉）。
 */
export const INTENSITY_DIRECTIVE = Object.freeze({
  light: '本次改写强度：轻。保持简洁，只做必要的风格化，别堆砌辞藻；输出篇幅不超过原文 1.5 倍。',
  standard: '本次改写强度：中。按风格规范完整改写。',
  brutal: '本次改写强度：重。语气更暴躁，多用连珠炮和叠词；输出篇幅可到原文 2 倍。',
  insane: '本次改写强度：丧心病狂。火力全开：神化修辞、荒诞夸张、连珠炮、叠词全上；输出篇幅可到原文 2.5 倍。',
})

/**
 * 两个提示词文件都读不到时的紧急兜底（正常情况不会用到）。
 * 刻意写得短：它是最后一道防线，不是给用户调的那份。
 */
const BUILTIN_PROMPT = [
  '你是"硬邦邦提示词转换专家"。把用户给的需求改写成暴躁硬汉 / 土豪甲方 / 语音连珠炮风格的中文提示词。',
  '必须遵守：技术内容（技术栈、参数、数值、约束、验收标准）一律不得增删篡改或臆测；不替用户做资源决策；',
  '只输出改写后的正文，不要解释、不要元话语、不要代码块包裹。',
].join('\n')

/** 解析插件数据目录。 */
export function dataDirectory() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, DATA_DIRNAME)
}

/** 状态文件绝对路径。 */
export function stateFile() {
  return join(dataDirectory(), STATE_FILENAME)
}

/** 激活信标文件绝对路径。 */
export function statusFile() {
  return join(dataDirectory(), 'status.json')
}

/** 外部可编辑提示词的绝对路径。 */
export function promptFile() {
  return join(dataDirectory(), PROMPT_FILENAME)
}

/** 包内自带的默认提示词绝对路径。 */
export function bundledPromptFile() {
  return join(dirname(fileURLToPath(import.meta.url)), 'lib', PROMPT_FILENAME)
}

/**
 * 保真约束。**放在代码里而不是提示词文件里**：它是"不许丢技术内容"的最后一道闸，
 * 不能因为用户换了一份 prompt.md 就跟着消失。每次调用时另起一段拼在系统提示词后面，
 * ybb.md 原文一字不动。
 *
 * 第 2 条是实测逼出来的：只写"别替用户做资源决策"时，模型仍然会照着 ybb.md 的开场白
 * 硬写"agent team 这次算了"（替用户宣布没钱），给代码任务硬加"电脑烧了我都夸你有劲"。
 * 所以这里把这两种具体越界点名。
 */
export const FIDELITY_CLAUSE = [
  '## 执行约束（插件追加，优先级高于上面的风格规范）',
  '',
  '1. **保真优先**：需求里的技术内容 —— 技术栈、文件名、参数、数值、单位、约束、边界条件、验收标准 ——',
  '   一律不得增删、篡改或臆测。看不懂的地方照抄，不要自己编。',
  '2. **不替用户做资源决策**：是否调用子代理 / agent team、预算多少、算力多大，用户没说就不要替他决定，也不要暗示。',
  '   用户没提团队时，开场白里**不要出现"agent team"、"团队"、"子代理"这些字样**；用户没提硬件时，',
  '   不要写"显卡当柴烧""电脑烧了我都夸你有劲"这类算力宣言。保留"时间/钱不多、你搞快点、激进点、',
  '   别想那么多"的口吻就够了 —— 风格规范里那两句开场白只是口吻示例，不是必须照抄的模板。',
  '3. **只输出改写后的正文**：不要解释、不要"以下是改写结果"这类元话语、不要用代码块包裹、不要加前后缀说明。',
  '4. **用中文输出**。',
].join('\n')

/* ─────────────────────────────── 提示词装载 ─────────────────────────────── */

/**
 * 提示词缓存。按 mtime+size 失效，所以外部改 `prompt.md` 后**下一条消息就生效**，
 * 不需要重启应用（host 代码改动要热更，但这个数据文件不用）。
 */
const promptCache = { path: '', mtimeMs: -1, size: -1, text: '', source: 'builtin' }

/**
 * 读取一次提示词，带 mtime 缓存。同步实现：每次拦截只做一次 `statSync` + 极小文件
 * 读取，开销可以忽略，换来的是"改完立即生效"。
 *
 * 解析优先级：外部文件 → 包内自带 → 内置常量。
 * @returns {{ text: string, source: 'file'|'bundled'|'builtin', path: string, mtimeMs: number, chars: number }}
 */
export function resolvePrompt() {
  const candidates = [
    { path: promptFile(), source: 'file' },
    { path: bundledPromptFile(), source: 'bundled' },
  ]
  for (const candidate of candidates) {
    let info
    try {
      info = statSync(candidate.path)
    } catch {
      continue
    }
    if (!info.isFile()) continue
    try {
      if (promptCache.path === candidate.path
        && promptCache.mtimeMs === info.mtimeMs
        && promptCache.size === info.size
        && promptCache.text.trim().length > 0) {
        return {
          text: promptCache.text,
          source: promptCache.source,
          path: candidate.path,
          mtimeMs: info.mtimeMs,
          chars: promptCache.text.length,
        }
      }
      const text = readFileSync(candidate.path, 'utf8')
      if (text.trim().length === 0) continue
      promptCache.path = candidate.path
      promptCache.mtimeMs = info.mtimeMs
      promptCache.size = info.size
      promptCache.text = text
      promptCache.source = candidate.source
      return { text, source: candidate.source, path: candidate.path, mtimeMs: info.mtimeMs, chars: text.length }
    } catch {
      continue
    }
  }
  return {
    text: BUILTIN_PROMPT,
    source: 'builtin',
    path: '',
    mtimeMs: 0,
    chars: BUILTIN_PROMPT.length,
  }
}

/**
 * 首次激活时把包内自带的提示词播种到数据目录，用户随后直接改那一份就行。
 * 已存在则不覆盖（绝不吞掉用户的编辑）。
 * @returns {Promise<'seeded'|'exists'|'failed'>} 播种结果。
 */
export async function seedPrompt() {
  const target = promptFile()
  try {
    if (statSync(target).isFile()) return 'exists'
  } catch {
    /* 不存在就走播种 */
  }
  try {
    await mkdir(dirname(target), { recursive: true })
    await copyFile(bundledPromptFile(), target)
    return 'seeded'
  } catch {
    return 'failed'
  }
}

/* ─────────────────────────────── 状态收敛 ─────────────────────────────── */

/** 把未知输入收敛成布尔。 */
function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** 把未知输入收敛成非负数。 */
function nonNegative(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * 校验并规整一份状态。非法字段一律回落到默认值，绝不因为坏数据拒绝启动。
 * @param {unknown} raw 候选状态。
 * @param {object} defaults 兜底默认值。
 * @returns {object} 规整后的状态。
 */
export function sanitizeState(raw, defaults = DEFAULTS) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const llmRaw = source.llm && typeof source.llm === 'object' ? source.llm : {}
  return {
    enabled: bool(source.enabled, defaults.enabled),
    intensity: normalizeIntensity(source.intensity ?? defaults.intensity),
    llm: {
      provider: typeof llmRaw.provider === 'string' ? llmRaw.provider : defaults.llm.provider,
      model: typeof llmRaw.model === 'string' ? llmRaw.model : defaults.llm.model,
      maxTokens: nonNegative(llmRaw.maxTokens, defaults.llm.maxTokens),
      timeoutMs: nonNegative(llmRaw.timeoutMs, defaults.llm.timeoutMs) || defaults.llm.timeoutMs,
    },
    stats: source.stats && typeof source.stats === 'object' ? { ...source.stats } : {},
    revision: Number.isFinite(Number(source.revision)) ? Number(source.revision) : 0,
  }
}

/**
 * 从 row config 合成默认值。
 * @param {unknown} config cordis 行配置。
 * @returns {object} 默认状态。
 */
export function defaultsFromConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  return sanitizeState(raw, DEFAULTS)
}

/* ─────────────────────────────── 消息改写 ─────────────────────────────── */

/**
 * 从一条消息里挑出该改写的文本，其余块留在原位。
 *
 * 多个文本块会被合并进**第一个**文本块，非文本块（图片、文件引用）保持相对顺序不动。
 *
 * @param {object} message 一条 user 消息。
 * @returns {{ text: string, indexes: number[] } | null} 需要改写时返回合并文本与块下标。
 */
export function collectText(message) {
  const content = message && Array.isArray(message.content) ? message.content : null
  if (content === null) return null
  const indexes = []
  const parts = []
  for (let i = 0; i < content.length; i += 1) {
    const block = content[i]
    if (block && block.type === 'text' && typeof block.text === 'string') {
      indexes.push(i)
      parts.push(block.text)
    }
  }
  if (indexes.length === 0) return null
  const text = parts.join('\n\n')
  if (text.trim().length === 0) return null
  return { text, indexes }
}

/**
 * 用改写后的文本替换消息里的文本块，返回**新对象**（原消息是冻结的）。
 * @param {object} message 原消息。
 * @param {{ text: string, indexes: number[] }} collected 收集结果。
 * @param {string} rewritten 改写后的文本。
 * @returns {object} 新消息。
 */
export function replaceText(message, collected, rewritten) {
  const first = collected.indexes[0]
  const drop = new Set(collected.indexes.slice(1))
  const content = []
  for (let i = 0; i < message.content.length; i += 1) {
    if (drop.has(i)) continue
    content.push(i === first ? Object.freeze({ ...message.content[i], text: rewritten }) : message.content[i])
  }
  return Object.freeze({
    ...message,
    content: Object.freeze(content),
  })
}

/**
 * 判断一条消息是否属于"用户亲手打的字"。
 * @param {object} message 消息。
 * @returns {boolean} 是则返回 true。
 */
export function isTypedByUser(message) {
  if (!message || message.role !== 'user') return false
  const source = message.source
  return Boolean(source) && source.kind === 'user'
}

/** 读当前路由，读不到就返回空串。 */
function safeRequestHeader(agent) {
  try {
    const header = agent && agent.session && typeof agent.session.requestHeader === 'function'
      ? agent.session.requestHeader()
      : null
    const config = header && header.config ? header.config : {}
    return {
      provider: typeof config.provider === 'string' ? config.provider : '',
      model: typeof config.model === 'string' ? config.model : '',
    }
  } catch {
    return { provider: '', model: '' }
  }
}

/** 读 agent 的创建时路由（AgentOptions），读不到就返回空串。 */
function safeAgentOptions(agent) {
  try {
    const options = agent && agent.options ? agent.options : {}
    return {
      provider: typeof options.provider === 'string' ? options.provider : '',
      model: typeof options.model === 'string' ? options.model : '',
    }
  } catch {
    return { provider: '', model: '' }
  }
}

/**
 * 解析改写用的模型路由，三级回退：
 *
 * 1. 插件的 `llm.provider` + `llm.model`（两个都给才算数，避免配出半对）。
 * 2. 会话已落库的 `request/header.config` —— 这是当前真实路由，模型切换也会跟进。
 * 3. `agent.options` —— agent 创建时的路由。**新会话的第一条消息必须靠这一级**：
 *    那时还没有任何 `request/header` 落库，第 2 级一定是空的。
 *
 * @param {object} agent 当前 agent。
 * @param {object} [configured] 插件配置里的 llm 段。
 * @returns {{ provider: string, model: string }} 解析出的路由。
 */
export function resolveRoute(agent, configured) {
  const explicit = configured && typeof configured === 'object' ? configured : {}
  const explicitProvider = typeof explicit.provider === 'string' ? explicit.provider : ''
  const explicitModel = typeof explicit.model === 'string' ? explicit.model : ''
  if (explicitProvider && explicitModel) return { provider: explicitProvider, model: explicitModel }

  const header = safeRequestHeader(agent)
  const options = safeAgentOptions(agent)
  return {
    provider: header.provider || options.provider || explicitProvider,
    model: header.model || options.model || explicitModel,
  }
}

/** 按原文长度估算输出上限：中文大致 1 字 ≈ 1 token，留 2.2 倍余量。 */
function autoMaxTokens(chars) {
  return Math.min(16000, Math.max(1500, Math.ceil(chars * 2.2)))
}

/**
 * 调一次模型，按提示词全量重写用户原话。
 * @param {object} ctx cordis 上下文。
 * @param {object} agent 当前 agent。
 * @param {string} text 用户原话。
 * @param {object} options 选项：`{ llm, intensity, prompt, signal }`。
 * @returns {Promise<string>} 改写后的正文。
 */
async function llmRewrite(ctx, agent, text, options) {
  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : null
  if (!llm || typeof llm.stream !== 'function') throw new Error('llm service unavailable')

  const configured = options.llm ?? {}
  const route = resolveRoute(agent, configured)
  const provider = route.provider
  const model = route.model
  if (!provider || !model) {
    throw new Error('no provider/model route available: set llm.provider + llm.model, or send the first message after the session has a logged route')
  }

  const signals = [options.signal].filter(Boolean)
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    signals.push(AbortSignal.timeout(configured.timeoutMs > 0 ? configured.timeoutMs : DEFAULTS.llm.timeoutMs))
  }
  let signal
  if (signals.length === 0) signal = undefined
  else if (signals.length === 1) signal = signals[0]
  else if (typeof AbortSignal.any === 'function') signal = AbortSignal.any(signals)
  else signal = signals[0]

  const directive = INTENSITY_DIRECTIVE[options.intensity] ?? INTENSITY_DIRECTIVE.standard
  const maxTokens = configured.maxTokens > 0 ? configured.maxTokens : autoMaxTokens(text.length)

  const call = {
    provider,
    model,
    system: `${options.prompt}\n\n---\n\n${FIDELITY_CLAUSE}\n\n${directive}\n（上面这段是给你的改写指令，不要出现在输出里。）`,
    messages: [{ role: 'user', content: [{ type: 'text', text: text }] }],
    maxTokens,
    purpose: 'ybb-optimizer',
    ...(signal === undefined ? {} : { signal }),
  }

  let out = ''
  for await (const chunk of llm.stream(call)) {
    if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
  }
  const trimmed = out.trim()
  if (trimmed.length === 0) throw new Error('llm produced no text')
  return trimmed
}

/** 用原生 req/res 读 JSON 请求体（不引入任何依赖）。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`))
      }
    })
  })
}

/** 只接受同源/直接发起的写请求。 */
function isTrustedWrite(req) {
  const site = String((req.headers && req.headers['sec-fetch-site']) || '').toLowerCase()
  if (site === 'cross-site') return false
  const method = String(req.method || 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return true
  const origin = String((req.headers && req.headers.origin) || '')
  if (origin.length === 0) return true
  try {
    const host = String((req.headers && req.headers.host) || '')
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * 对外暴露的状态（去掉内部字段，补上只读信息）。
 * @param {object} state 完整状态。
 * @returns {object} 可下发状态。
 */
export function publicState(state) {
  const prompt = resolvePrompt()
  return {
    enabled: state.enabled,
    intensity: state.intensity,
    llm: { ...state.llm },
    stats: { ...state.stats },
    revision: state.revision,
    prompt: {
      path: prompt.path,
      source: prompt.source,
      chars: prompt.chars,
      editable: prompt.source === 'file',
    },
  }
}

/**
 * 插件入口。
 * @param {object} ctx cordis 上下文。
 * @param {object} [config] 行配置，作为默认值。
 */
export function apply(ctx, config) {
  const defaults = defaultsFromConfig(config)

  /** 内存态；磁盘是权威，内存只是缓存。 */
  let state = { ...defaults }
  let loaded = false
  /** 串行化写盘，避免并发 PUT 互相踩。 */
  let writeChain = Promise.resolve()

  const logger = (() => {
    try {
      return typeof ctx.logger === 'function' ? ctx.logger(name) : null
    } catch {
      return null
    }
  })()

  /** @param {string} message */
  const note = (message) => {
    if (logger && typeof logger.debug === 'function') logger.debug(message)
  }

  /** 子效应挂载过程中攒下来的失败。会写进 status.json，方便离线取证。 */
  const failures = []

  /**
   * 落一次激活信标（尽力而为）。
   * @param {object} extra 附加字段。
   */
  let beaconChain = Promise.resolve()
  const writeBeacon = (extra) => {
    const snapshot = JSON.stringify({
      activatedAt: Date.now(),
      pid: process.pid,
      node: process.version,
      route: STATE_ROUTE,
      stateFile: stateFile(),
      promptFile: promptFile(),
      failures,
      ...extra,
    }, null, 2)
    // 串行 + 先写临时文件再 rename：enter 与 ready 两笔是并发发起的，
    // 直接 writeFile 会把两次内容交错成非法 JSON（2026-09-29 实测踩到）。
    beaconChain = beaconChain.then(async () => {
      const file = statusFile()
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      await writeFile(tmp, snapshot, 'utf8')
      await rename(tmp, file)
    }).catch(() => {
      /* 信标是尽力而为的 */
    })
    return beaconChain
  }

  /**
   * 挂一个子效应。**任何一个子效应炸了都只记一笔，绝不把整个 plugin 带下水。**
   *
   * 教训（2026-09-29 实测）：路由注册一旦抛 `duplicate exact route`，`apply` 就会中断，
   * 整行被标成「插件加载失败」并从装配树里掉出去 —— 而那个路由只是给控制条用的便利设施，
   * 改写能力本身根本不依赖它。而且掉出去之后**不会自己重试**，必须等下一次文件变更事件
   * 才会重新 import + apply，表现就是"插件莫名其妙没了"。
   *
   * @param {Function} fn 效应体，返回清理函数。
   * @param {string} label 诊断用标签。
   */
  const mount = (fn, label) => {
    try {
      ctx.effect(fn, label)
    } catch (error) {
      const message = String((error && error.message) || error)
      failures.push({ label, message, at: Date.now() })
      note(`${label} failed: ${message}`)
    }
  }

  const persist = () => {
    const snapshot = JSON.stringify({ ...state, savedAt: Date.now() }, null, 2)
    writeChain = writeChain
      .then(async () => {
        const file = stateFile()
        await mkdir(dirname(file), { recursive: true })
        const tmp = `${file}.tmp`
        await writeFile(tmp, snapshot, 'utf8')
        await rename(tmp, file)
      })
      .catch((error) => {
        note(`persist failed: ${error && error.message}`)
      })
    return writeChain
  }

  const load = async () => {
    if (loaded) return state
    loaded = true
    try {
      const raw = await readFile(stateFile(), 'utf8')
      state = sanitizeState({ ...defaults, ...JSON.parse(raw) }, defaults)
    } catch {
      state = { ...defaults }
    }
    return state
  }

  // 先把磁盘态读进来；读盘期间 pre-step 用同步的默认值，不会阻塞首轮。
  void load()

  // apply 一进来就先落一笔。这一笔的有无能把两种情况分开：
  //   没有这一笔 → 模块压根没 import 成功（apply 根本没跑）；
  //   有这一笔、但 phase 停在 enter → apply 跑了，后面某个子效应炸了。
  // 排查"插件加载失败"时我缺的正是这个区分，所以补上。
  void writeBeacon({ phase: 'enter' })

  /* ─────────────────── 0. 激活准备：播种提示词 + 落就绪信标 ─────────────────── */

  mount(() => {
    let cancelled = false
    void (async () => {
      let promptSeed = 'failed'
      try {
        promptSeed = await seedPrompt()
      } catch {
        /* 播种失败不影响拦截，resolvePrompt 会退到包内自带那份 */
      }
      if (!cancelled) await writeBeacon({ phase: 'ready', promptSeed })
    })()
    return () => {
      cancelled = true
    }
  }, 'ybb-optimizer: activation beacon')

  /* ───────────────────────── 1. 提示词拦截 ───────────────────────── */

  mount(() => {
    const dispose = ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (!decision || decision.kind !== 'enter') return decision

      const current = state
      if (!current.enabled || current.intensity === 'off') return decision

      const messages = Array.isArray(decision.messages) ? decision.messages : []
      const prompt = resolvePrompt()
      let usedLlm = false
      let changed = false
      const out = []
      /** 本轮累积的统计补丁。 */
      const stat = {}

      for (const message of messages) {
        if (!isTypedByUser(message)) {
          out.push(message)
          continue
        }
        const collected = collectText(message)
        if (collected === null) {
          out.push(message)
          continue
        }
        if (looksHardman(collected.text)) {
          // 用户自己就写得很硬，别再套一层，也省一次模型调用。
          stat.skipped = Number(stat.skipped || 0) + 1
          stat.lastSkip = 'already-hardman'
          out.push(message)
          continue
        }

        let rewritten = null
        let source = null
        // 一个步骤里最多只打一次模型调用，避免成批入队时把延迟和账单翻倍。
        if (!usedLlm) {
          usedLlm = true
          try {
            rewritten = await llmRewrite(ctx, payload.agent, collected.text, {
              llm: current.llm,
              intensity: current.intensity,
              prompt: prompt.text,
              signal: payload.signal,
            })
            source = 'llm'
          } catch (error) {
            const reason = String((error && error.message) || error)
            note(`llm rewrite failed, falling back to rules: ${reason}`)
            stat.lastError = reason
          }
        }

        if (rewritten === null) {
          const fallback = assembleFallback(collected.text, {
            intensity: current.intensity,
            seed: `${payload.agent && payload.agent.id ? payload.agent.id : 'agent'}|${message.id ?? ''}`,
          })
          if (fallback.changed) {
            rewritten = fallback.text
            source = 'rules-fallback'
            stat.lastFallbackSlots = fallback.meta.slots
            stat.lastDomain = fallback.meta.domain
            stat.lastIntensity = fallback.meta.intensity
          }
        }

        if (rewritten === null) {
          stat.skipped = Number(stat.skipped || 0) + 1
          out.push(message)
          continue
        }

        changed = true
        out.push(replaceText(message, collected, rewritten))
        stat.lastSource = source
        stat.lastChars = rewritten.length
        stat.originalChars = collected.text.length
        stat.lastPromptSource = prompt.source
        stat.lastPromptChars = prompt.chars
      }

      if (Object.keys(stat).length > 0) {
        state = {
          ...state,
          stats: {
            ...state.stats,
            ...stat,
            rewrites: Number(state.stats.rewrites || 0) + (changed ? 1 : 0),
            ...(changed ? { lastAt: Date.now() } : {}),
          },
        }
        void persist()
      }
      if (!changed) return decision
      return { ...decision, messages: out }
    })
    return () => dispose()
  }, 'ybb-optimizer: agent/pre-step hardener')

  /* ───────────────────────── 2. 浏览器半边的状态路由 ───────────────────────── */

  mount(() => {
    const handler = async (req, res) => {
      const send = (code, payload) => {
        const body = JSON.stringify(payload)
        res.writeHead(code, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
        })
        res.end(body)
      }
      try {
        if (!isTrustedWrite(req)) {
          send(403, { ok: false, error: 'cross-site request rejected' })
          return
        }
        const method = String(req.method || 'GET').toUpperCase()
        await load()
        if (method === 'GET' || method === 'HEAD') {
          send(200, { ok: true, state: publicState(state), route: STATE_ROUTE, intensities: INTENSITIES })
          return
        }
        if (method !== 'PUT' && method !== 'POST') {
          send(405, { ok: false, error: `method not allowed: ${method}` })
          return
        }
        const body = await readJsonBody(req)
        const patch = body && typeof body === 'object' && body.state ? body.state : body
        state = sanitizeState({ ...state, ...(patch && typeof patch === 'object' ? patch : {}) }, defaults)
        state = { ...state, revision: Number(state.revision || 0) + 1 }
        await persist()
        send(200, { ok: true, state: publicState(state) })
      } catch (error) {
        send(400, { ok: false, error: String((error && error.message) || error) })
      }
    }

    // 冷启动的时序才是常态：宿主先激活本插件，webServer 晚一步才提供。旧写法在这里
    // 裸访问 `ctx.webServer` 兜底，结果必然抛 `cannot get property "webServer" without
    // inject` —— 抛出点又在轮询之前，于是路由一次都没注册上，控制条永远读到 405。
    // 现在改用 `ctx.inject`：等服务就绪再跑回调，不需要裸访问，也不需要自己轮询等待。
    const fiber = ctx.inject(['webServer'], (child) => {
      let disposer = null
      try {
        disposer = child.webServer.register({ kind: 'exact', path: STATE_ROUTE, handler })
      } catch (error) {
        // 上一次的 disposer 还没跑（HMR 重入）时会抛 duplicate exact route。
        // 记一笔就够了：旧 handler 仍读写同一份状态文件，功能不受影响 ——
        // 绝不能因为一个便利路由把整个插件搞成"加载失败"。
        const message = String((error && error.message) || error)
        failures.push({ label: 'ybb-optimizer: state route', message, at: Date.now() })
        note(`route registration failed: ${message}`)
        return () => {}
      }
      note(`state route registered: ${STATE_ROUTE}`)
      return () => {
        try {
          disposer()
        } catch {
          /* 已经卸掉就算了，卸载路径不该再抛 */
        }
      }
    })

    return () => {
      try {
        void fiber.dispose()
      } catch {
        /* 同上 */
      }
    }
  }, 'ybb-optimizer: state route')
}

export { DEFAULTS, INTENSITIES, BUILTIN_PROMPT }
