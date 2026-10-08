/**
 * 兜底拼接器（纯函数，零依赖，可单测）。
 *
 * **这不是主路径。** 主路径是把用户原话交给模型、按 `lib/prompt.md` 全量重写。
 * 只有当模型调用失败（超时、报错、没有可用路由）时，才用这里拼一个硬汉外壳把原话
 * 夹进去，保证你的这一轮不会白跑。
 *
 * 与主路径的差别要说清楚：拼接器**没有改写能力**，它只能在原话前后加硬汉框架，
 * 所以原话一定原样出现在结果里。想知道这一轮走的是哪条路，看 stats 里的
 * `lastSource`（`llm` / `rules-fallback`）。
 *
 * 三条硬规矩：
 * 1. **绝不改动用户原话的技术内容。**
 * 2. **幂等**：看起来已经是硬汉风格的文本原样放行，不二次套娃。
 * 3. **不发明事实**：短语库只提供过程压力与验收气势。
 *
 * @module dsh-prompt-hardener/fallback
 */

import {
  ACCEPTANCE,
  ACCEPTANCE_WILD,
  ANTI_PLAN,
  DOMAIN_LINES,
  GREETINGS,
  KICKOFF,
  REFERENCE,
  SCALE,
  SCARCITY,
  SELF_CHECK,
  SPEED,
  TEAM,
  detectDomain,
  looksHardman,
} from './phrases.js'

/**
 * 全部强度档位，从弱到强。
 *
 * 这里只放"改写力度"。「不改写」不在这张表里 —— 那是 `enabled` 的事（挂件上那颗「关」）；
 * 老配置里若写着 `off`，由 index.js 的 `sanitizeState` 翻成"整体停用"。
 */
export const INTENSITIES = ['light', 'standard', 'brutal', 'insane']

/** 强度档位 → 数字等级。 */
const LEVELS = { light: 1, standard: 2, brutal: 3, insane: 4 }

/**
 * 把任意输入收敛成合法强度档位。
 * @param {unknown} value 候选值。
 * @returns {string} `INTENSITIES` 之一；无法识别时返回 `standard`。
 */
export function normalizeIntensity(value) {
  if (typeof value !== 'string') return 'standard'
  const id = value.trim().toLowerCase()
  return INTENSITIES.includes(id) ? id : 'standard'
}

/* ───────────────────────────────── 内部工具 ───────────────────────────────── */

