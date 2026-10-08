/**
 * 用**真 cordis** 跑的启动时序测试。
 *
 * 为什么需要这一层：`test/host.test.mjs` 里的假 ctx 是手写的，它可以比现实宽容 ——
 * 服务未就绪时不抛，"冷启动 webServer 晚于插件就绪"这个真实时序就一条都拦不住。
 * 假件可以写歪，真件不会：这里直接用宿主里那份 cordis，跑真实 fiber 状态。
 *
 * 没有 cordis 运行时的机器上自动跳过（可用 PH_CORDIS 指到另一份）。
 */

import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const CANDIDATES = [
  process.env.PH_CORDIS,
  '/opt/deepseek-harness-desktop/resources/app/dsh/node_modules/@deepseek-ai/cordis/lib/index.js',
].filter(Boolean)

let cordis = null
for (const candidate of CANDIDATES) {
  try {
    cordis = await import(candidate)
    break
  } catch {
    /* 换下一份 */
  }
}

const skip = cordis === null ? '本机没有 cordis 运行时（可用 PH_CORDIS 指定）' : false

test('真 cordis：冷启动时 webServer 晚于插件就绪，路由仍须补上且 fiber 不许是 FAILED', { skip }, async () => {
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'ph-cordis-'))
  const mod = await import('../index.js')

  const root = new cordis.Context()
  const routes = new Map()
  const webServer = {
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate exact route: ${route.path}`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }

  // 冷启动的真实时序：先激活插件，此刻 webServer 服务还没被提供出来。
  const fiber = root.plugin(
    { name: mod.name, inject: mod.inject, apply: (ctx, config) => mod.apply(ctx, config) },
    { enabled: true, intensity: 'standard' },
  )
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(routes.size, 0, 'webServer 还没就绪，这时不该有路由')

  // 宿主稍后把 webServer 提供出来。
  root.provide('webServer', webServer)
  await new Promise((resolve) => setTimeout(resolve, 200))

  assert.equal(routes.has(mod.STATE_ROUTE), true, '路由必须自己补上，否则控制条永远读到 405')
  // fiber.await() 会把启动期异常重新抛出来；有异常就说明插件会被标成"加载失败"。
  await fiber.await()
  assert.equal(fiber.state, 2, 'fiber 必须是 ACTIVE(2)，不能是 FAILED(3)')
})

test('真 cordis：宿主没有 webServer 时也必须激活成功（headless 容忍）', { skip }, async () => {
  process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'ph-cordis-headless-'))
  const mod = await import('../index.js')

  const root = new cordis.Context()
  const fiber = root.plugin(
    { name: mod.name, inject: mod.inject, apply: (ctx, config) => mod.apply(ctx, config) },
    { enabled: true, intensity: 'standard' },
  )
  await new Promise((resolve) => setTimeout(resolve, 120))

  await fiber.await()
  assert.equal(fiber.state, 2, '没有 webServer 也要是 ACTIVE，只是没有控制条')
})
