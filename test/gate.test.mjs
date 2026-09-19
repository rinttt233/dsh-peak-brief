import test from 'node:test'
import assert from 'node:assert/strict'

import { createCalendar } from '../lib/calendar.js'
import { createWindows, PHASE } from '../lib/windows.js'
import { GATE_CODE, DEFAULT_ALLOW_MINUTES, createGate } from '../lib/gate.js'

const cal = createCalendar({})

function makeWindows(overrides = {}) {
  return createWindows({
    calendar: cal,
    peakWindows: [['09:00', '12:00'], ['14:00', '18:00']],
    timezone: 'Asia/Shanghai',
    leadMinutes: 10,
    ...overrides,
  })
}

const PEAK = Date.parse('2026-09-17T10:00:00+08:00')   // 高峰中（周四）
const LEAD = Date.parse('2026-09-17T08:55:00+08:00')   // 预备相位
const OFF = Date.parse('2026-09-17T13:00:00+08:00')    // 午间闲时
const HOLIDAY = Date.parse('2026-10-01T10:00:00+08:00') // 法定节假日

function makeGate(config = {}, windows = makeWindows()) {
  return createGate({
    windows,
    config: { enabled: true, gateMode: 'hard', blockAuxiliary: true, ...config },
  })
}

test('createGate 需要 windows', () => {
  assert.throws(() => createGate({ config: {} }), /需要 windows/)
})

test('默认关闭时一律放行', () => {
  const gate = makeGate({ enabled: false })
  for (const at of [PEAK, LEAD, OFF, HOLIDAY]) {
    const d = gate.decide(at, {})
    assert.equal(d.block, false)
    assert.equal(d.reason, 'disabled')
  }
})

test('gateMode 不是 hard 时不拦', () => {
  const gate = makeGate({ gateMode: 'off' })
  assert.equal(gate.decide(PEAK, {}).block, false)
  assert.equal(gate.decide(PEAK, {}).reason, 'gate-not-hard')
})

test('只在 peak 相位拦截；lead / off / 节假日都不拦', () => {
  const gate = makeGate()

  const peak = gate.decide(PEAK, {})
  assert.equal(peak.block, true)
  assert.equal(peak.code, GATE_CODE)
  assert.equal(peak.reason, 'peak')

  assert.equal(gate.decide(LEAD, {}).block, false)
  assert.equal(gate.decide(LEAD, {}).reason, 'phase-lead')
  assert.equal(gate.decide(OFF, {}).block, false)
  assert.equal(gate.decide(OFF, {}).reason, 'phase-off')
  assert.equal(gate.decide(HOLIDAY, {}).reason, 'phase-off')
})

test('拦截文案说清原因与放行方式', () => {
  const gate = makeGate()
  const message = gate.decide(PEAK, {}).message
  assert.match(message, /已拦截本次模型请求/)
  assert.match(message, /高峰计价时段/)
  assert.match(message, /不产生费用/)
  assert.match(message, /\/peak-allow 30/)
})

test('拦截 chunk 的形状符合 StreamChunk 协议', () => {
  const gate = makeGate()
  const chunks = gate.blockedChunks(gate.decide(PEAK, {}))
  assert.equal(chunks.length, 1, '只发一个终止 chunk')
  assert.equal(chunks[0].type, 'finish')
  assert.equal(chunks[0].reason.kind, 'error')
  assert.equal(chunks[0].reason.failure.code, GATE_CODE)
  assert.equal(typeof chunks[0].reason.failure.message, 'string')
})

test('blockedStream 是异步可迭代的，且只产出那一个 chunk', async () => {
  const gate = makeGate()
  const out = []
  for await (const chunk of gate.blockedStream(gate.decide(PEAK, {}))) out.push(chunk)
  assert.equal(out.length, 1)
  assert.equal(out[0].type, 'finish')
})

test('自己人标记：标记过的请求不被自己拦', () => {
  const gate = makeGate()
  const options = { provider: 'p', model: 'm', messages: [] }
  assert.equal(gate.decide(PEAK, options).block, true, '未标记时会被拦')

  const marked = gate.markOwn({ provider: 'p', model: 'm', messages: [] })
  assert.equal(gate.decide(PEAK, marked).block, false)
  assert.equal(gate.decide(PEAK, marked).reason, 'own-call')

  // 冻结不影响身份判定（GenerateOptions 在派发前会被深冻结）
  const frozen = Object.freeze({ provider: 'p', model: 'm', messages: [] })
  gate.markOwn(frozen)
  assert.equal(gate.decide(PEAK, frozen).block, false)
})

