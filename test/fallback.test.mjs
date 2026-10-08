/**
 * 兜底拼接器测试。跑法：node --test test/*.test.mjs
 *
 * 它只在模型调用失败时才上场，但"上场时不能把用户原话搞丢"这条必须钉死。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { INTENSITIES, assembleFallback, normalizeIntensity } from '../lib/fallback.js'
import { detectDomain, looksHardman } from '../lib/phrases.js'

const ORIGINAL = '给我做一个单文件 HTML 的 3D 体素圆环卫星城，无外部资源，浏览器直接打开。'

test('兜底结果里原话一字不差', () => {
  const result = assembleFallback(ORIGINAL, { intensity: 'standard', seed: 'a' })
  assert.equal(result.changed, true)
  assert.ok(result.text.includes(ORIGINAL), '兜底没有改写能力，原话必须逐字保留')
  assert.ok(result.text.includes('任务：'))
})

test('已经是硬汉风格就放行，不二次套娃', () => {
  const hardman = '老哥们，我时间不多了，搞快点！别引入墨迹的独立审查，你们是肌肉集团，冲冲冲！'
  assert.equal(looksHardman(hardman), true)
  const result = assembleFallback(hardman, { intensity: 'insane' })
  assert.equal(result.changed, false)
  assert.equal(result.meta.skipped, 'already-hardman')
})

test('只命中一个特征词不算硬汉', () => {
  assert.equal(looksHardman('这个按钮上的硬邦邦三个字太长了'), false)
})

test('斜杠命令与空文本放行', () => {
  assert.equal(assembleFallback('/compact', {}).meta.skipped, 'slash-command')
  assert.equal(assembleFallback('   ', {}).meta.skipped, 'empty')
  assert.equal(assembleFallback(undefined, {}).meta.skipped, 'empty')
})

test('同种子逐位复现', () => {
  const a = assembleFallback(ORIGINAL, { intensity: 'brutal', seed: 'seed-x' })
  const b = assembleFallback(ORIGINAL, { intensity: 'brutal', seed: 'seed-x' })
  assert.equal(a.text, b.text)
})

test('域识别：3D/建模命中 visual3d，纯聊天落 generic', () => {
  assert.equal(detectDomain(ORIGINAL), 'visual3d')
  assert.equal(detectDomain('把这个月的账单数据做个统计报表'), 'data')
  assert.equal(detectDomain('你好，今天天气怎么样'), 'generic')
})

test('显卡/规模槽位只给视觉与游戏类任务', () => {
  const visual = assembleFallback(ORIGINAL, { intensity: 'insane', seed: 'e' })
  assert.ok(visual.meta.slots.includes('scale'))
  const plain = assembleFallback('帮我把这段话润色一下，写进周报。', { intensity: 'insane', seed: 'e' })
  assert.ok(!plain.meta.slots.includes('scale'))
})

test('用户已经排过团队/速度的事，就不再重复堆槽位', () => {
  const text = '别拉 agent team，你自己上；搞快点，越快越好，别规划。给我写个脚本。'
  const result = assembleFallback(text, { intensity: 'brutal', seed: 'f' })
  assert.ok(!result.meta.slots.includes('team'))
  assert.ok(!result.meta.slots.includes('speed'))
})

test('称呼后不出现重标点，句内不堆叠同一个口号', () => {
  for (const intensity of ['light', 'standard', 'brutal', 'insane']) {
    for (const seed of ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']) {
      const { text } = assembleFallback(ORIGINAL, { intensity, seed })
      assert.ok(!/[！？。]，/.test(text), `重标点：${intensity}/${seed}`)
      assert.ok((text.match(/别想那么多/g) || []).length <= 1, `口号重复：${intensity}/${seed}`)
    }
  }
})

test('强度档位收敛', () => {
  assert.equal(normalizeIntensity('INSANE'), 'insane')
  assert.equal(normalizeIntensity('离谱'), 'standard')
  assert.equal(normalizeIntensity(undefined), 'standard')
  // `off` 不是强度档位：它是个未知值，按收敛规则落回 standard；
  // 老配置里那个字由 sanitizeState 翻成"整体停用"。
  assert.equal(normalizeIntensity('off'), 'standard')
  for (const id of INTENSITIES) assert.equal(normalizeIntensity(id), id)
})

test('每个合法强度都产出比原文长的结果', () => {
  for (const intensity of INTENSITIES) {
    const result = assembleFallback(ORIGINAL, { intensity, seed: `s-${intensity}` })
    assert.equal(result.changed, true, `${intensity} 应当改写`)
    assert.ok(result.text.length > ORIGINAL.length, `${intensity} 应当比原文长`)
  }
})
