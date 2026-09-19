/**
 * P1 集成测试：驱动**真实的** lib/index.js（而不是复刻它的逻辑），
 * 走 webServer 路由拿到判定结果。这覆盖了单测覆盖不到的那一层——
 * 配置解析 → createCalendar → createWindows → 路由 → JSON 输出。
 *
 *   node --test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name, inject } from '../lib/index.js'
import { briefPathFor, writeBriefFile } from '../lib/brief-store.js'
import { GATE_CODE } from '../lib/gate.js'
import { zonedParts } from '../lib/tz.js'

function makeCtx(services = {}) {
  const routes = new Map()
  const listeners = new Map()
  const logs = []
  const effectDisposers = []
  const ctx = {
    logger: { info: (m) => logs.push(m) },
    ...services,
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
      return () => listeners.set(event, (listeners.get(event) ?? []).filter((h) => h !== handler))
    },
    /** 模型 cordis 的可选依赖注入：依赖齐了才跑回调。 */
    inject(deps, callback) {
      const ready = deps.every((dep) => ctx[dep] !== undefined && ctx[dep] !== null)
      if (ready) callback(ctx)
      return { dispose() {} }
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

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v },
    end(text) { this.body = text ?? '' },
  }
}

async function call(routes, path, { method = 'GET', body } = {}) {
  // 路由按路径（不含查询串）注册；req.url 保留完整串，供 handler 解析 ?at=。
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

/** 查某个中国标准时刻的判定。`at` 用显式 +08:00，避免测试依赖被测时区换算。 */
async function statusAt(routes, localIso) {
  const query = encodeURIComponent(`${localIso}+08:00`)
  const res = await call(routes, `/api/peak-brief.state?at=${query}`)
  assert.equal(res.status, 200, `查询 ${localIso} 失败`)
  return res.json.state.status
}

function boot(config = {}, services = {}) {
  const { ctx, routes, listeners, logs, effectDisposers } = makeCtx(services)
  apply(ctx, config)
  return { routes, listeners, logs, effectDisposers }
}

/** 调用已注册的 llm/stream 监听器，返回 { blocked, nextCalled, chunks }。 */
async function runStreamListener(listeners, options) {
  const listener = (listeners.get('llm/stream') ?? [])[0]
  assert.ok(listener, 'llm/stream 监听器未注册')
  let nextCalled = 0
  const returned = listener(options, () => {
    nextCalled += 1
    return (async function* downstream() { yield { type: 'finish', reason: { kind: 'stop' } } })()
  })
  const chunks = []
  for await (const chunk of returned) chunks.push(chunk)
  return { nextCalled, chunks }
}

test('插件契约与路由注册', () => {
  const { routes, listeners, logs } = boot({})
  assert.equal(name, 'dsh-peak-brief')
  assert.deepEqual(inject, ['agents', 'llm', 'sessions', 'webServer'])
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
  assert.equal((listeners.get('llm/stream') ?? []).length, 1)
  assert.equal(logs.length, 1)
  assert.match(logs[0], /已挂载（P5\+设置界面）/)
})

test('集成：普通工作日 08:50 进入 lead，09:00 进入 peak', async () => {
  const { routes } = boot({})

  const lead = await statusAt(routes, '2026-09-17T08:50:00')
  assert.equal(lead.phase, 'lead')
  assert.equal(lead.dayKind, 'weekday')
  assert.equal(lead.peakDay, true)
  assert.equal(lead.enabled, false, '默认未启用，只观测')
  assert.equal(lead.enforcement, 'none')

  assert.equal((await statusAt(routes, '2026-09-17T08:49:00')).phase, 'off')
  assert.equal((await statusAt(routes, '2026-09-17T09:00:00')).phase, 'peak')
  assert.equal((await statusAt(routes, '2026-09-17T12:00:00')).phase, 'off')
  assert.equal((await statusAt(routes, '2026-09-17T13:50:00')).phase, 'lead')
  assert.equal((await statusAt(routes, '2026-09-17T14:00:00')).phase, 'peak')
  assert.equal((await statusAt(routes, '2026-09-17T18:00:00')).phase, 'off')
})

test('集成：法定节假日全天 off', async () => {
  const { routes } = boot({})
  const holiday = await statusAt(routes, '2026-10-01T10:00:00')
  assert.equal(holiday.phase, 'off')
  assert.equal(holiday.dayKind, 'holiday')
  assert.equal(holiday.dayLabel, '国庆节')
  assert.equal(holiday.peakDay, false)

  // 节后第一个工作日恢复
  const back = await statusAt(routes, '2026-10-08T10:00:00')
  assert.equal(back.phase, 'peak')
  assert.equal(back.dayKind, 'weekday')
})

test('集成：调休上班日全天 off（不会因为是"工作日"就进高峰）', async () => {
  const { routes } = boot({})
  for (const date of ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10']) {
    const status = await statusAt(routes, `${date}T10:00:00`)
    assert.equal(status.phase, 'off', `${date} 应全天闲时`)
    assert.equal(status.dayKind, 'makeup-workday')
    assert.equal(status.peakDay, false)
  }
})

test('集成：周末 off，且下次切换跳到下一个真正的峰谷日', async () => {
  const { routes } = boot({})
  const sat = await statusAt(routes, '2026-09-19T10:00:00')
  assert.equal(sat.phase, 'off')
  assert.equal(sat.dayKind, 'weekend')
  // 09-20 是调休上班日（也全天 off），所以下一次是 09-21 周一
  assert.equal(sat.nextSwitch.date, '2026-09-21')
  assert.equal(sat.nextSwitch.to, 'lead')
})

test('集成：未知年份降级为周一至周五', async () => {
  const { routes } = boot({})
  const wed = await statusAt(routes, '2027-03-10T10:00:00')
  assert.equal(wed.dayKind, 'unknown-year')
  assert.equal(wed.peakDay, true)
  assert.equal(wed.phase, 'peak')

  const sat = await statusAt(routes, '2027-03-13T10:00:00')
  assert.equal(sat.peakDay, false)
  assert.equal(sat.phase, 'off')
})

test('集成：配置里的提前量与时段真的生效', async () => {
  const { routes } = boot({
    leadMinutes: 30,
    peakWindows: [['10:00', '11:00']],
    timezone: 'Asia/Shanghai',
  })
  assert.equal((await statusAt(routes, '2026-09-17T09:29:00')).phase, 'off')
  assert.equal((await statusAt(routes, '2026-09-17T09:30:00')).phase, 'lead')
  assert.equal((await statusAt(routes, '2026-09-17T10:00:00')).phase, 'peak')
  assert.equal((await statusAt(routes, '2026-09-17T11:00:00')).phase, 'off')

  // 默认的两个时段在这里不该生效
  assert.equal((await statusAt(routes, '2026-09-17T14:30:00')).phase, 'off')
})

test('集成：手动覆盖经配置生效', async () => {
  const { routes } = boot({ overrides: { '2026-09-19': 'peak', '2026-09-17': 'off' } })
  assert.equal((await statusAt(routes, '2026-09-19T10:00:00')).phase, 'peak')
  assert.equal((await statusAt(routes, '2026-09-17T10:00:00')).phase, 'off')
  assert.equal((await statusAt(routes, '2026-09-19T10:00:00')).daySource, 'override')
})

test('集成：非法 at 参数返回 400 而不是猜', async () => {
  const { routes } = boot({})
  const res = await call(routes, '/api/peak-brief.state?at=不是时间')
  assert.equal(res.status, 400)
  assert.equal(res.json.error, 'bad_at')
})

test('集成：非法配置在挂载时大声失败', () => {
  assert.throws(() => boot({ peakWindows: [['09:00', '12:00'], ['11:00', '13:00']] }), /重叠/)
  assert.throws(() => boot({ timezone: 'Nowhere/Fake' }), /IANA 时区/)
  assert.throws(() => boot({ leadMinutes: -5 }), /leadMinutes/)
  assert.throws(() => boot({ gateMode: '随便' }), /gateMode/)
  assert.throws(() => boot({ blockAuxiliary: 'yes' }), /blockAuxiliary/)
  assert.throws(() => boot({ overrides: { '不是日期': 'off' } }), /YYYY-MM-DD/)
})

test('集成：挂载横幅带出真实相位与日历判定', async () => {
  const { routes } = boot({})
  const res = await call(routes, '/api/peak-brief.state')
  const notice = res.json.state.notice
  assert.ok(notice, '挂载后应有一条提示')
  assert.equal(notice.kind, 'info')
  assert.match(notice.text, /dsh-peak-brief 已挂载/)
  assert.match(notice.text, /相位 (off|lead|peak)/)
  assert.match(notice.text, /下次切换：/)
  assert.match(notice.text, /门控：/)
  assert.equal(res.json.state.phase, 'P5+设置界面')
  assert.equal(typeof res.json.state.build, 'string')
})

test('集成：dispose 后路由全部注销', () => {
  const { routes, effectDisposers } = boot({})
  assert.equal(routes.size, 9)
  for (const teardown of effectDisposers) teardown()
  assert.equal(routes.size, 0)
})

// ---------------------------------------------------------------- P2 门控

/** 把"今天"（插件配置时区里的今天）覆盖成峰谷日，并让时段覆盖全天，
 *  这样测试不依赖跑测试的那一天恰好是工作日。 */
const TODAY = zonedParts(Date.now(), 'Asia/Shanghai').date

function peakNow(extra = {}) {
  return {
    enabled: true,
    gateMode: 'hard',
    overrides: { [TODAY]: 'peak' },
    peakWindows: [['00:00', '24:00']],
    ...extra,
  }
}

test('P2：enabled=false 时即使是全天高峰也不拦', async () => {
  const { listeners } = boot(peakNow({ enabled: false }))
  const run = await runStreamListener(listeners, { provider: 'p', model: 'm', messages: [] })
  assert.equal(run.nextCalled, 1, '未启用必须放行')
  assert.equal(run.chunks[0].reason.kind, 'stop')
})

test('P2：enabled + peak 时拦截，且返回的是合法终止 finish', async () => {
  const { listeners } = boot(peakNow())
  const run = await runStreamListener(listeners, { provider: 'p', model: 'm', messages: [] })

  assert.equal(run.nextCalled, 0, '拦截时绝不能调用下游 next()')
  assert.equal(run.chunks.length, 1, '拦截流只应包含终止 chunk')
  const chunk = run.chunks[0]
  assert.equal(chunk.type, 'finish')
  assert.equal(chunk.reason.kind, 'error', '用 error 而不是 aborted：这是策略拒绝，不是用户取消')
  assert.equal(chunk.reason.failure.code, GATE_CODE)
  assert.match(chunk.reason.failure.message, /已拦截本次模型请求/)
  assert.match(chunk.reason.failure.message, /peak-allow/, '必须告诉用户怎么放行')
})

test('P2：拦截码不在 dsh-llm 的可重试集合里（否则会被无限重试）', () => {
  const retryable = ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']
  assert.equal(retryable.includes(GATE_CODE), false)
  assert.equal(GATE_CODE, 'PEAK_BRIEF_BLOCKED')
})

test('P2：默认连辅助请求一起拦；blockAuxiliary=false 时放行', async () => {
  const strict = boot(peakNow())
  const blockedAux = await runStreamListener(strict.listeners, {
    provider: 'p', model: 'm', messages: [], purpose: 'session-title',
  })
  assert.equal(blockedAux.nextCalled, 0, '默认连标题/压缩这类辅助请求也拦')

  const lenient = boot(peakNow({ blockAuxiliary: false }))
  const allowedAux = await runStreamListener(lenient.listeners, {
    provider: 'p', model: 'm', messages: [], purpose: 'session-title',
  })
  assert.equal(allowedAux.nextCalled, 1)

  // 但普通对话请求在 lenient 模式下仍然被拦
  const normal = await runStreamListener(lenient.listeners, { provider: 'p', model: 'm', messages: [] })
  assert.equal(normal.nextCalled, 0)
})

test('P2：/peak-allow 放行，/peak-allow-off 立刻恢复拦截', async () => {
  const { routes, listeners } = boot(peakNow())
  const options = () => ({ provider: 'p', model: 'm', messages: [] })

  assert.equal((await runStreamListener(listeners, options())).nextCalled, 0, '先确认在拦')

  const allow = await call(routes, '/api/peak-brief.allow', { method: 'POST', body: { minutes: 15 } })
  assert.equal(allow.status, 200)
  assert.equal(allow.json.allow.active, true)
  assert.equal((await runStreamListener(listeners, options())).nextCalled, 1, '放行后必须通过')

  const off = await call(routes, '/api/peak-brief.allow-off', { method: 'POST' })
  assert.equal(off.status, 200)
  assert.equal(off.json.allow.active, false)
  assert.equal((await runStreamListener(listeners, options())).nextCalled, 0, '关闭后必须恢复拦截')
})

test('P2：放行窗口不会超过本段高峰的结束时刻', async () => {
  // 用真实的 09:00-12:00 时段，并强制 2026-09-17（周四）为峰谷日，
  // 通过 gate 的纯接口验证"本次放行"只到本段结束，而不是把整个下午放过。
  const { createGate } = await import('../lib/gate.js')
  const { createWindows } = await import('../lib/windows.js')
  const { createCalendar } = await import('../lib/calendar.js')

  const calendar = createCalendar({})
  const windows = createWindows({
    calendar,
    peakWindows: [['09:00', '12:00'], ['14:00', '18:00']],
    timezone: 'Asia/Shanghai',
    leadMinutes: 10,
  })
  const gate = createGate({ windows, config: { enabled: true, gateMode: 'hard' } })

  const at = Date.parse('2026-09-17T10:00:00+08:00') // 高峰中
  const allow = gate.allowFor(600, at) // 想要 10 小时
  assert.equal(new Date(allow.until).toISOString(), new Date(Date.parse('2026-09-17T12:00:00+08:00')).toISOString())
})

test('P2：status 反映真实的拦截状态与逃生窗口', async () => {
  const { routes } = boot(peakNow())
  const blocked = await statusAt(routes, `${TODAY}T10:00:00`)
  assert.equal(blocked.enforcement, 'hard-block')
  assert.equal(blocked.gate.blocking, true)
  assert.equal(blocked.gate.code, GATE_CODE)

  await call(routes, '/api/peak-brief.allow', { method: 'POST', body: { minutes: 5 } })
  const allowed = await statusAt(routes, `${TODAY}T10:00:00`)
  assert.equal(allowed.gate.allow.active, true)

  const off = boot(peakNow({ enabled: false }))
  assert.equal((await statusAt(off.routes, `${TODAY}T10:00:00`)).enforcement, 'none')
})

// ---------------------------------------------------------------- P3 简报

const BRIEF_JSON = JSON.stringify({
  objective: '完成 dsh-peak-brief 的 P3',
  status: 'in_progress',
  resumable: true,
  done: ['P0', 'P1', 'P2'],
  remaining: ['P4'],
  next_actions: ['写 resume.js'],
  files: ['lib/index.js'],
  blockers: [],
  notes: '零依赖',
})

function textChunks(text) {
  return [
    { type: 'text-delta', index: 0, text },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function fakeLlm(chunks) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      return (async function* run() { for (const c of chunks) yield c })()
    },
  }
}

