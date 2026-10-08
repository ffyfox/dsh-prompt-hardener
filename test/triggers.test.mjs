/**
 * 触发前缀测试。跑法：node --test test/*.test.mjs
 *
 * 这些判据出错的方式都很安静：判漏 = 用户的字被吞掉或该放行的被改写；
 * 判多 = 正文里的 `!!` / `??` 被当成暗号吃掉。两边都不抛异常，只在真机上表现为"怪怪的"。
 *
 * 半角与全角**一视同仁**：都必须自成一段（`!!important`、`？？这句别改` 都不吃），
 * 紧贴文字的符号一律当原文。理由见 lib/triggers.js 的文件头。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TRIGGER_FORCE,
  TRIGGER_FORCE_WIDE,
  TRIGGER_SKIP,
  TRIGGER_SKIP_WIDE,
  parseTrigger,
} from '../lib/triggers.js'

test('!! 命中强制，并把前缀从正文里剥掉', () => {
  const parsed = parseTrigger('!! 帮我把这个函数改成 async')
  assert.equal(parsed.force, true)
  assert.equal(parsed.skip, false)
  assert.equal(parsed.trigger, TRIGGER_FORCE)
  assert.equal(parsed.text, '帮我把这个函数改成 async')
})

test('?? 命中跳过，同样剥掉前缀', () => {
  const parsed = parseTrigger('?? 这句原样发出去')
  assert.equal(parsed.skip, true)
  assert.equal(parsed.force, false)
  assert.equal(parsed.trigger, TRIGGER_SKIP)
  assert.equal(parsed.text, '这句原样发出去')
})

test('前导空白（含全角空格与换行）不影响命中', () => {
  for (const prefix of ['  ', '\n', '\t', '\u3000', '\n\n  \u3000']) {
    const parsed = parseTrigger(`${prefix}!! 干活`)
    assert.equal(parsed.force, true, `前导 ${JSON.stringify(prefix)} 应当被跳过`)
    assert.equal(parsed.text, '干活')
  }
})

test('只认行首：正文中间的 !! 是正文，不是暗号', () => {
  const text = '这里的 i!! 是逻辑非，别动它'
  const parsed = parseTrigger(text)
  assert.equal(parsed.trigger, null)
  assert.equal(parsed.text, text, '没命中就必须逐字原样返回')
  assert.equal(parseTrigger('那 ?? 是什么意思').trigger, null)
})

test('必须自成一段：紧贴文字的符号一律是原文，半角全角都一样', () => {
  for (const text of [
    '!!important 这是个正常的英文感叹',
    '??x 可选链',
    '!!干活',
    '？？这句别改',
    '！！帮我写个脚本',
    '！！important 这个怎么写',
  ]) {
    const parsed = parseTrigger(text)
    assert.equal(parsed.trigger, null, `${text} 不该被当成触发`)
    assert.equal(parsed.text, text, '没命中就必须逐字原样返回')
  }
})

test('全角命中：！！强制、？？跳过', () => {
  const force = parseTrigger('！！ 帮我把这个函数改成 async')
  assert.equal(force.force, true)
  assert.equal(force.skip, false)
  assert.equal(force.trigger, TRIGGER_FORCE_WIDE)
  assert.equal(force.text, '帮我把这个函数改成 async')

  const skip = parseTrigger('？？ 这句原样发出去')
  assert.equal(skip.skip, true)
  assert.equal(skip.force, false)
  assert.equal(skip.trigger, TRIGGER_SKIP_WIDE)
  assert.equal(skip.text, '这句原样发出去')
})

test('全角紧贴文字不算暗号，原样返回', () => {
  const skip = parseTrigger('？？这句别改')
  assert.equal(skip.trigger, null, '紧贴的 ？？ 是用户的字')
  assert.equal(skip.text, '？？这句别改', '不许剥，也不许 trim')

  const force = parseTrigger('！！帮我写个脚本')
  assert.equal(force.trigger, null)
  assert.equal(force.text, '！！帮我写个脚本')
})

test('全角也认前导空白与多个空格，且第一个空格不算正文', () => {
  const spaced = parseTrigger('！！    给我干活')
  assert.equal(spaced.trigger, TRIGGER_FORCE_WIDE)
  assert.equal(spaced.text, '给我干活')

  const indented = parseTrigger('\u3000\n ？？  这句原样发')
  assert.equal(indented.skip, true)
  assert.equal(indented.text, '这句原样发')
})

test('只剥两个字符，且第三个字符必须是空白', () => {
  // 第三个字符不是空白 ⇒ 整条不命中，不猜用户想不想触发（半角全角同规矩）。
  for (const raw of ['!!! 快点', '！！！快点', '！！！ 快点']) {
    const parsed = parseTrigger(raw)
    assert.equal(parsed.trigger, null, `${raw} 的第三个字符不是空白，不该命中`)
    assert.equal(parsed.text, raw)
  }

  // 第三个字符是空白时，只剥两个：多出来的那个符号是用户的字。
  const extra = parseTrigger('？？ ？这是什么')
  assert.equal(extra.trigger, TRIGGER_SKIP_WIDE)
  assert.equal(extra.text, '？这是什么')
})

test('半角全角混用不算暗号', () => {
  for (const text of ['!？ 干活', '？！ 干活', '!！ 干活', '？! 干活', '！!干活']) {
    const parsed = parseTrigger(text)
    assert.equal(parsed.trigger, null, `${text} 是混用，不该命中`)
    assert.equal(parsed.text, text)
  }
})

test('单个全角符号也不算', () => {
  for (const text of ['！ 干活', '？ 干活', '！干活']) {
    assert.equal(parseTrigger(text).trigger, null)
  }
})

test('全角只有一个前缀时同样不算命中，也不许动原话', () => {
  for (const raw of ['！！', '  ？？  ', '！！\n']) {
    const parsed = parseTrigger(raw)
    assert.equal(parsed.trigger, null, `${JSON.stringify(raw)} 不该被当成触发`)
    assert.equal(parsed.text, raw)
  }
})

test('单个 ! 或 ? 不算触发', () => {
  assert.equal(parseTrigger('! 干活').trigger, null)
  assert.equal(parseTrigger('? 干活').trigger, null)
})

test('整条只有一个前缀：没有正文可改写，视为没命中，且不改动原话', () => {
  for (const raw of ['!!', '  !!  ', '??', '??\n']) {
    const parsed = parseTrigger(raw)
    assert.equal(parsed.trigger, null, `${JSON.stringify(raw)} 不该被当成触发`)
    assert.equal(parsed.text, raw, '没命中时连空白都不许顺手 trim')
  }
})

test('非字符串输入原样返回，绝不抛', () => {
  for (const value of [undefined, null, 42, {}, []]) {
    const parsed = parseTrigger(value)
    assert.equal(parsed.trigger, null)
    assert.equal(parsed.force, false)
    assert.equal(parsed.skip, false)
  }
})

test('前缀后的换行也算正文的一部分（多行消息首行是暗号）', () => {
  const parsed = parseTrigger('!! 第一行\n第二行别丢')
  assert.equal(parsed.force, true)
  assert.equal(parsed.text, '第一行\n第二行别丢')
})
