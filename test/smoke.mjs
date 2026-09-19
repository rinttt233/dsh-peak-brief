/**
 * dsh-peak-brief — Host 半身的离线烟测（不需要 DSH 在跑）。
 *
 * 用一个假的 cordis ctx 驱动 apply()，然后直接调用注册进 webServer 的路由
 * handler 与 llm/stream 监听器，验证通知生命周期与门控接线。
 *
 *   node test/smoke.mjs
 */

import assert from 'node:assert/strict'
import { apply, inject, name } from '../lib/index.js'

/** 假 cordis ctx：记录路由、事件监听器与 effect 清理器。 */
export function makeCtx() {
  const routes = new Map()
  const listeners = new Map()
  const logs = []
  const effectDisposers = []
  const ctx = {
    logger: {
      info: (m) => logs.push(m),
      warn: (m) => logs.push(m),
    },
    effect(fn) {
      const dispose = fn()
      const teardown = () => { if (typeof dispose === 'function') dispose() }
      effectDisposers.push(teardown)
      return teardown
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        listeners.set(event, current.filter((h) => h !== handler))
      }
    },
    webServer: {
      register({ path, handler }) {
        assert.equal(routes.has(path), false, `路由重复注册：${path}`)
        routes.set(path, handler)
        return () => routes.delete(path)
      },
    },
  }
  return { ctx, routes, listeners, logs, effectDisposers }
}

export function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v },
    end(text) { this.body = text ?? '' },
  }
}

export async function call(routes, path, { method = 'GET', body } = {}) {
  const pathname = path.split('?')[0]
  const handler = routes.get(pathname)
  assert.ok(handler, `路由未注册：${pathname}`)
  const res = makeRes()
  const req = {
    method,
    url: path,
    on(event, cb) {
      if (event === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)))
      if (event === 'end') cb()
    },
  }
  await handler(req, res)
  return { status: res.statusCode, json: res.body === '' ? null : JSON.parse(res.body) }
}

/** 收集一个 async iterable 的全部 chunk。 */
export async function drain(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

const { ctx, routes, listeners, logs } = makeCtx()

// ---- 插件契约 ----
assert.equal(name, 'dsh-peak-brief')
assert.deepEqual(inject, ['agents', 'llm', 'sessions', 'webServer'])
assert.equal(typeof apply, 'function')

apply(ctx, { leadMinutes: 7 })

// ---- 路由与事件接线 ----
assert.deepEqual(
  [...routes.keys()].sort(),
  [
    '/api/peak-brief.allow',
    '/api/peak-brief.allow-off',
    '/api/peak-brief.brief',
    '/api/peak-brief.debug-clock',
    '/api/peak-brief.debug-tick',
    '/api/peak-brief.dismiss',
    '/api/peak-brief.hello',
    '/api/peak-brief.refresh-holidays',
    '/api/peak-brief.state',
  ],
)
assert.equal(listeners.get('llm/stream')?.length, 1, '必须挂上一个 llm/stream 监听器')
assert.ok(logs.length >= 1)

// ---- 挂载即有一条待提示通知 ----
const first = await call(routes, '/api/peak-brief.state')
assert.equal(first.status, 200)
assert.equal(first.json.ok, true)
assert.equal(first.json.state.plugin, 'dsh-peak-brief')
assert.equal(first.json.state.config.leadMinutes, 7, '传入的 config 必须被合并')
assert.equal(first.json.state.config.notify, 'popup', '未传的字段必须保留默认值')
assert.equal(first.json.state.config.blockAuxiliary, true, '默认连辅助请求一起拦')
assert.ok(first.json.state.notice, '挂载后应当有一条待提示通知')
const seq1 = first.json.state.notice.seq
assert.equal(first.json.state.notice.kind, 'info')
assert.match(first.json.state.notice.text, /门控：未启用/)

// ---- 关闭当前那条 ----
const dismissed = await call(routes, '/api/peak-brief.dismiss', { method: 'POST', body: { seq: seq1 } })
assert.equal(dismissed.status, 200)
assert.equal(dismissed.json.state.notice, null, '关闭后不应再有通知')

const afterDismiss = await call(routes, '/api/peak-brief.state')
assert.equal(afterDismiss.json.state.notice, null)

// ---- 过期 dismiss 不能抹掉更新的通知（竞态保护）----
const hello = await call(routes, '/api/peak-brief.hello', { method: 'POST', body: { text: '第二条' } })
assert.equal(hello.status, 200)
const seq2 = hello.json.notice.seq
assert.ok(seq2 > seq1, 'seq 必须单调递增')

const stale = await call(routes, '/api/peak-brief.dismiss', { method: 'POST', body: { seq: seq1 } })
assert.equal(stale.status, 200)
assert.ok(stale.json.state.notice, '旧的 seq 不应该关掉新通知')
assert.equal(stale.json.state.notice.seq, seq2)

// ---- hello 不带 text 时也要有一条可读文案 ----
const auto = await call(routes, '/api/peak-brief.hello', { method: 'POST' })
assert.equal(auto.status, 200)
assert.equal(typeof auto.json.notice.text, 'string')
assert.ok(auto.json.notice.text.length > 0)

// ---- 方法校验 ----
assert.equal((await call(routes, '/api/peak-brief.dismiss', { method: 'GET' })).status, 405)
assert.equal((await call(routes, '/api/peak-brief.allow', { method: 'GET' })).status, 405)

// ---- 默认 enabled=false：门控完全不拦 ----
const streamListener = listeners.get('llm/stream')[0]
let nextCalled = 0
const passthrough = streamListener({ provider: 'deepseek-official', model: 'x', messages: [] }, () => {
  nextCalled += 1
  return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } } })()
})
assert.equal(nextCalled, 1, '未启用时应该直接放行')
assert.equal((await drain(passthrough))[0].reason.kind, 'stop')

// ---- 非法 minutes 被拒 ----
const badAllow = await call(routes, '/api/peak-brief.allow', { method: 'POST', body: { minutes: -1 } })
assert.equal(badAllow.status, 400)
assert.equal(badAllow.json.error, 'bad_minutes')

// ---- effect dispose 必须注销全部路由 ----
const second = makeCtx()
apply(second.ctx, {})
assert.equal(second.routes.size, 9)
for (const teardown of second.effectDisposers) teardown()
assert.equal(second.routes.size, 0, 'dispose 后路由必须全部注销')

console.log('smoke: 全部断言通过')
