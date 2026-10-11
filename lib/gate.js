/**
 * 改写判断的判据（纯函数，零依赖，可单测）：这条消息值不值得调用模型去改写。
 *
 * 判的是**有没有内容**，不是长短。整条只有符号、序号，或者整条都由功能词组成时
 * （`继续`、`好的`、`提交`、`go on`），这条消息没有可改写的内容，改写它多花一次模型调用、
 * 多等几秒，换不来任何东西。这种不必要的调用与改写直接省掉，按原话发出去。
 *
 * 两层，先否决后放行：
 *
 * 1. **结构否决**：命中任一与"有没有内容"无关的强信号 ⇒ 一律调用模型。
 *    代码、URL / 路径 / 扩展名、数字（整条只是序号时除外）、消息内部的换行、
 *    以及命中领域词表的正文（见 lib/phrases.js 的 detectDomain）。
 * 2. **无内容**：整条只是符号 / 序号，或者整条都能被下面的**闭集功能词**吃干净。
 *
 * 词表的收录标准是语言学的，不来自任何人的输入记录：只收代词、指示词、连词、副词、
 * 语气助词、应答敬语、续说词，以及少数离开内容词就没有含义的轻动词（做 / 改 / 加 / 删…）。
 * **内容词（名词、专业词、专有名词）一律不收** —— 收了它，判据就变成了"他说了什么"。
 *
 * 失败方向是**保守的**：词表里没有 ⇒ 不算功能词 ⇒ 判为有内容 ⇒ 照常调用模型。词表不全的
 * 代价是"少跳过几条"，永远不会是"把真需求放过去了"。目前只收中文与英文；其它语言的消息
 * 一条都不会被判为无内容，与插件此前行为一致。
 *
 * @module dsh-prompt-hardener/gate
 */
import { detectDomain } from './phrases.js'

/* ─────────────────────────── 语言无关的结构信号 ─────────────────────────── */

/** 密排文字：中日韩。词表里没有对应语言时，它们一个都匹配不上 ⇒ 保守地不判无内容。 */
const DENSE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/
/** 分词文字：拉丁与西里尔 / 希腊字母，按"词"判。 */
const LATIN = /[A-Za-z\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff]/
/** 同上，取词用（带 g 的那份不能与上面共用：`test` 会推进 lastIndex）。 */
const LATIN_G = /[A-Za-z\u00c0-\u024f\u0370-\u03ff\u0400-\u04ff]+/g