function makeAgent(sessionId, messages = []) {
  return {
    session: {
      id: sessionId,
      deriveMessages: () => messages,
      requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
    },
  }
}

function addAgent(listeners, agent) {
  for (const listener of listeners.get('agent/created') ?? []) listener({ agent })
  return agent
}

test('P3：/api/peak-brief.brief 生成简报并落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peak-brief-int-'))
  try {
    const llm = fakeLlm(textChunks(BRIEF_JSON))
    const { routes, listeners } = boot({ brief: { dir } }, { llm })
    addAgent(listeners, makeAgent('sess-1', [
      { role: 'user', content: [{ type: 'text', text: '把 P3 做完' }] },
    ]))

    const res = await call(routes, '/api/peak-brief.brief', { method: 'POST', body: {} })
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
    assert.equal(res.json.degraded, false)
    assert.equal(res.json.brief.objective, '完成 dsh-peak-brief 的 P3')
    assert.deepEqual(res.json.brief.next_actions, ['写 resume.js'])

    assert.ok(res.json.filePath, '必须落盘')
    assert.equal(existsSync(res.json.filePath), true)

    // 简报确实走了会话已记录的请求路由
    assert.equal(llm.calls[0].provider, 'deepseek-official')
    assert.equal(llm.calls[0].model, 'deepseek-flash')
    assert.equal(llm.calls[0].purpose, undefined)

    // 状态里能看到这份简报
    const state = (await call(routes, '/api/peak-brief.state')).json.state.status
    assert.deepEqual(state.liveSessions, ['sess-1'])
    assert.equal(state.briefs.length, 1)
    assert.equal(state.briefs[0].sessionId, 'sess-1')
    assert.equal(state.briefs[0].degraded, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P3：没有活会话 / 会话不明确时明确报错，不猜', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peak-brief-int-'))
  try {
    const { routes, listeners } = boot({ brief: { dir } }, { llm: fakeLlm(textChunks(BRIEF_JSON)) })

    const none = await call(routes, '/api/peak-brief.brief', { method: 'POST', body: {} })
    assert.equal(none.status, 409)
    assert.equal(none.json.error, 'no_live_agent')

    addAgent(listeners, makeAgent('sess-a'))
    addAgent(listeners, makeAgent('sess-b'))

    const ambiguous = await call(routes, '/api/peak-brief.brief', { method: 'POST', body: {} })
    assert.equal(ambiguous.status, 409)
    assert.equal(ambiguous.json.error, 'ambiguous_session')
    assert.deepEqual(ambiguous.json.sessions.sort(), ['sess-a', 'sess-b'])

    const explicit = await call(routes, '/api/peak-brief.brief', { method: 'POST', body: { sessionId: 'sess-b' } })
    assert.equal(explicit.status, 200)
    assert.equal(explicit.json.meta.sessionId, 'sess-b')

    const unknown = await call(routes, '/api/peak-brief.brief', { method: 'POST', body: { sessionId: 'nope' } })
    assert.equal(unknown.status, 404)
    assert.equal(unknown.json.error, 'unknown_session')

    // agent/disposed 之后该会话不再可选
    for (const listener of listeners.get('agent/disposed') ?? []) listener({ agent: makeAgent('sess-a') })
    const afterDispose = await call(routes, '/api/peak-brief.brief', { method: 'POST', body: { sessionId: 'sess-a' } })
    assert.equal(afterDispose.status, 404)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P3：模型不可用 / 输出不可解析时降级，仍然产出可用的简报', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peak-brief-int-'))
  try {
    // 没有 llm 服务 → NO_LLM → 降级
    const noLlm = boot({ brief: { dir } }, {})
    addAgent(noLlm.listeners, makeAgent('sess-x', [
      { role: 'user', content: [{ type: 'text', text: '原始用户消息' }] },
    ]))
    const res = await call(noLlm.routes, '/api/peak-brief.brief', { method: 'POST', body: {} })
    assert.equal(res.status, 200, '降级也必须成功产出，否则会丢工作')
    assert.equal(res.json.degraded, true)
    assert.equal(res.json.brief.degraded, true)
    assert.match(res.json.brief.notes, /NO_LLM/)
    assert.match(res.json.brief.notes, /原始用户消息/)
    assert.equal(existsSync(res.json.filePath), true)

    const notice = (await call(noLlm.routes, '/api/peak-brief.state')).json.state.notice
    assert.equal(notice.kind, 'warn', '降级必须用 warn 提醒')

    // 模型胡说八道 → BRIEF_UNPARSEABLE → 降级
    const garbage = boot({ brief: { dir } }, { llm: fakeLlm(textChunks('我不会做这个')) })
    addAgent(garbage.listeners, makeAgent('sess-y'))
    const res2 = await call(garbage.routes, '/api/peak-brief.brief', { method: 'POST', body: {} })
    assert.equal(res2.json.degraded, true)
    assert.match(res2.json.brief.notes, /BRIEF_UNPARSEABLE/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P3：简报输入超预算时直接降级，不花那次钱', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peak-brief-int-'))
  try {
    const llm = fakeLlm(textChunks(BRIEF_JSON))
    const { routes, listeners } = boot({ brief: { dir, maxInputBytes: 64 } }, { llm })
    addAgent(listeners, makeAgent('sess-big', [
      { role: 'user', content: [{ type: 'text', text: 'x'.repeat(5000) }] },
    ]))

    const res = await call(routes, '/api/peak-brief.brief', { method: 'POST', body: {} })
    assert.equal(res.status, 200)
    assert.equal(res.json.degraded, true)
    assert.match(res.json.brief.notes, /BRIEF_OVER_BUDGET/)
    assert.equal(llm.calls.length, 0, '超预算时绝不能调用模型')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------- P4：用时钟覆盖跑完一整天

/** 假目标服务，记录 disarm / resume 的调用。 */
function makeGoals(over = {}) {
  const state = { phase: 'active', activation: 'armed', revision: 3, disarmed: 0, resumed: 0, ...over }
  return {
    state,
    get() {
      return {
        id: 'goal-1',
        revision: state.revision,
        objective: '把 dsh-peak-brief 做完',
        phase: state.phase,
        activation: state.activation,
        roundsStarted: 1,
        maxGoalRounds: 40,
      }
    },
    disarm() {
      state.disarmed += 1
      state.activation = 'disarmed'
      return this.get()
    },
    resume(_agent, ref) {
      if (ref.id !== 'goal-1') throw new Error('bad ref')
      state.resumed += 1
      state.activation = 'armed'
      state.revision += 1
      return this.get()
    },
  }
}

/** 假 agent，记录 inject / followup。 */
function makeSpyAgent(sessionId) {
  const spy = { injected: [], followedUp: [] }
  return {
    spy,
    agent: {
      session: {
        id: sessionId,
        deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: '把 P4 做完' }] }],
        requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
      },
      inject: (m) => spy.injected.push(m),
      followup: (m) => spy.followedUp.push(m),
    },
  }
}