/** 确定性 PRNG（mulberry32）。同一 seed 逐位复现，便于测试。 */
function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a 字符串散列，用作 PRNG 种子。 */
function hashSeed(text) {
  let h = 0x811c9dc5
  const s = String(text ?? '')
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 从池子里确定性地取一个。 */
function pick(rng, pool) {
  if (!Array.isArray(pool) || pool.length === 0) return ''
  return pool[Math.floor(rng() * pool.length) % pool.length]
}

/** 从池子里确定性地取 n 个不重复项，保持池内原顺序。 */
function pickN(rng, pool, n) {
  if (!Array.isArray(pool) || pool.length === 0) return []
  const count = Math.min(n, pool.length)
  const indexes = new Set()
  let guard = 0
  while (indexes.size < count && guard < 1000) {
    indexes.add(Math.floor(rng() * pool.length) % pool.length)
    guard += 1
  }
  return [...indexes].sort((a, b) => a - b).map((i) => pool[i])
}

/** 标点收尾：句末已有标点则不再补句号。 */
const ENDERS = /[。！？!?…；;]$/
/** 句末标点（含逗号），用于把称呼接到下一句前面时不出现"！，"这种重标点。 */
const TRAILING_PUNCT = /[。！？!?…；;，,、\s]+$/

function joinSentences(parts) {
  const out = []
  for (const raw of parts) {
    if (typeof raw !== 'string') continue
    const line = raw.trim()
    if (!line) continue
    out.push(ENDERS.test(line) ? line : `${line}。`)
  }
  return out.join('')
}

/** 用户原话里已经排过团队的事，就别再插一句（免得自相矛盾）。 */
function mentionsTeam(text) {
  return /agent\s*team|team|子代理|subagent|分工|独立审查|肌肉集团/i.test(text)
}

/** 用户原话里已经排过速度/规划的事，就别重复堆。 */
function mentionsPace(text) {
  return /搞快点|越快越好|激进|别规划|不用替我规划|禁止.*规划/i.test(text)
}

/* ───────────────────────────────── 主入口 ───────────────────────────────── */

/**
 * @typedef {object} FallbackOptions
 * @property {string} [intensity] `INTENSITIES` 之一。
 * @property {string} [domain] 覆盖自动领域识别。
 * @property {string} [seed] 随机种子；缺省用原话自身。
 */

/**
 * @typedef {object} FallbackResult
 * @property {boolean} changed 是否真的改写了。
 * @property {string} text 结果文本；`changed` 为 false 时是原话。
 * @property {object} meta 诊断信息（档位、领域、用到的槽位）。
 */

/**
 * 用硬汉外壳包住用户原话（模型调用失败时的兜底）。
 * @param {string} input 用户原话。
 * @param {FallbackOptions} [options] 选项。
 * @returns {FallbackResult}
 */
export function assembleFallback(input, options = {}) {
  const text = typeof input === 'string' ? input : ''
  const trimmed = text.trim()
  const intensity = normalizeIntensity(options.intensity)
  const level = LEVELS[intensity] ?? 2
  const meta = { intensity, level, domain: null, slots: [] }

  /** @param {string} why */
  const unchanged = (why) => ({ changed: false, text, meta: { ...meta, skipped: why } })

  if (trimmed.length === 0) return unchanged('empty')
  if (trimmed.startsWith('/')) return unchanged('slash-command')
  if (looksHardman(text)) return unchanged('already-hardman')

  const domain = typeof options.domain === 'string' && options.domain
    ? options.domain
    : detectDomain(text)
  meta.domain = domain

  const rng = mulberry32(hashSeed(`${options.seed ?? text}\u0000${intensity}\u0000${domain}`))
  const greeting = pick(rng, GREETINGS).replace(TRAILING_PUNCT, '')

  /** @type {string[]} */
  const head = []
  /** @type {string[]} */
  const tail = []

  head.push(`${greeting}，${pick(rng, SCARCITY)}`)
  meta.slots.push('scarcity')

  if (!mentionsPace(text)) {
    if (level >= 2) {
      head.push(pick(rng, SPEED))
      head.push(pick(rng, ANTI_PLAN))
      meta.slots.push('speed', 'anti-plan')
    }
  }
  if (level >= 3) {
    if (!mentionsTeam(text)) {
      head.push(pick(rng, TEAM))
      meta.slots.push('team')
    }
    head.push(pick(rng, REFERENCE))
    meta.slots.push('reference')
  }

  const domainPool = DOMAIN_LINES[domain] ?? []
  if (level >= 2 && domainPool.length > 0) {
    head.push(...pickN(rng, domainPool, level >= 4 ? 2 : 1))
    meta.slots.push(`domain:${domain}`)
  }
  if (level >= 4 && (domain === 'visual3d' || domain === 'game' || domain === 'html')) {
    head.push(pick(rng, SCALE))
    meta.slots.push('scale')
  }

  tail.push(pick(rng, ACCEPTANCE))
  meta.slots.push('acceptance')
  if (level >= 3) {
    tail.push(pick(rng, SELF_CHECK))
    meta.slots.push('self-check')
  }
  if (level >= 4) {
    tail.push(pick(rng, ACCEPTANCE_WILD))
    meta.slots.push('acceptance-wild')
  }
  tail.push(pick(rng, KICKOFF))
  meta.slots.push('kickoff')

  const rendered = `${joinSentences(head)}\n\n任务：\n${text}\n\n${joinSentences(tail)}`.trim()
  return { changed: true, text: rendered, meta }
}