/** 代码：围栏与行内代码。 */
const CODE = /```|`[^`]*`/
/** URL、文件名 / 扩展名、路径。 */
const URLISH = /:\/\/|www\.|\b[\w-]+\.(js|jsx|ts|tsx|json|md|css|html|py|go|rs|java|yml|yaml|toml|sh|txt)\b|(^|\s)[~./]/
/** 任何数字（全角也算）。 */
const DIGIT = /[0-9\uff10-\uff19]/
/** 整条只是数字、序号或算式。 */
const PURE_NUMBER = /^[\s\d\uff10-\uff19.,:：、)）(（\-—+]+$/
/** 整条只是标点或符号（含 emoji）。 */
const PURE_SYMBOL = /^[\s\p{P}\p{S}]+$/u

/* ────────────────────────────── 闭集功能词 ────────────────────────────── */

/**
 * 中文功能词。**贪心最长匹配**：整条消息必须被这张表吃干净才算无内容。
 *
 * 单字条目多是有意的：中文没有分词，`改一下` / `看一下` / `好的` 这类全靠单字功能词拼起来。
 * 它们凑不出内容 —— 真正的内容（`配置`、`按钮`、`依赖`）里总有一个字不在这张表里。
 */
export const ZH_TOKENS = Object.freeze([
  // 续说 / 应答 / 敬语
  '继续', '接着', '再来', '再来一次', '重来', '重新', '收到', '了解', '明白', '知道', '没问题',
  '可以', '好的', '好吧', '行吧', '谢谢', '辛苦', '麻烦', '顺便', '等等', '稍等', '不急',
  // 指示 / 时间 / 疑问
  '这个', '那个', '这里', '那里', '上面', '下面', '之前', '刚才', '现在', '然后', '这样', '那样',
  '什么样', '什么', '怎么', '为什么', '哪里', '哪儿', '多少',
  // 连词 / 副词
  '但是', '不过', '所以', '因为', '如果', '就是', '还是', '或者', '以及', '而已',
  // 单字功能词
  '我', '你', '咱', '他', '她', '它', '们', '这', '那', '个', '上', '下', '里', '外',
  '先', '再', '又', '就', '都', '也', '还', '才', '只', '要', '不', '没', '无', '别', '请',
  '好', '行', '嗯', '哦', '噢', '啊', '呀', '哇', '嘛', '呢', '吧', '的', '地', '得', '了', '过', '着',
  '是', '对', '错', '能', '会', '该', '想', '来', '去', '回', '到', '在', '把', '按', '照', '用', '给',
  '和', '与', '或', '但', '而', '则', '很', '太', '更', '最', '多', '少', '快', '慢', '点', '次',
  '一', '二', '三', '四', '五', '第', '两', '几', '各', '每', '全', '另',
  // 轻动词：离开内容词就没有含义的那些（`提交` 单独出现时也属于这一类）
  '做', '搞', '改', '加', '删', '看', '说', '写', '走', '干', '弄', '试', '提交', '推送', '发布',
  '重启', '停', '开始', '结束', '完成', '收',
])

/**
 * 英文功能词。整条消息的**每一个词**都必须在表里才算无内容。
 * 同样只收功能词与纯续说短语，`fix` / `add` / `bug` / `tests` 这类内容词一个不收。
 */
export const WORD_TOKENS = Object.freeze([
  // 冠词 / 代词 / 指示词
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'it', 'them', 'they', 'i', 'you', 'we', 'us', 'me',
  'my', 'your', 'our', 'he', 'she', 'his', 'her', 'there', 'here', 'now', 'then',
  // 连词 / 副词 / 介词
  'and', 'or', 'but', 'so', 'if', 'as', 'of', 'to', 'for', 'with', 'on', 'in', 'at', 'by', 'from', 'up',
  'down', 'again', 'more', 'less', 'just', 'only', 'still', 'yet', 'also', 'too', 'very', 'really', 'all',
  'right', 'not', 'no', 'yes', 'yeah', 'yep', 'nope', 'ok', 'okay',
  // 应答 / 敬语
  'sure', 'please', 'pls', 'thanks', 'thank', 'thx', 'ty', 'good', 'great', 'nice', 'fine', 'done', 'perfect',
  // 续说 / 控制
  'continue', 'go', 'going', 'gone', 'ahead', 'keep', 'keeping', 'carry', 'carrying', 'do', 'doing', 'next',
  'retry', 'try', 'stop', 'wait', 'hold', 'cancel', 'abort', 'proceed', 'start', 'restart', 'resume',
  'finish', 'end', 'repeat', 'one', 'two', 'three',
])

const ZH_SET = new Set(ZH_TOKENS)
const WORD_SET = new Set(WORD_TOKENS)
/** 贪心匹配的最长窗口。 */
const ZH_MAX = ZH_TOKENS.reduce((n, token) => Math.max(n, token.length), 1)

/* ──────────────────────────────── 判据 ──────────────────────────────── */

/**
 * 这条消息是不是"只有结构没有内容"（结构否决项一条都没命中）。
 * @param {string} text 候选正文。
 * @returns {boolean}
 */
function structuralOnly(text) {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  if (trimmed.includes('\n')) return false
  if (CODE.test(trimmed)) return false
  if (URLISH.test(trimmed)) return false
  if (DIGIT.test(trimmed) && !PURE_NUMBER.test(trimmed)) return false
  if (detectDomain(trimmed) !== 'generic') return false
  return true
}

/**
 * 整条只是数字、序号或标点符号。
 *
 * 独立成一个出口是因为它**先于结构否决**：`？？` / `!!` / `1.` 本身不含数字以外的结构信号，
 * 它们没有任何可改写的内容 —— 包括用户想用 `？？` 逐条跳过、但符号紧贴不出正文时留下的那一串。
 *
 * @param {string} text 候选正文。
 * @returns {boolean}
 */
export function isPureSymbol(text) {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  return PURE_NUMBER.test(trimmed) || PURE_SYMBOL.test(trimmed)
}

/** 把正文切成同类字符的连续段：密排、拉丁、其它（空白与标点）。 */
function runs(text) {
  const out = []
  let kind = ''
  let buf = ''
  for (const ch of text) {
    const next = DENSE.test(ch) ? 'dense' : (LATIN.test(ch) ? 'latin' : 'other')
    if (next === kind) buf += ch
    else {
      if (kind !== '') out.push({ kind, text: buf })
      kind = next
      buf = ch
    }
  }
  if (kind !== '') out.push({ kind, text: buf })
  return out
}

/** 一段密排文字能否被中文功能词吃干净（贪心最长匹配，逐字推进；进来的一定只有密排字）。 */
function denseRunOnly(run) {
  let at = 0
  while (at < run.length) {
    let matched = 0
    for (let len = Math.min(ZH_MAX, run.length - at); len >= 1; len -= 1) {
      if (ZH_SET.has(run.slice(at, at + len))) {
        matched = len
        break
      }
    }
    if (matched === 0) return false
    at += matched
  }
  return true
}

/** 一段拉丁文字能否被英文功能词吃干净（逐词查表）。 */
function latinRunOnly(run) {
  const words = run.toLowerCase().match(LATIN_G) || []
  if (words.length === 0) return false
  return words.every((word) => WORD_SET.has(word))
}

/**
 * 整条消息能否被功能词吃干净。空白与标点不算数；跳过的那一段必须至少含一个词。
 * @param {string} text 候选正文。
 * @returns {boolean}
 */
export function vocabOnly(text) {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  let sawWord = false
  for (const run of runs(trimmed)) {
    if (run.kind === 'other') continue
    sawWord = true
    if (run.kind === 'dense' ? !denseRunOnly(run.text) : !latinRunOnly(run.text)) return false
  }
  return sawWord
}

/**
 * 改写判断：这条消息要不要跳过改写。
 *
 * @param {unknown} input 用户原话（**已经剥掉触发前缀**）。
 * @returns {'pure-symbol'|'vocab'|null} 命中的理由；`null` 表示照常调用模型。
 */
export function noContent(input) {
  const text = typeof input === 'string' ? input : ''
  if (isPureSymbol(text)) return 'pure-symbol'
  if (!structuralOnly(text)) return null
  return vocabOnly(text) ? 'vocab' : null
}
