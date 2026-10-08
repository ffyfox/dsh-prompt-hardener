/**
 * 触发前缀（纯函数，零依赖，可单测）。
 *
 * 插件的开关是全局的：想放过某一条消息，得把挂件切到「关」，发完再切回来。
 * 这些前缀是给"就这一次"用的：
 *
 * - `!!` / `！！` 本条**强制改写**：哪怕这条消息看着已经够硬，也照改（但插件整体停用时
 *   不算数 —— 那时候它们只是普通标点，见 index.js 的取舍）。
 * - `??` / `？？` 本条**不改写**，原样放行，也不做"已经很硬了"那类判断。
 *
 * 三条纪律：
 * 1. **只认行首**（允许前导空白）。正文中间的 `!!` 是用户的正文，不是给插件的暗号 ——
 *    代码里出现 `!!` 太常见了（shell 历史展开、逻辑非），一律不动。
 * 2. **半角、全角都必须自成一段。** 暗号后面必须跟空白或行尾；紧贴文字的符号一律
 *    当作用户的原文，不剥、不认。理由是"宁可少认，也不能把用户的字吃掉"：
 *    `!!important`、`！!干活`、`！！！快点` 这类开头在技术正文里太常见（否定式、
 *    可选链、shell 史展开、一串感叹号），靠符号形状猜意图迟早猜错。
 * 3. **前缀必须被剥掉，而且只剥两个字符。** 剥掉之后才是发给模型的正文：留着 `？？`
 *    会被模型当成正文内容抄进输出，或者被理解成"用户在问问题"。前缀后没有正文时
 *    （整条消息就是 `！！`）视为**没有命中**，原话一字不动 —— 没有正文可改写时，
 *    "强制"没有意义。第三个字符是空白时也只剥两个：`？？ ？这是什么` 的正文是
 *    `？这是什么`，多出来的那个 `？` 是用户的字。
 *
 * @module dsh-prompt-hardener/triggers
 */

/** 强制改写前缀（半角）。 */
export const TRIGGER_FORCE = '!!'
/** 本次跳过前缀（半角）。 */
export const TRIGGER_SKIP = '??'
/** 强制改写前缀（全角）。 */
export const TRIGGER_FORCE_WIDE = '！！'
/** 本次跳过前缀（全角）。 */
export const TRIGGER_SKIP_WIDE = '？？'

/**
 * 命中的四个暗号。半角全角一视同仁：后面必须跟空白或行尾（见文件头第 2 条）。
 */
const MARKERS = Object.freeze([
  Object.freeze({ head: TRIGGER_FORCE, force: true, skip: false }),
  Object.freeze({ head: TRIGGER_SKIP, force: false, skip: true }),
  Object.freeze({ head: TRIGGER_FORCE_WIDE, force: true, skip: false }),
  Object.freeze({ head: TRIGGER_SKIP_WIDE, force: false, skip: true }),
])

/**
 * 解析一条用户正文的触发前缀。
 *
 * @param {unknown} input 用户原话。
 * @returns {{ text: string, force: boolean, skip: boolean, trigger: string|null }}
 *   `text` 是剥掉前缀后的正文（没命中时原样返回，包括首尾空白）；
 *   `trigger` 是命中的前缀，没命中为 null。
 */
export function parseTrigger(input) {
  const raw = typeof input === 'string' ? input : ''
  const miss = { text: raw, force: false, skip: false, trigger: null }

  // 行首定位：只跳过空白，不跳过任何别的字符。
  let at = 0
  while (at < raw.length) {
    const ch = raw[at]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\u3000') at += 1
    else break
  }

  const head = raw.slice(at, at + 2)
  const marker = MARKERS.find((item) => item.head === head)
  if (!marker) return miss

  // 暗号必须"自成一段"：`!!important` / `？？这句别改` 这种是用户的正文，不是暗号。
  // 宁可少认，也不能把用户的字吃掉。
  const after = raw.charAt(at + 2)
  if (after !== '' && !/\s/.test(after)) return miss

  const body = raw.slice(at + 2).trim()
  // 整条消息只有一个前缀：没有正文，就没有"强制/跳过"可言。
  if (body.length === 0) return miss

  return { text: body, force: marker.force, skip: marker.skip, trigger: marker.head }
}
