/**
 * 改写判断的判据测试（`lib/gate.js`，纯函数）。
 *
 * 这份用例的价值不在于覆盖率，而在于**钉住两件不能退让的事**：
 * 1. 有内容的消息一条都不许被判成"无内容" —— 判错就是把真需求按原样发出去，
 *    少了一次改写。短消息尤其危险（`加个按钮`、`add tests` 都是真需求）。
 * 2. 判据的失败方向必须是保守的：词表里没有的写法一律按"有内容"处理。
 *    所以非中英文、以及任何不认识的词，这里都断言"不判无内容"。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { WORD_TOKENS, ZH_TOKENS, isPureSymbol, noContent, vocabOnly } from '../lib/gate.js'

/* ───────────────────────── 结构否决：一律调用模型 ───────────────────────── */

test('结构信号：代码、链接、路径、数字、多行、领域词 一律不判无内容', () => {
  const vetoed = [
    '```js\n继续\n```',            // 代码围栏
    '`继续`',                      // 行内代码
    '看 https://example.com',      // URL
    '读 README.md',                // 扩展名
    '打开 ./src',                  // 路径
    '看看 ~/notes',                // 家目录路径
    '继续 3',                      // 数字（整条只是序号时另说）
    '第 2 步继续',                 // 序号 + 功能词，但确实有数字
    '继续\n好的',                  // 消息内部换行
    '继续把登录页做了',            // 领域词（页面）
    '用 canvas 画个图',            // 领域词（视觉）
  ]
  for (const text of vetoed) {
    assert.equal(noContent(text), null, `不该被判无内容：${JSON.stringify(text)}`)
  }
})

test('纯符号与序号：整条没有可改写的内容', () => {
  for (const text of ['？？', '!!', '？', '…', '。', '1.', '1 2 3', '3.14', '(1)', '！！！', '-', '？.']) {
    assert.equal(noContent(text), 'pure-symbol', `应当命中纯符号：${JSON.stringify(text)}`)
  }
  // 空与纯空白不算：没有正文可发，也没有判断的必要。
  for (const text of ['', '   ', '\n']) assert.equal(noContent(text), null)
  assert.equal(noContent(null), null)
  assert.equal(noContent(undefined), null)
  assert.equal(noContent(123), null)
})

/* ─────────────────────────── 功能词：应当命中 ─────────────────────────── */

test('中文：整条只有功能词时才判无内容', () => {
  const gated = [
    '继续', '接着做', '再来一次', '重来', '就这样', '下一个', '先这样', '行吧', '好的', '好的好的',
    '嗯嗯', '谢谢', '麻烦看下', '看一下', '改一下', '全改了', '提交', '现在提交', '看下', '继续。',
  ]
  for (const text of gated) assert.equal(noContent(text), 'vocab', `应当命中：${JSON.stringify(text)}`)

  const kept = [
    '说重点', '再看一遍', '继续把登录页做了', '提交这个改动', '把这段重构一下', '顺便加个测试',
  ]
  for (const text of kept) assert.equal(noContent(text), null, `不该命中：${JSON.stringify(text)}`)
})

test('英文：整条只有功能词时才判无内容', () => {
  const gated = ['go on', 'keep going', 'carry on', 'one more', 'do it again', 'try again', 'again', 'yes',
    'ok', 'thanks', 'please', 'not that', 'go ahead']
  for (const text of gated) assert.equal(noContent(text), 'vocab', `应当命中：${JSON.stringify(text)}`)

  const kept = ['add tests', 'looks good', 'ship it', 'run the tests', 'revert it', 'one more test']
  for (const text of kept) assert.equal(noContent(text), null, `不该命中：${JSON.stringify(text)}`)
})

test('中英混排：两边的段落都得是功能词', () => {
  assert.equal(noContent('好的 ok'), 'vocab')
  assert.equal(noContent('继续 continue'), 'vocab')
  assert.equal(noContent('好的 cache'), null, '混排里只要有一个内容词就不算无内容')
})

/* ─────────────────────── 保守方向：不认识的就不判 ─────────────────────── */

test('非中英文一条都不判无内容（词表只收了中文与英文）', () => {
  // 这些在各自语言里与「继续」同义，但词表里没有 ⇒ 必须落到"有内容" ⇒ 照常调用模型。
  for (const text of ['続けて', '계속', 'sigue', 'continúa', 'weiter', 'продолжай', 'continua', 'avanti']) {
    assert.equal(noContent(text), null, `不该判无内容：${JSON.stringify(text)}`)
  }
})

test('词表里没有的中文词一律不判无内容（缺词只会少跳过几条）', () => {
  // 每条都恰好卡在一个不在表里的字上：起、发、完、办。
  for (const text of ['继续搞起', '再来一发', '继续弄完它', '再看一下办']) {
    assert.equal(noContent(text), null, `不该判无内容：${JSON.stringify(text)}`)
  }
})

test('内容词一律不得进词表（进了，判据就变成"他说了什么"）', () => {
  const content = ['配置', '按钮', '依赖', '测试', '登录', '文件', '接口', '性能', '图片', '正则',
    'bug', 'tests', 'file', 'version', 'lint', 'refactor', 'redis', 'cache', 'canvas']
  for (const word of content) {
    assert.ok(!ZH_TOKENS.includes(word), `内容词混进中文词表：${word}`)
    assert.ok(!WORD_TOKENS.includes(word), `内容词混进英文词表：${word}`)
  }
})

/* ──────────────────── 短真需求：一条都不许被判无内容 ──────────────────── */

test('短真需求回归：中文 15 条一条都不许判无内容', () => {
  const real = ['加按钮', '改配置', '删掉它', '重命名', '加个按钮', '做个页面', '更新依赖', '把这段重构一下',
    '顺便加个测试', '改成 async', '换成 pnpm', '用 Redis 做缓存', '写个正则', '压缩一下图片', '优化启动速度']
  for (const text of real) assert.equal(noContent(text), null, `真需求被判无内容：${JSON.stringify(text)}`)
})

test('短真需求回归：英文 12 条一条都不许判无内容', () => {
  const real = ['add tests', 'rename field', 'update docs', 'delete file', 'bump version', 'check lint',
    'fix bug', 'revert it', 'run the tests', 'ship it', 'refactor this', 'switch to pnpm']
  for (const text of real) assert.equal(noContent(text), null, `真需求被判无内容：${JSON.stringify(text)}`)
})

test('已经很硬的原话不会被判成无内容（两条判据互不干扰）', () => {
  for (const text of ['老哥们搞快点', '帮我用 Canvas 画个赛博朋克机械骷髅']) {
    assert.equal(noContent(text), null)
  }
})

/* ─────────────────────────────── 零件 ─────────────────────────────── */

test('isPureSymbol 与 vocabOnly 各自的口径', () => {
  assert.equal(isPureSymbol('？？'), true)
  assert.equal(isPureSymbol('继续'), false)
  assert.equal(vocabOnly('继续'), true)
  assert.equal(vocabOnly('？？'), false, '纯符号不含任何词，不算功能词命中')
  assert.equal(vocabOnly('   '), false)
})