const tick = (routes, at) => call(routes, '/api/peak-brief.debug-tick', { method: 'POST', body: at === undefined ? {} : { at } })

test('P4 全周期推演：T-10 简报并解除续跑 → 高峰拦截 → 闲时交回并恢复 → 删文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peak-brief-cycle-'))
  try {
    const llm = fakeLlm(textChunks(BRIEF_JSON))
    const goals = makeGoals()
    const { routes, listeners } = boot(
      {
        enabled: true,
        overrides: { [TODAY]: 'peak' },
        peakWindows: [['09:00', '12:00'], ['14:00', '18:00']],
        leadMinutes: 10,
        brief: { dir },
      },
      { llm, goals },
    )
    const { agent, spy } = makeSpyAgent('sess-cycle')
    addAgent(listeners, agent)

    // ① 08:30 闲时：什么都不该发生
    const early = await tick(routes, `${TODAY}T08:30:00+08:00`)
    assert.equal(early.json.tick.phase, 'off')
    assert.equal(early.json.tick.actions[0].action, 'none')
    assert.equal(spy.followedUp.length, 0)

    // ② 08:50 进入提前量：生成简报 + 解除目标续跑授权
    const lead = await tick(routes, `${TODAY}T08:50:00+08:00`)
    assert.equal(lead.json.tick.phase, 'lead')
    assert.equal(lead.json.tick.actions[0].action, 'brief')
    assert.equal(lead.json.tick.actions[0].disarm.attempted, true)
    assert.equal(goals.state.disarmed, 1)
    assert.equal(llm.calls.length, 1, '简报应该真的调了一次模型')

    const briefPath = lead.json.state.status.cycles[0].briefPath
    assert.equal(existsSync(briefPath), true, '简报必须落盘')

    // ③ 同一高峰段内不重复生成（接受标准 7）
    const again = await tick(routes, `${TODAY}T08:55:00+08:00`)
    assert.equal(again.json.tick.actions[0].action, 'none')
    assert.equal(again.json.tick.actions[0].reason, 'already-briefed')
    assert.equal(llm.calls.length, 1, '不能重复烧钱')
    assert.equal(goals.state.disarmed, 1, '不能重复 disarm')

    // ④ 09:30 高峰中：定时器无事可做，门控按相位拦
    const peak = await tick(routes, `${TODAY}T09:30:00+08:00`)
    assert.equal(peak.json.tick.phase, 'peak')
    assert.equal(peak.json.tick.actions[0].action, 'none')
    assert.equal(peak.json.tick.actions[0].reason, 'peak')

    const blocked = await runStreamListener(listeners, { provider: 'p', model: 'm', messages: [] })
    assert.equal(blocked.nextCalled, 0, '高峰期间必须真的拦住')
    assert.equal(blocked.chunks[0].reason.failure.code, GATE_CODE)

    // ⑤ 12:00 闲时：交回简报 + 起一轮 + 重新武装目标 + 删文件
    const resume = await tick(routes, `${TODAY}T12:00:00+08:00`)
    assert.equal(resume.json.tick.phase, 'off')
    const action = resume.json.tick.actions[0]
    assert.equal(action.action, 'resume')
    assert.equal(action.injected, true, '必须 inject 一行 notice')
    assert.equal(action.followedUp, true, '必须 followup 携带完整简报')
    assert.equal(action.goalResumed, true, '目标必须重新武装')
    assert.equal(action.fileDeleted, true, '简报文件必须删掉')

    assert.equal(spy.injected.length, 1)
    assert.equal(spy.followedUp.length, 1)
    assert.equal(spy.injected[0].source.form, 'notice')
    assert.match(spy.followedUp[0].content[0].text, /\[PEAK-BRIEF RESUME\]/)
    assert.match(spy.followedUp[0].content[0].text, /完成 dsh-peak-brief 的 P3/)
    assert.equal(goals.state.resumed, 1)
    assert.equal(existsSync(briefPath), false, '文件应已被删除')

    // ⑥ 恢复后不再重复恢复
    const after = await tick(routes, `${TODAY}T12:05:00+08:00`)
    assert.equal(after.json.tick.actions[0].reason, 'nothing-pending')
    assert.equal(spy.followedUp.length, 1)

    // ⑦ 门控在闲时确实放行
    const allowed = await runStreamListener(listeners, { provider: 'p', model: 'm', messages: [] })
    assert.equal(allowed.nextCalled, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P4：简报判定不可继续时，不凭空起一轮', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peak-brief-cycle-'))
  try {
    const doneJson = JSON.stringify({ objective: '已完成', status: 'done', resumable: true })
    const llm = fakeLlm(textChunks(doneJson))
    const goals = makeGoals()
    const { routes, listeners } = boot(
      {
        enabled: true,
        overrides: { [TODAY]: 'peak' },
        peakWindows: [['09:00', '12:00']],
        leadMinutes: 10,
        brief: { dir },
      },
      { llm, goals },
    )
    const { agent, spy } = makeSpyAgent('sess-done')
    addAgent(listeners, agent)

    await tick(routes, `${TODAY}T08:50:00+08:00`)
    const resume = await tick(routes, `${TODAY}T12:00:00+08:00`)
    const action = resume.json.tick.actions[0]

    assert.equal(action.skipped, 'brief-not-resumable')
    assert.equal(action.followedUp, false, '已完成的任务不该被重新拉起来')
    assert.equal(action.goalResumed, false)
    assert.equal(spy.followedUp.length, 0)
    assert.equal(action.fileDeleted, true, '文件仍要清掉')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P4：未启用时定时器完全不排，debug-tick 也不动作', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peak-brief-cycle-'))
  try {
    const { routes, listeners } = boot({ enabled: false, brief: { dir } }, { llm: fakeLlm(textChunks(BRIEF_JSON)) })
    addAgent(listeners, makeSpyAgent('sess-off').agent)

    const res = await tick(routes)
    assert.equal(res.json.tick.enabled, false)
    assert.equal(res.json.tick.actions[0].action, 'none')
    assert.equal(res.json.tick.actions[0].reason, 'disabled')
    assert.equal(res.json.tick.nextTickInMs, null, '未启用时不该排定时器')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P4：没有 goal 服务时，简报照做、续跑无从谈起（不报错）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peak-brief-cycle-'))
  try {
    const { routes, listeners } = boot(
      {
        enabled: true,
        overrides: { [TODAY]: 'peak' },
        peakWindows: [['09:00', '12:00']],
        brief: { dir },
      },
      { llm: fakeLlm(textChunks(BRIEF_JSON)) },
    )
    addAgent(listeners, makeSpyAgent('sess-nogoal').agent)

    const lead = await tick(routes, `${TODAY}T08:50:00+08:00`)
    assert.equal(lead.json.tick.actions[0].action, 'brief')
    assert.equal(lead.json.tick.actions[0].disarm.attempted, false)
    assert.equal(lead.json.tick.actions[0].disarm.reason, 'no-goal-service')

    const resume = await tick(routes, `${TODAY}T12:00:00+08:00`)
    assert.equal(resume.json.tick.actions[0].followedUp, true, '没有 goal 也要交回简报')
    assert.equal(resume.json.tick.actions[0].goalResumed, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P4：debug-clock 装卸时钟覆盖', async () => {
  const { routes } = boot({})
  const set = await call(routes, '/api/peak-brief.debug-clock', {
    method: 'POST', body: { at: '2026-09-17T09:30:00+08:00' },
  })
  assert.equal(set.status, 200)
  assert.equal(set.json.overridden, true)
  assert.equal(set.json.state.status.localTime, '09:30')

  const bad = await call(routes, '/api/peak-brief.debug-clock', { method: 'POST', body: { at: '不是时间' } })
  assert.equal(bad.status, 400)

  const cleared = await call(routes, '/api/peak-brief.debug-clock', { method: 'POST', body: { clear: true } })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.json.overridden, false)
})