test('blockAuxiliary：默认真拦辅助请求，关掉后放行', () => {
  const strict = makeGate()
  assert.equal(strict.decide(PEAK, { purpose: 'session-title' }).block, true)
  assert.equal(strict.decide(PEAK, { purpose: 'compaction' }).block, true)

  const lenient = makeGate({ blockAuxiliary: false })
  assert.equal(lenient.decide(PEAK, { purpose: 'session-title' }).block, false)
  assert.equal(lenient.decide(PEAK, { purpose: 'session-title' }).reason, 'auxiliary-session-title')
  // 普通对话请求仍然拦
  assert.equal(lenient.decide(PEAK, {}).block, true)
})

test('逃生窗口：放行 → 到期自动恢复拦截', () => {
  const gate = makeGate()

  assert.equal(gate.decide(PEAK, {}).block, true)

  const allow = gate.allowFor(30, PEAK, 'test')
  assert.equal(allow.active, true)
  assert.equal(gate.decide(PEAK, {}).block, false)
  assert.equal(gate.decide(PEAK, {}).reason, 'allow-once')

  // 30 分钟后到期（仍在本段高峰内）
  const later = PEAK + 30 * 60000 + 1
  assert.equal(gate.allowStatus(later).active, false, '到期后应自动失效')
  assert.equal(gate.decide(later, {}).block, true)
})

test('逃生窗口不会越过本段高峰的结束时刻', () => {
  const gate = makeGate()
  // 高峰 14:00-18:00，14:10 申请 10 小时放行，只应到 18:00
  const at = Date.parse('2026-09-17T14:10:00+08:00')
  const allow = gate.allowFor(600, at)
  assert.equal(new Date(allow.until).toISOString(), new Date(Date.parse('2026-09-17T18:00:00+08:00')).toISOString())
})

test('非高峰时申请放行：按请求时长，不夹取', () => {
  const gate = makeGate()
  const allow = gate.allowFor(20, OFF)
  assert.equal(new Date(allow.until).toISOString(), new Date(OFF + 20 * 60000).toISOString())
})

test('非法 minutes 退回默认时长', () => {
  const gate = makeGate()
  for (const bad of [0, -5, Number.NaN, 'abc', undefined]) {
    gate.clearAllow()
    const allow = gate.allowFor(bad, OFF)
    assert.equal(
      new Date(allow.until).toISOString(),
      new Date(OFF + DEFAULT_ALLOW_MINUTES * 60000).toISOString(),
      `minutes=${String(bad)} 应退回默认 ${DEFAULT_ALLOW_MINUTES}`,
    )
  }
})

test('clearAllow 立即恢复拦截', () => {
  const gate = makeGate()
  gate.allowFor(60, PEAK)
  assert.equal(gate.decide(PEAK, {}).block, false)
  gate.clearAllow()
  assert.equal(gate.decide(PEAK, {}).block, true)
  assert.equal(gate.allowStatus(PEAK).active, false)
})

test('snapshot 给出状态命令需要的字段，并统计拦截次数', () => {
  const gate = makeGate()
  const before = gate.snapshot(PEAK)
  assert.equal(before.enabled, true)
  assert.equal(before.gateMode, 'hard')
  assert.equal(before.blocking, true)
  assert.equal(before.code, GATE_CODE)
  assert.equal(before.blockedCount, 0)
  assert.equal(before.lastBlockedAt, null)

  gate.decide(PEAK, {})
  gate.decide(PEAK, {})

  const after = gate.snapshot(PEAK)
  assert.equal(after.blockedCount, 2)
  assert.equal(after.lastBlockedAt, new Date(PEAK).toISOString())

  // 放行期间不再计入拦截
  gate.allowFor(5, PEAK)
  gate.decide(PEAK, {})
  assert.equal(gate.snapshot(PEAK).blockedCount, 2)

  // 闲时 blocking=false
  assert.equal(gate.snapshot(OFF).blocking, false)
})

test('调休上班日不会被拦（P1 规则在门控层同样成立）', () => {
  const gate = makeGate()
  const makeup = Date.parse('2026-09-20T10:00:00+08:00') // 周日，调休上班日
  assert.equal(makeWindows().phaseAt(makeup), PHASE.OFF)
  assert.equal(gate.decide(makeup, {}).block, false)
})
