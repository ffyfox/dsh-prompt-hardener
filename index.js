/**
 * dsh-prompt-hardener — host 半边。
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
 * 3. **持久化开关**。状态写在 `$DSH_HOME/prompt-hardener/state.json`，不放在包目录里
 *    —— 包目录会被插件升级整体替换掉。旧名 `ybb-optimizer` 的目录会在激活时整体迁移
 *    过来（见 `migrateDataDirectory`），所以改名不会丢用户手改的 prompt.md 和开关状态。
 * 4. **给浏览器半边供数**。注册一条 `webServer` 路由，供输入框控制条读写状态。
 *
 * 一个"就这一次"的入口（见 `lib/triggers.js`）：
 * - `!!` / `！！` 开头 = 本条强制改写（连"看着已经够硬"也压过去），`??` / `？？` 开头 = 本条原样放行。
 *   前缀只在插件开着时被解释，且一定会从正文里剥掉 —— 半角、全角都必须自成一段
 *   （后面跟空白或行尾），紧贴文字的符号一律当原文，详细取舍写在那个模块里。
 *
 * 三条实现纪律：
 * - 只改写 `source.kind === 'user'` 的消息。子代理提示词、插件注入的上下文、
 *   运行时挂上来的 context 消息一律不碰。
 * - 改写时保留原 `source`（尤其 `source.rpcId`）：服务端靠它给重复提交去重，
 *   丢了会导致重试/重发被重复入库。
 * - 往回传决策时展开 `decision`（`{ ...decision, messages }`），否则会丢掉
 *   `startsRequestSeries` 之类的字段。
 *
 * @module dsh-prompt-hardener
 */

import { readFileSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { INTENSITIES, assembleFallback, normalizeIntensity } from './lib/fallback.js'
import { looksHardman } from './lib/phrases.js'
import { parseTrigger } from './lib/triggers.js'

/** Cordis 插件名。也是浏览器半边模块表的 key。 */
export const name = 'prompt-hardener'

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
const DATA_DIRNAME = 'prompt-hardener'
/**
 * 改名前的数据目录名。
 *
 * 2026-09-29 那次改名（`dsh-ybb-optimizer` → `dsh-prompt-hardener`）**故意**没动这个目录，
 * 因为改了等于把用户手改的 `prompt.md` 和开关状态（`state.json`）一起弄丢。现在补一次
 * **带迁移**的改名：目录跟着产品名走，但旧目录会被整体搬过来，数据一件不少。
 */
const LEGACY_DATA_DIRNAME = 'ybb-optimizer'
/** 状态文件名。 */
const STATE_FILENAME = 'state.json'
/** 外部可编辑的提示词文件名。 */
const PROMPT_FILENAME = 'prompt.md'
/** 浏览器半边读写的路由。 */
export const STATE_ROUTE = '/plugins/dsh-prompt-hardener/state.json'
/**
 * 审查卡片的路由。一个路径两个动词，因为它们服务的是同一件事：
 * - `POST` `{ text }` → 改写一遍并回传候选定稿（**不发消息**，消息还躺在输入框里）。
 * - `PUT`  `{ text }` → 登记"这条是用户确认过的定稿"，让 pre-step 别再改写它。
 */
export const REVIEW_ROUTE = '/plugins/dsh-prompt-hardener/review'
/** 请求体大小上限，避免被塞爆内存。 */
const MAX_BODY_BYTES = 64 * 1024

/**
 * 审查模式。这两档只影响**浏览器半边**怎么发消息：
 * - `auto`：老行为 —— 点了发送就发出去，改写发生在宿主 `agent/pre-step` 里，发完改不了。
 * - `review`：点了发送先被浏览器半边拦下，弹一张卡片让人过一眼、改一改，确认了才真发。
 *
 * 宿主这边只多做一件事：认下"用户确认过的定稿"，别在 pre-step 里把它再改写一遍。
 */
export const MODES = Object.freeze(['auto', 'review'])

/** 出厂默认值。profile patch 里的 row config 覆盖它，用户界面的选择再覆盖两者。 */
const DEFAULTS = Object.freeze({
  enabled: true,
  intensity: 'standard',
  mode: 'auto',
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

/** 旧数据目录（改名前的名字），只用于迁移。 */
export function legacyDataDirectory() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, LEGACY_DATA_DIRNAME)
}

/**
 * 一次性迁移：新目录不存在、旧目录存在时，把旧目录**整体改名**过来。
 *
 * 三条纪律：
 * - 只做 `rename`，不做"复制后删"。改名是原子的：要么全过来，要么原封不动，
 *   不存在"复制到一半崩了，用户既没有旧数据也没有新数据"的中间态。
 * - **绝不预先创建目标目录**。它的父目录就是 `DSH_HOME`，而旧目录既然存在、父目录必然
 *   存在 —— 预建纯属多余。而且目标若已存在，只有**空目录**才让它让路：空壳里没有任何
 *   用户数据（是上一次迁移半途留下的），删掉再搬是安全的；非空就一律收手，绝不覆盖。
 * - 任何失败都只返回 `'failed'`，不抛、不改写、不删用户的任何文件。迁移失败最坏的结果
 *   是继续用包内自带提示词，而不是把用户的文件搞坏。
 *
 * 返回值把"没什么可迁"和"已经有人在用"分开，**因为这两件事的诊断含义完全不同**：
 * 2026-10-02 真机实测踩到过——插件被应用了两次，第二次看到新目录已存在，信标里写着
 * `dataMigration: none`，看起来像"迁移没跑、用户数据被落在原地了"，其实第一次早就迁完了。
 * 分开之后，看到 `in-use` 就知道是"有人先动过手"，而不是"漏了"。
 *
 * @returns {Promise<'none'|'in-use'|'migrated'|'failed'>} 迁移结果。
 */
export async function migrateDataDirectory() {
  const target = dataDirectory()
  const legacy = legacyDataDirectory()

  let targetExists = false
  try {
    targetExists = statSync(target).isDirectory()
  } catch {
    targetExists = false
  }
  let legacyExists = false
  try {
    legacyExists = statSync(legacy).isDirectory()
  } catch {
    legacyExists = false
  }

  if (!legacyExists) return targetExists ? 'in-use' : 'none'

  if (targetExists) {
    // 空壳让路；非空（真在用）就收手。`rmdir` 对非空目录会抛 ENOTEMPTY，所以这一句
    // 同时就是"它是不是空壳"的判据，不用自己去列目录。**这一条在 Windows 上尤其要命**：
    // 那边 `rename` 不允许覆盖已存在的目录，一次半途失败留下的空壳会把此后每一次迁移
    // 都堵死，而用户那边一点报错都看不到。
    try {
      await rmdir(target)
    } catch {
      return 'in-use'
    }
  }

  try {
    await rename(legacy, target)
    return 'migrated'
  } catch {
    return 'failed'
  }
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
 * 提示词正文一字不动。
 *
 * 第 2 条是实测逼出来的：只写"别替用户做资源决策"时，模型仍然会照着提示词里那两句开场白
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

/** 把未知输入收敛成合法审查模式。 */
export function normalizeMode(value, fallback = DEFAULTS.mode) {
  if (typeof value !== 'string') return fallback
  const id = value.trim().toLowerCase()
  return MODES.includes(id) ? id : fallback
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
    mode: normalizeMode(source.mode, defaults.mode),
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
 * 审查卡片用的模型路由。
 *
 * 这条路上**没有 agent**（不是某个回合发起的，消息还躺在输入框里），所以 `resolveRoute`
 * 的后两级回退（落库请求头 / agent 创建时路由）全都用不上。改成两级：
 *
 * 1. 插件的 `llm.provider` + `llm.model`（用户显式钉死）；
 * 2. 宿主的默认模型服务 `agentDefaultModel` —— 这正是"下一条消息会用哪个模型"。
 *
 * @param {object} ctx cordis 上下文。
 * @param {object} configured 插件配置里的 llm 段。
 * @returns {{ provider: string, model: string }} 解析出的路由。
 */
function reviewRoute(ctx, configured) {
  const explicit = configured && typeof configured === 'object' ? configured : {}
  const provider = typeof explicit.provider === 'string' ? explicit.provider : ''
  const model = typeof explicit.model === 'string' ? explicit.model : ''
  if (provider && model) return { provider, model }

  let picked = null
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null
    if (service && typeof service.currentSelection === 'function') picked = service.currentSelection()
  } catch {
    /* 宿主没装这个服务就当没有，交给调用方按"没有路由"降级 */
  }
  const fallback = picked && typeof picked === 'object' ? picked : {}
  return {
    provider: provider || (typeof fallback.provider === 'string' ? fallback.provider : ''),
    model: model || (typeof fallback.model === 'string' ? fallback.model : ''),
  }
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
    purpose: 'prompt-hardener',
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

/**
 * 改写一条文本：模型优先，模型不可用 / 没路由 / 吐空时回落到规则拼接。
 *
 * **pre-step 与审查卡片共用这一条。** 两边各写一份迟早会漂移，而"审查卡片上看到的"
 * 与"不审查直接发出去得到的"必须是同一个东西 —— 否则审查模式就变成了另一套行为。
 *
 * @param {object} ctx cordis 上下文。
 * @param {object|null} agent 当前 agent。审查卡片那条路上**没有 agent**（不是回合发起的）。
 * @param {string} text 待改写正文。
 * @param {object} options `{ llm, intensity, prompt, signal, seed, allowLlm }`。
 * @returns {Promise<{ text: string, changed: boolean, source: string|null, error: string|null, meta: object|null }>}
 *          `changed: false` 表示连规则兜底都没能改动它（调用方按"原样放行"处理）。
 */
async function rewriteText(ctx, agent, text, options) {
  let candidate = null
  let source = null
  let error = null

  if (options.allowLlm !== false) {
    try {
      candidate = await llmRewrite(ctx, agent, text, options)
      source = 'llm'
    } catch (cause) {
      error = String((cause && cause.message) || cause)
    }
  }

  if (candidate === null) {
    const fallback = assembleFallback(text, { intensity: options.intensity, seed: options.seed })
    if (fallback.changed) {
      return { text: fallback.text, changed: true, source: 'rules-fallback', error, meta: fallback.meta }
    }
  }

  if (candidate === null) return { text, changed: false, source: null, error, meta: null }
  return { text: candidate, changed: true, source, error, meta: null }
}

/**
 * 一条用户正文的"这一条该怎么办"。
 *
 * **pre-step 与审查卡片共用这一条**，理由和 `rewriteText` 一样：两边各写一份迟早漂移，
 * 而"卡片上看到的"与"不审查直接发出去得到的"必须是同一个东西。
 *
 * 两条判定顺序是有意的：
 * 1. 先剥前缀 —— 后面所有判断、连同比对放行登记，用的都是**剥掉之后**的正文。
 * 2. `??` 直接跳过，连 `!!` 都压不过它（同一条消息上两个前缀不会同时命中，见 triggers.js）。
 *
 * @param {string} text 用户原话（**还没剥前缀**）。
 * @param {object} current 当前状态。
 * @returns {{ body: string, trigger: string|null, skip: boolean, force: boolean,
 *   intensity: string, stripped: boolean }}
 *   `intensity` 是这一条实际要用的档位（就是插件当前那一档）。
 */
function planForText(text, current) {
  const parsed = parseTrigger(text)
  const stripped = parsed.trigger !== null
  const body = stripped ? parsed.text : text
  const intensity = normalizeIntensity(current.intensity)

  return {
    body,
    trigger: parsed.trigger,
    skip: parsed.skip,
    force: parsed.force,
    intensity,
    stripped,
  }
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
    mode: state.mode,
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
    //
    // 而且**每一笔信标都必须排在数据目录迁移之后**：写信标要 `mkdir` 数据目录，
    // 一旦它先跑，迁移就会看见"新目录已经在用"而收手，用户的旧 prompt.md 与开关
    // 状态就被悄悄落在原地了。这里用 await 把顺序钉死，不靠"谁的微任务先排上"。
    beaconChain = beaconChain.then(async () => {
      await dataMigration
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

  /**
   * 迁移**必须最先起跑，而且是同步起跑**：它要排在两个对手前面 ——
   * 1. enter 信标（它要 `mkdir` 数据目录）。信标先落地的话，迁移会看见"新目录已经在用"
   *    就收手，用户手改的 `prompt.md` 与开关状态被静默地落在旧目录里。
   * 2. `load()` 读状态文件。迁移是**异步改名**，读盘那一刻新路径上还是空的 ⇒ 读到 ENOENT
   *    ⇒ 内存里是出厂默认（intensity=standard、mode=auto）⇒ 用户自己选的档位与审查模式
   *    消失，而且第一轮统计一写盘还会把默认值落回状态文件，等于把用户的设置覆盖掉。
   *    （这条 2026-10-02 真机实测踩到过，见 test/host.test.mjs 里那两条回归。）
   *
   * 所以：promise 在这里先起出来，`load()` 与信标链都 await 它。
   * 迁移失败不抛（`catch` 成 `'failed'`），它绝不能拦住插件本体。
   */
  const dataMigration = migrateDataDirectory().catch(() => 'failed')

  const load = async () => {
    if (loaded) return state
    loaded = true
    // 等迁移跑完再读盘，理由见上面第 2 条。
    await dataMigration
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

  /* ───────────────── 0.5 审查模式的"已确认定稿"登记簿 ───────────────── */

  /**
   * 审查模式下用户点过"发出"的定稿。pre-step 见到与它逐字相同的用户消息就**跳过改写**。
   *
   * 为什么非要有这个东西：卡片上发出的定稿是**已经在审查路由里改写过的**，如果放它
   * 再走一遍 pre-step，就等于改写两次（第二次还可能把用户的手改冲掉）。所以放行前先
   * 在这里记一笔，pre-step 认领时按正文匹配、**用过即作废**。
   *
   * 三条约束：
   * - 只认**完全相同**的正文（比对前压掉空白差异）。认不出就照常改写 —— 保守的那一边
   *   是"多改写一次"，而不是"拿一条没登记的正文去免检"。
   * - 一次性：消费掉就删，避免同一条正文第二次出现时被误免检。
   * - 有上限也有保质期：万一登记了却没发出（用户点了发出又切走），也不会永远堆着。
   */
  const released = []
  const RELEASED_MAX = 8
  const RELEASED_TTL_MS = 10 * 60 * 1000

  /** 比对用的归一化：只压空白，不改内容。 */
  const releaseKey = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()

  /** 登记一条"已确认定稿"。 */
  const markReleased = (text) => {
    const key = releaseKey(text)
    if (key.length === 0) return
    const at = released.findIndex((item) => item.key === key)
    if (at >= 0) released.splice(at, 1)
    released.push({ key, at: Date.now() })
    while (released.length > RELEASED_MAX) released.shift()
  }

  /**
   * 消费一条登记。命中即删。
   * @param {string} text 即将进入 pre-step 的用户正文。
   * @returns {boolean} 是否是用户已经确认过的定稿。
   */
  const consumeReleased = (text) => {
    const now = Date.now()
    while (released.length > 0 && now - released[0].at > RELEASED_TTL_MS) released.shift()
    const key = releaseKey(text)
    if (key.length === 0) return false
    const at = released.findIndex((item) => item.key === key)
    if (at < 0) return false
    released.splice(at, 1)
    return true
  }

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
      // 迁移在 apply 的同步前缀里就起出来了（见 `dataMigration`），这里只等它的结果。
      // 顺序仍是硬要求：迁移**必须**先于播种 —— 反过来的话 seedPrompt 会先把新目录建出来
      // 并塞进一份 prompt.md，之后 `rename` 撞上非空目录会以 ENOTEMPTY 失败，
      // 用户的旧数据就永远搬不过来了。
      const migration = await dataMigration
      try {
        promptSeed = await seedPrompt()
      } catch {
        /* 播种失败不影响拦截，resolvePrompt 会退到包内自带那份 */
      }
      // 旧目录还在不在 —— 迁移失败或又一次实例化之后，这是唯一能一眼看出
      // "用户的旧数据是不是被落在原地了"的字段。
      let legacyLeftover = false
      try {
        legacyLeftover = statSync(legacyDataDirectory()).isDirectory()
      } catch {
        /* 不在就是不在了 */
      }
      if (!cancelled) await writeBeacon({ phase: 'ready', promptSeed, dataMigration: migration, legacyLeftover })
    })()
    return () => {
      cancelled = true
    }
  }, 'prompt-hardener: activation beacon')

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
      /** 有消息被换掉（改写，或者只是剥掉了前缀）—— 决定要不要回传新的 messages。 */
      let mutated = false
      /** 真的有消息被改写 —— 只影响 `stats.rewrites`，剥前缀不算改写。 */
      let rewrote = false
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
        const plan = planForText(collected.text, current)

        /**
         * 把这条消息放回结果。`replacement` 是字符串时换掉正文（剥前缀 / 改写），
         * 否则原样放回 —— 注意"原样"是**真的原对象**，一个字节都不动。
         */
        const emit = (replacement) => {
          if (typeof replacement !== 'string') {
            out.push(message)
            return
          }
          out.push(replaceText(message, collected, replacement))
          mutated = true
        }

        // 放行登记按**原话与剥掉前缀那份**各认一次：审查卡片上点"按原文发出"时发的是
        // 用户原话（可能带 `??`），而卡片自己的改写走的是剥掉前缀那份，两份都得认。
        const released = consumeReleased(collected.text) || (plan.stripped && consumeReleased(plan.body))
        if (released) {
          // 审查模式下用户刚在卡片上确认过的**定稿**：模型已经改写过了，不能再改写一遍。
          //
          // 这里绝不能指望 looksHardman 兜底：用户手工把定稿改温和的时候它判不出来，
          // 那样就会静默覆盖用户的编辑 —— 而"能改"正是这个功能存在的理由。
          stat.reviewReleased = Number(stat.reviewReleased || 0) + 1
          stat.lastSkip = 'review-released'
          emit(plan.stripped ? plan.body : undefined)
          continue
        }
        if (plan.skip) {
          stat.skipped = Number(stat.skipped || 0) + 1
          stat.lastSkip = 'trigger-skip'
          stat.lastTrigger = plan.trigger
          emit(plan.stripped ? plan.body : undefined)
          continue
        }
        if (!plan.force && looksHardman(plan.body)) {
          // 用户自己就写得很硬，别再套一层，也省一次模型调用。
          // `!!` 是例外：那是"我知道它看着已经够硬了，我还是要重写"的明确命令。
          stat.skipped = Number(stat.skipped || 0) + 1
          stat.lastSkip = 'already-hardman'
          emit(plan.stripped ? plan.body : undefined)
          continue
        }

        // 一个步骤里最多只打一次模型调用，避免成批入队时把延迟和账单翻倍。
        // 注意 `usedLlm` 在**调用前**就置位：第一次失败之后剩下的消息直接走规则兜底，
        // 不再逐条重试模型（否则一条坏消息能让整批消息各等一次超时）。
        const allowLlm = !usedLlm
        usedLlm = true

        const outcome = await rewriteText(ctx, payload.agent, plan.body, {
          llm: current.llm,
          intensity: plan.intensity,
          prompt: prompt.text,
          signal: payload.signal,
          allowLlm,
          seed: `${payload.agent && payload.agent.id ? payload.agent.id : 'agent'}|${message.id ?? ''}`,
        })
        if (outcome.error) {
          note(`llm rewrite failed, falling back to rules: ${outcome.error}`)
          stat.lastError = outcome.error
        }

        if (!outcome.changed) {
          stat.skipped = Number(stat.skipped || 0) + 1
          emit(plan.stripped ? plan.body : undefined)
          continue
        }

        if (outcome.meta) {
          stat.lastFallbackSlots = outcome.meta.slots
          stat.lastDomain = outcome.meta.domain
          stat.lastIntensity = outcome.meta.intensity
        }

        rewrote = true
        emit(outcome.text)
        stat.lastSource = outcome.source
        stat.lastChars = outcome.text.length
        stat.originalChars = plan.body.length
        stat.lastPromptSource = prompt.source
        stat.lastPromptChars = prompt.chars
        if (plan.trigger) stat.lastTrigger = plan.trigger
      }

      if (Object.keys(stat).length > 0) {
        state = {
          ...state,
          stats: {
            ...state.stats,
            ...stat,
            rewrites: Number(state.stats.rewrites || 0) + (rewrote ? 1 : 0),
            ...(rewrote ? { lastAt: Date.now() } : {}),
          },
        }
        void persist()
      }
      if (!mutated) return decision
      return { ...decision, messages: out }
    })
    return () => dispose()
  }, 'prompt-hardener: agent/pre-step hardener')

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
          send(200, { ok: true, state: publicState(state), route: STATE_ROUTE, intensities: INTENSITIES, modes: MODES })
          return
        }
        if (method !== 'PUT' && method !== 'POST') {
          send(405, { ok: false, error: `method not allowed: ${method}` })
          return
        }
        const body = await readJsonBody(req)
        const patch = body && typeof body === 'object' && body.state ? body.state : body
        const next = { ...state, ...(patch && typeof patch === 'object' ? patch : {}) }
        // `stats` 是**按字段合并**，不是整体替换。它是一堆互不相关的计数器，调用方通常只想
        // 更新其中一个（只报一项统计、写一个诊断字段），整体替换会静默抹掉其余全部 ——
        // 2026-10-02 实测踩到：一次 `{stats:{probeStage}}` 就把 rewrites / reviewCalls 抹平了。
        if (patch && typeof patch === 'object' && patch.stats && typeof patch.stats === 'object') {
          next.stats = { ...state.stats, ...patch.stats }
        }
        state = sanitizeState(next, defaults)
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
        failures.push({ label: 'prompt-hardener: state route', message, at: Date.now() })
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
  }, 'prompt-hardener: state route')

  /* ───────────────────────── 3. 审查卡片的路由 ───────────────────────── */

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
        const body = method === 'GET' || method === 'HEAD' ? null : await readJsonBody(req)
        const text = body && typeof body.text === 'string' ? body.text : ''

        // 登记放行：用户已经在卡片上确认过了，pre-step 不许再改写。
        if (method === 'PUT') {
          if (text.trim().length === 0) {
            send(400, { ok: false, error: 'text required' })
            return
          }
          markReleased(text)
          state = { ...state, stats: { ...state.stats, reviewReleases: Number(state.stats.reviewReleases || 0) + 1 } }
          void persist()
          send(200, { ok: true })
          return
        }

        // 改写候选：只回传正文，**不动机器状态、不碰消息**（消息还在输入框里）。
        if (method === 'POST') {
          if (text.trim().length === 0) {
            send(400, { ok: false, error: 'text required' })
            return
          }
          const current = state
          const patch = { reviewCalls: Number(current.stats.reviewCalls || 0) + 1, lastReviewAt: Date.now() }

          // 整体关掉 / 火力关掉时，审查卡片没有任何东西可审 —— 直接告诉它"原样发出"。
          if (!current.enabled || current.intensity === 'off') {
            state = { ...state, stats: { ...state.stats, ...patch } }
            void persist()
            send(200, { ok: true, skipped: 'disabled', changed: false, text, source: null })
            return
          }
          // 和 pre-step 共用同一条判定：卡片上看到的必须是"不审查直接发出去"会得到的那个东西。
          const plan = planForText(text, current)
          /** 跳过时回给卡片的是**剥掉前缀那份**，它会原样发出去（见 client 的 release）。 */
          const skip = (reason) => {
            state = {
              ...state,
              stats: {
                ...state.stats,
                ...patch,
                lastSkip: reason,
                ...(plan.trigger ? { lastTrigger: plan.trigger } : {}),
              },
            }
            void persist()
            send(200, { ok: true, skipped: reason, changed: false, text: plan.body, source: null })
          }

          if (plan.skip) {
            skip('trigger-skip')
            return
          }
          if (!plan.force && looksHardman(plan.body)) {
            skip('already-hardman')
            return
          }

          const prompt = resolvePrompt()
          const route = reviewRoute(ctx, current.llm)
          const outcome = await rewriteText(ctx, null, plan.body, {
            // 路由在这里是**显式**给全的：`resolveRoute` 见到成对的 provider/model 就直接返回，
            // 不需要（也没有）一个 agent 来兜底。
            llm: { ...current.llm, provider: route.provider, model: route.model },
            intensity: plan.intensity,
            prompt: prompt.text,
            seed: `review|${Date.now()}`,
          })

          state = {
            ...state,
            stats: {
              ...state.stats,
              ...patch,
              ...(outcome.error ? { lastError: outcome.error } : {}),
              ...(plan.trigger ? { lastTrigger: plan.trigger } : {}),
              lastReviewSource: outcome.source,
              lastReviewChanged: outcome.changed,
            },
          }
          void persist()
          send(200, {
            ok: true,
            changed: outcome.changed,
            text: outcome.text,
            source: outcome.source,
            error: outcome.error ?? null,
            promptSource: prompt.source,
            intensity: plan.intensity,
          })
          return
        }

        send(405, { ok: false, error: `method not allowed: ${method}` })
      } catch (error) {
        send(400, { ok: false, error: String((error && error.message) || error) })
      }
    }

    const fiber = ctx.inject(['webServer'], (child) => {
      let disposer = null
      try {
        disposer = child.webServer.register({ kind: 'exact', path: REVIEW_ROUTE, handler })
      } catch (error) {
        // 同状态路由：重复注册只记一笔。**审查能力本身不受影响** —— 拿不到这个路由时
        // 浏览器半边会 fail-open 按原文发出，最坏结果是"回到了自动模式"。
        const message = String((error && error.message) || error)
        failures.push({ label: 'prompt-hardener: review route', message, at: Date.now() })
        note(`review route registration failed: ${message}`)
        return () => {}
      }
      note(`review route registered: ${REVIEW_ROUTE}`)
      return () => {
        try {
          disposer()
        } catch {
          /* 已经卸掉就算了 */
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
  }, 'prompt-hardener: review route')
}

export { DEFAULTS, INTENSITIES, BUILTIN_PROMPT }