// ---------------------------------------------------------- 启动期对账（标准 8）

test('P4：重启对账——磁盘上有待恢复简报时会继续，不会卡在暂停', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peak-brief-recover-'))
  try {
    // 模拟"上一次进程留下的待恢复简报"：文件存在 ⟺ 有一次未恢复的暂停
    const pendingMeta = {
      sessionId: 'sess-recover',
      pausedAt: '2026-09-19T08:50:00.000Z',
      peakStartAt: Date.parse(`${TODAY}T09:00:00+08:00`),
      disarm: { attempted: true, reason: 'disarmed', wasArmed: true },
    }
    writeBriefFile(dir, 'sess-recover', {
      brief: { objective: '重启前未完成的任务', status: 'in_progress', resumable: true, done: [], remaining: ['继续'], next_actions: [], files: [], blockers: [], notes: '' },
      meta: pendingMeta,
    })

    const goals = makeGoals()
    const { routes, listeners } = boot(
      { enabled: true, overrides: { [TODAY]: 'peak' }, peakWindows: [['09:00', '12:00']], brief: { dir } },
      { goals },
    )
    const { agent, spy } = makeSpyAgent('sess-recover')
    addAgent(listeners, agent)

    // 对账发生了：内存里出现了"已简报、未恢复"的周期
    const state = (await call(routes, '/api/peak-brief.state')).json.state.status
    assert.equal(state.cycles.length, 1)
    assert.equal(state.cycles[0].briefed, true)
    assert.equal(state.cycles[0].resumed, false)
    assert.equal(state.cycles[0].disarmAttempted, true, 'disarm 记录必须从磁盘恢复')

    const notice = (await call(routes, '/api/peak-brief.state')).json.state.notice
    assert.match(notice.text, /重启对账/)

    // 闲时 tick 应当真的恢复它
    const resume = await tick(routes, `${TODAY}T12:00:00+08:00`)
    const action = resume.json.tick.actions[0]
    assert.equal(action.action, 'resume')
    assert.equal(action.followedUp, true)
    assert.match(spy.followedUp[0].content[0].text, /重启前未完成的任务/)
    assert.equal(action.goalResumed, true, '重启后目标也应重新武装')
    assert.equal(goals.state.resumed, 1)
    assert.equal(action.fileDeleted, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P4：过旧的待恢复简报不予认领（不把一周前的任务拉起来）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peak-brief-recover-'))
  try {
    const record = {
      version: 1,
      plugin: 'dsh-peak-brief',
      writtenAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      brief: { objective: '三天前的任务', status: 'in_progress', resumable: true },
      meta: { peakStartAt: 0, disarm: { attempted: true, wasArmed: true } },
    }
    writeFileSync(briefPathFor(dir, 'sess-stale'), JSON.stringify(record), 'utf8')

    const { routes, listeners } = boot(
      { enabled: true, overrides: { [TODAY]: 'peak' }, peakWindows: [['09:00', '12:00']], brief: { dir } },
      { goals: makeGoals() },
    )
    const { agent, spy } = makeSpyAgent('sess-stale')
    addAgent(listeners, agent)

    const state = (await call(routes, '/api/peak-brief.state')).json.state.status
    assert.equal(state.cycles.length, 0, '过期简报不该被认领')

    const result = await tick(routes, `${TODAY}T12:00:00+08:00`)
    assert.equal(result.json.tick.actions[0].action, 'none')
    assert.equal(spy.followedUp.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P4：重启对账后若正处于高峰，不会立刻恢复（等闲时）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peak-brief-recover-'))
  try {
    writeBriefFile(dir, 'sess-midpeak', {
      brief: { objective: '高峰中重启', status: 'in_progress', resumable: true },
      meta: { peakStartAt: Date.parse(`${TODAY}T09:00:00+08:00`), disarm: { attempted: true, wasArmed: true } },
    })

    const { routes, listeners } = boot(
      { enabled: true, overrides: { [TODAY]: 'peak' }, peakWindows: [['09:00', '12:00']], brief: { dir } },
      { goals: makeGoals() },
    )
    addAgent(listeners, makeSpyAgent('sess-midpeak').agent)

    const peak = await tick(routes, `${TODAY}T10:00:00+08:00`)
    assert.equal(peak.json.tick.phase, 'peak')
    assert.equal(peak.json.tick.actions[0].action, 'none')
    assert.equal(peak.json.tick.actions[0].reason, 'peak')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------- 可选联网刷新节假日数据

test('联网刷新：默认关闭时明确跳过，不偷偷发请求', async () => {
  let fetchCalls = 0
  const original = globalThis.fetch
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('不该被调用') }
  try {
    const { routes } = boot({})
    const res = await call(routes, '/api/peak-brief.refresh-holidays', { method: 'POST' })
    assert.equal(res.status, 200)
    assert.equal(res.json.skipped, 'disabled')
    assert.equal(fetchCalls, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('联网刷新：开着但没配 url 时也跳过', async () => {
  const { routes } = boot({ holidayRefresh: { enabled: true, url: '' } })
  const res = await call(routes, '/api/peak-brief.refresh-holidays', { method: 'POST' })
  assert.equal(res.json.skipped, 'no-url')
})

test('联网刷新：成功并入运行期表，并立即影响判定', async () => {
  const original = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url) => {
    seen.push(String(url))
    return {
      ok: true,
      json: async () => ({
        holidays: { '2030-01-01': "New Year's Day,元旦,1" },
        workdays: { '2030-01-05': 'Spring Festival,春节,4' },
      }),
    }
  }
  try {
    const { routes } = boot({
      holidayRefresh: { enabled: true, url: 'https://example.test/{year}.json', years: [2030], onStart: false },
    })

    // 刷新前：2030 无数据，走"未知年份降级"
    const before = await statusAt(routes, '2030-01-01T10:00:00')
    assert.equal(before.daySource, 'fallback')

    const res = await call(routes, '/api/peak-brief.refresh-holidays', { method: 'POST' })
    assert.equal(res.status, 200)
    assert.deepEqual(seen, ['https://example.test/2030.json'], '{year} 必须被替换')
    assert.equal(res.json.results[0].ok, true)
    assert.equal(res.json.results[0].holidays, 1)
    assert.deepEqual(res.json.runtimeYears, [2030])

    // 刷新后：日历立刻用上新数据（windows/gate 不需要重建）
    const after = await statusAt(routes, '2030-01-01T10:00:00')
    assert.equal(after.dayKind, 'holiday')
    assert.equal(after.daySource, 'refresh')
    assert.equal(after.phase, 'off')

    // 调休上班日同样生效
    const makeup = await statusAt(routes, '2030-01-05T10:00:00')
    assert.equal(makeup.dayKind, 'makeup-workday')
    assert.equal(makeup.peakDay, false)

    // 重复刷新不重复请求
    const again = await call(routes, '/api/peak-brief.refresh-holidays', { method: 'POST' })
    assert.equal(again.json.results[0].reason, 'already-loaded')
    assert.equal(seen.length, 1)
  } finally {
    globalThis.fetch = original
  }
})

test('联网刷新：网络炸了/形状不对时**不污染**日历，继续用内置表', async () => {
  const original = globalThis.fetch
  try {
    const cases = [
      async () => { throw new Error('网络炸了') },
      async () => ({ ok: false, json: async () => ({}) }),
      async () => ({ ok: true, json: async () => ({ nope: 1 }) }),
      async () => ({ ok: true, json: async () => ({ holidays: {}, workdays: {} }) }),
    ]
    for (const stub of cases) {
      globalThis.fetch = stub
      const { routes } = boot({
        holidayRefresh: { enabled: true, url: 'https://example.test/{year}.json', years: [2030], onStart: false },
      })
      const res = await call(routes, '/api/peak-brief.refresh-holidays', { method: 'POST' })
      assert.equal(res.status, 200, '刷新失败绝不能让接口 5xx')
      assert.equal(res.json.results[0].ok, false)
      assert.deepEqual(res.json.runtimeYears, [], '绝不能并入半个表')

      // 内置的 2026 数据毫发无伤
      const builtin = await statusAt(routes, '2026-10-01T10:00:00')
      assert.equal(builtin.dayKind, 'holiday')
      assert.equal(builtin.daySource, 'bundled')
    }
  } finally {
    globalThis.fetch = original
  }
})

test('联网刷新：启动时自动跑（onStart 默认开）', async () => {
  const original = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url) => {
    seen.push(String(url))
    return { ok: true, json: async () => ({ holidays: { '2031-01-01': '元旦' }, workdays: {} }) }
  }
  try {
    boot({ holidayRefresh: { enabled: true, url: 'https://example.test/{year}.json', years: [2031] } })
    await new Promise((resolve) => { setTimeout(resolve, 10) })
    assert.deepEqual(seen, ['https://example.test/2031.json'])
  } finally {
    globalThis.fetch = original
  }
})

// ---------------------------------------------------------------- 设置命名空间

/** 假 settings 服务：真的按 "schema 默认 → base → 用户层" 解析，并真的触发 watch。 */
function makeSettings() {
  const registrations = new Map()
  return {
    registrations,
    register(ns, schema, options = {}) {
      assert.equal(registrations.has(ns), false, `命名空间重复注册：${ns}`)
      const base = options.base ?? {}
      let user = {}
      const record = { schema, options, watcher: null, getUser: () => ({ ...user }) }
      const resolve = () => schema({ ...base, ...user })
      const fire = () => { if (record.watcher !== null) record.watcher(resolve()) }
      record.setUser = (next) => { user = { ...next }; fire() }
      record.patchUser = (patch) => { user = { ...user, ...patch }; fire() }
      record.resolve = resolve
      record.scope = {
        get: () => resolve(),
        watch(cb) { record.watcher = cb; return () => { record.watcher = null } },
        update: async (patch) => { record.patchUser(patch) },
        replace: async (section) => { user = { ...section }; fire() },
      }
      registrations.set(ns, record)
      return record.scope
    },
  }
}

test('设置：注册 peak-brief 命名空间，并把 patch 配置作为 base 层', async () => {
  const settings = makeSettings()
  const { routes } = boot({ leadMinutes: 33, timezone: 'UTC' }, { settings })

  const record = settings.registrations.get('peak-brief')
  assert.ok(record, '必须注册 peak-brief 命名空间')
  assert.equal(record.options.applies, 'live', '声明为即时生效')
  assert.deepEqual(record.options.base, { leadMinutes: 33, timezone: 'UTC' }, 'base 必须是 patch 层里的组合配置')

  const status = await statusAt(routes, `${TODAY}T10:00:00`)
  assert.equal(status.settings.registered, true)
  assert.equal(status.settings.namespace, 'peak-brief')
  assert.equal(status.leadMinutes, 33, '解析结果应当用上 base 层')
  assert.equal(status.timezone, 'UTC')
})

test('设置：写入后**即时生效**（无需重启）', async () => {
  const settings = makeSettings()
  const { routes, listeners } = boot({}, { settings })

  const before = await statusAt(routes, `${TODAY}T10:00:00`)
  assert.equal(before.enabled, false)
  assert.equal(before.phase, 'off', 'TODAY 未覆盖成峰谷日时不该处于高峰')

  // 通过设置页打开开关，并把 TODAY 覆盖成全天高峰
  settings.registrations.get('peak-brief').setUser({
    enabled: true,
    gateMode: 'hard',
    overrides: { [TODAY]: 'peak' },
    peakWindows: [['00:00', '24:00']],
  })

  const after = await statusAt(routes, `${TODAY}T10:00:00`)
  assert.equal(after.enabled, true, '设置变更必须立刻反映到生效配置')
  assert.equal(after.phase, 'peak')
  assert.equal(after.enforcement, 'hard-block')
  assert.deepEqual(after.windows, [{ start: '00:00', end: '24:00' }], '时段必须用新值重建')

  // 而且真的开始拦
  const blocked = await runStreamListener(listeners, { provider: 'p', model: 'm', messages: [] })
  assert.equal(blocked.nextCalled, 0)
  assert.equal(blocked.chunks[0].reason.failure.code, GATE_CODE)

  // 再关掉 → 立刻放行
  settings.registrations.get('peak-brief').patchUser({ enabled: false })
  assert.equal((await statusAt(routes, `${TODAY}T10:00:00`)).enabled, false)
  const allowed = await runStreamListener(listeners, { provider: 'p', model: 'm', messages: [] })
  assert.equal(allowed.nextCalled, 1, '关闭之后必须立刻恢复放行')
})

test('设置：清空用户层会回退到 base，而不是硬回内置默认', async () => {
  const settings = makeSettings()
  const { routes } = boot({ leadMinutes: 25, notify: 'off' }, { settings })
  const record = settings.registrations.get('peak-brief')

  record.patchUser({ leadMinutes: 5 })
  assert.equal((await statusAt(routes, `${TODAY}T10:00:00`)).leadMinutes, 5)

  record.setUser({})
  const back = await statusAt(routes, `${TODAY}T10:00:00`)
  assert.equal(back.leadMinutes, 25, '清空后回到 patch 层')
  assert.equal(back.notify, 'off')
})

test('设置：非法写入被 schema 拒绝，生效配置保持不变', async () => {
  const settings = makeSettings()
  const { routes } = boot({}, { settings })
  const record = settings.registrations.get('peak-brief')

  // dsh-settings 的写入路径会调用 schema；这里直接验证它确实抛
  assert.throws(() => record.schema({ leadMinutes: -1 }), /leadMinutes/)
  assert.throws(() => record.schema({ peakWindows: [['10:00', '09:00']] }), /结束时刻/)

  // 生效配置没被污染
  const status = await statusAt(routes, `${TODAY}T10:00:00`)
  assert.equal(status.leadMinutes, 10)
  assert.deepEqual(status.windows, [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }])
})

test('设置：服务不可用时插件照常工作，并如实报告', async () => {
  const { routes } = boot({})
  const status = await statusAt(routes, `${TODAY}T10:00:00`)
  assert.equal(status.settings.registered, false)
  assert.equal(status.settings.reason, 'settings-service-unavailable')
  assert.equal(status.enabled, false, '核心功能不受影响')
})

test('设置：注册失败（例如存了一份非法配置）也不能让插件瘫掉', async () => {
  const settings = { register() { throw new Error('stored section is invalid') } }
  const { routes } = boot({ leadMinutes: 12 }, { settings })

  const status = await statusAt(routes, `${TODAY}T10:00:00`)
  assert.equal(status.settings.registered, false)
  assert.match(status.settings.reason, /register-failed/)
  assert.equal(status.leadMinutes, 12, '退回 patch 配置继续工作')
})

// ---------------------------------------------------------- 斜杠命令

/** 假命令注册表：记录注册进来的 spec，便于直接调用 handler。 */
function makeCommands() {
  const registered = new Map()
  const disposers = []
  return {
    registered,
    disposers,
    register(spec) {
      assert.equal(registered.has(spec.name), false, `命令重复注册：${spec.name}`)
      registered.set(spec.name, spec)
      const dispose = () => registered.delete(spec.name)
      disposers.push(dispose)
      return dispose
    },
  }
}

test('斜杠命令：注册 /peak-allow /peak-status /peak-brief /peak-resume', async () => {
  const commands = makeCommands()
  const { routes } = boot({}, { commands })
  assert.deepEqual(
    [...commands.registered.keys()].sort(),
    ['peak-allow', 'peak-brief', 'peak-resume', 'peak-status'],
  )

  // 状态里如实报告注册结果
  const res = await call(routes, '/api/peak-brief.state')
  assert.equal(res.json.state.status.commands.registered, true)
  assert.deepEqual(
    res.json.state.status.commands.names.slice().sort(),
    ['peak-allow', 'peak-brief', 'peak-resume', 'peak-status'],
  )
})

test('斜杠命令：commands 服务不可用时如实报告，插件照常工作', async () => {
  const { routes } = boot({})
  const res = await call(routes, '/api/peak-brief.state')
  assert.equal(res.json.state.status.commands.registered, false)
  assert.equal(res.json.state.status.commands.reason, 'commands-service-unavailable')
})

test('斜杠命令：/peak-allow 解析分钟数并真的放行', async () => {
  const commands = makeCommands()
  const { routes } = boot(peakNow(), { commands })
  const allow = commands.registered.get('peak-allow')

  const bad = await allow.handler({ rawInput: '十分钟' })
  assert.equal(bad.kind, 'error')
  assert.match(bad.text, /用法/)

  const ok = await allow.handler({ rawInput: '15' })
  assert.equal(ok.kind, 'success')
  assert.match(ok.text, /15 分钟/)

  const state = await call(routes, '/api/peak-brief.state')
  assert.equal(state.json.state.status.gate.allow.active, true)
})

test('斜杠命令：/peak-status 汇总相位与门控', async () => {
  const commands = makeCommands()
  boot({ enabled: true, overrides: { [TODAY]: 'peak' }, peakWindows: [['00:00', '24:00']] }, { commands })
  const status = await commands.registered.get('peak-status').handler({})
  assert.equal(status.kind, 'success')
  assert.match(status.text, /相位 peak/)
  assert.match(status.text, /门控：正在硬拦/)
})

test('斜杠命令：/peak-brief 与 /peak-resume 驱动真实流程', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peak-cmd-'))
  try {
    const commands = makeCommands()
    const { listeners } = boot({ brief: { dir } }, { commands, llm: fakeLlm(textChunks(BRIEF_JSON)) })
    const { agent, spy } = makeSpyAgent('sess-cmd')
    addAgent(listeners, agent)

    const briefResult = await commands.registered.get('peak-brief').handler({ agent })
    assert.equal(briefResult.kind, 'success')
    assert.match(briefResult.text, /完成 dsh-peak-brief 的 P3/)

    const resumeResult = await commands.registered.get('peak-resume').handler({ agent })
    assert.equal(resumeResult.kind, 'success')
    assert.equal(spy.followedUp.length, 1)

    const noAgent = await commands.registered.get('peak-brief').handler({})
    assert.equal(noAgent.kind, 'error')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('集成：被拦时只推一条提示（不刷屏），换一段高峰会重新提醒', async () => {
  // 用两个独立窗口，才能区分"同一段"与"另一段"
  const { routes, listeners } = boot({
    enabled: true,
    gateMode: 'hard',
    overrides: { [TODAY]: 'peak' },
    peakWindows: [['09:00', '12:00'], ['14:00', '18:00']],
  })
  const clock = (hms) => call(routes, '/api/peak-brief.debug-clock', { method: 'POST', body: { at: `${TODAY}T${hms}+08:00` } })

  await clock('09:30:00')
  for (let i = 0; i < 4; i += 1) {
    const run = await runStreamListener(listeners, { provider: 'p', model: 'm', messages: [] })
    assert.equal(run.nextCalled, 0)
  }

  const first = await call(routes, '/api/peak-brief.state')
  const notice = first.json.state.notice
  assert.equal(notice.kind, 'peak', '被拦必须用 peak 级别的提示')
  assert.match(notice.text, /已被拦截/)
  assert.match(notice.text, /peak-allow/, '必须告诉用户怎么放行')
  const seqAfterBurst = notice.seq

  // 同一窗口内再来一次仍然不该多推
  await clock('10:30:00')
  await runStreamListener(listeners, { provider: 'p', model: 'm', messages: [] })
  const second = await call(routes, '/api/peak-brief.state')
  assert.equal(second.json.state.seq, seqAfterBurst, '同一段高峰内不能重复弹提示')

  // 换到另一个高峰窗口应当重新提醒
  await clock('15:00:00')
  await runStreamListener(listeners, { provider: 'p', model: 'm', messages: [] })
  const third = await call(routes, '/api/peak-brief.state')
  assert.ok(third.json.state.seq > seqAfterBurst, '进入另一段高峰应重新提醒')

  await call(routes, '/api/peak-brief.debug-clock', { method: 'POST', body: { clear: true } })
})

test('集成：放行期间不推"被拦"提示', async () => {
  const { routes, listeners } = boot(peakNow())
  await call(routes, '/api/peak-brief.allow', { method: 'POST', body: { minutes: 5 } })
  const before = (await call(routes, '/api/peak-brief.state')).json.state.seq

  const run = await runStreamListener(listeners, { provider: 'p', model: 'm', messages: [] })
  assert.equal(run.nextCalled, 1, '放行期间应当通过')

  const after = (await call(routes, '/api/peak-brief.state')).json.state.seq
  assert.equal(after, before, '没被拦就不该有提示')
})

// ------------------------------------------------- 会话级故障隔离

test('健壮性：单个会话炸掉不会带走整个调度，且仍会停自动续跑', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peak-brief-fault-'))
  try {
    const llm = fakeLlm(textChunks(BRIEF_JSON))
    const goals = makeGoals()
    const { routes, listeners } = boot(
      { enabled: true, overrides: { [TODAY]: 'peak' }, peakWindows: [['09:00', '12:00']], brief: { dir } },
      { llm, goals },
    )

    // 坏会话：模拟"真实 session 契约与预期不符"（正是离线无法验证的那一类）
    const badSpy = { injected: [], followedUp: [] }
    const bad = {
      session: {
        id: 'sess-bad',
        deriveMessages: () => { throw new Error('契约变了') },
        requestHeader: () => null,
      },
      inject: (m) => badSpy.injected.push(m),
      followup: (m) => badSpy.followedUp.push(m),
    }
    const good = makeSpyAgent('sess-good')
    addAgent(listeners, bad)
    addAgent(listeners, good.agent)

    const lead = await tick(routes, `${TODAY}T08:50:00+08:00`)
    const badAction = lead.json.tick.actions.find((a) => a.sessionId === 'sess-bad')
    const goodAction = lead.json.tick.actions.find((a) => a.sessionId === 'sess-good')

    assert.equal(badAction.action, 'brief')
    assert.match(badAction.failure, /契约变了/, '异常必须被如实记录，而不是吞掉')
    assert.equal(badAction.disarm.attempted, true, '简报失败也必须停自动续跑——高峰定价才是要躲的')
    assert.equal(goodAction.action, 'brief')
    assert.equal(goodAction.failure, null, '另一个会话不该受影响')

    // 闲时：坏会话以降级方式恢复（明确说"缺少简报"），而不是静默什么都不做
    const resume = await tick(routes, `${TODAY}T12:00:00+08:00`)
    const badResume = resume.json.tick.actions.find((a) => a.sessionId === 'sess-bad')
    assert.equal(badResume.followedUp, true, '没有简报也要交回一条可用的恢复消息')
    assert.match(badSpy.followedUp[0].content[0].text, /缺少简报/)
    assert.equal(badResume.goalResumed, true)

    const goodResume = resume.json.tick.actions.find((a) => a.sessionId === 'sess-good')
    assert.equal(goodResume.followedUp, true, '好会话必须正常恢复')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------- 标准 1：空转保护

test('P4：没有活跃任务时，定时器零动作、不花一分钱', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'peak-brief-idle-'))
  try {
    const llm = fakeLlm(textChunks(BRIEF_JSON))
    const { routes } = boot(
      { enabled: true, overrides: { [TODAY]: 'peak' }, peakWindows: [['09:00', '12:00']], brief: { dir } },
      { llm, goals: makeGoals() },
    )

    const lead = await tick(routes, `${TODAY}T08:50:00+08:00`)
    assert.equal(lead.json.tick.liveSessions, 0)
    assert.deepEqual(lead.json.tick.actions, [], '没有会话就不该有任何动作')
    assert.equal(llm.calls.length, 0, '没有活就不该调用模型')
    assert.equal(existsSync(briefPathFor(dir, 'anything')), false)

    const off = await tick(routes, `${TODAY}T12:00:00+08:00`)
    assert.deepEqual(off.json.tick.actions, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
