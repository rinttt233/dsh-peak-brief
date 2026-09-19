import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DAY_KIND,
  createCalendar,
  fetchHolidayYear,
  normalizeHolidayTable,
} from '../lib/calendar.js'
import { BUNDLED_YEARS } from '../lib/holidays.js'
import { addDays, isMonToFri, isValidDate, weekdayOf, zonedParts, instantOf } from '../lib/tz.js'

const cal = createCalendar({})

test('内置表覆盖 2025 与 2026', () => {
  assert.deepEqual(BUNDLED_YEARS, [2025, 2026])
  assert.deepEqual(cal.bundledYears, [2025, 2026])
})

test('普通工作日：按峰谷计算', () => {
  // 2026-09-17 是周四
  assert.equal(weekdayOf('2026-09-17'), 4)
  assert.equal(cal.dayKind('2026-09-17'), DAY_KIND.WEEKDAY)
  assert.equal(cal.isPeakDay('2026-09-17'), true)
  assert.equal(cal.sourceOf('2026-09-17'), 'bundled')
})

test('法定节假日：全天闲时', () => {
  // 2026-10-01 是周四，但属于国庆假期
  assert.equal(weekdayOf('2026-10-01'), 4)
  assert.equal(cal.dayKind('2026-10-01'), DAY_KIND.HOLIDAY)
  assert.equal(cal.isPeakDay('2026-10-01'), false)
  assert.equal(cal.describe('2026-10-01').label, '国庆节')
})

test('调休上班日：即使是工作日也全天闲时（本插件的核心规则）', () => {
  // 2026 年全部 6 个调休上班日，逐个断言：它们都是周末，且都不算高峰
  const makeupWorkdays = ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10']
  for (const date of makeupWorkdays) {
    assert.equal(cal.dayKind(date), DAY_KIND.MAKEUP_WORKDAY, `${date} 应为调休上班日`)
    assert.equal(cal.isPeakDay(date), false, `${date} 必须全天闲时`)
    assert.equal(isMonToFri(date), false, `${date} 应当落在周末`)
  }
})

test('调休上班日的 describe 带出节日名', () => {
  assert.equal(cal.describe('2026-09-20').label, '国庆节')
  assert.equal(cal.describe('2026-02-14').label, '春节')
})

test('普通周末：全天闲时', () => {
  // 2026-09-19 是周六，且不是调休上班日
  assert.equal(weekdayOf('2026-09-19'), 6)
  assert.equal(cal.dayKind('2026-09-19'), DAY_KIND.WEEKEND)
  assert.equal(cal.isPeakDay('2026-09-19'), false)
})

test('春节整段假期都是闲时', () => {
  for (let i = 0; i < 9; i += 1) {
    const date = addDays('2026-02-15', i)
    assert.equal(cal.isPeakDay(date), false, `${date} 应在春节假期内`)
  }
  assert.equal(cal.isPeakDay('2026-02-24'), true, '春节后第一个工作日应恢复高峰')
})

test('2025 年数据同样生效', () => {
  assert.equal(cal.isPeakDay('2025-10-01'), false)
  assert.equal(cal.describe('2025-10-01').label, '国庆节')
  assert.equal(cal.isPeakDay('2025-10-09'), true) // 节后第一个工作日（周四）
})

test('未知年份降级：只按周一至周五判断，不崩', () => {
  // 2027 无内置数据
  assert.equal(cal.dayKind('2027-01-04'), DAY_KIND.UNKNOWN_YEAR)
  assert.equal(cal.sourceOf('2027-01-04'), 'fallback')
  assert.equal(cal.isPeakDay('2027-01-04'), true, '周一应降级为高峰日')
  assert.equal(cal.isPeakDay('2027-01-02'), false, '周六应降级为闲时')
  assert.equal(cal.describe('2027-01-04').label, '未知年份（降级为周一至周五）')
})

test('手动覆盖：off 让工作日变闲时，peak 让周末按峰谷', () => {
  const overridden = createCalendar({
    overrides: {
      '2026-09-17': 'off',
      '2026-09-19': 'peak',
      '2026-10-01': 'workday',
    },
  })
  assert.equal(overridden.isPeakDay('2026-09-17'), false)
  assert.equal(overridden.sourceOf('2026-09-17'), 'override')

  assert.equal(overridden.isPeakDay('2026-09-19'), true)
  assert.equal(overridden.dayKind('2026-09-19'), DAY_KIND.WEEKDAY)

  // 覆盖优先于内置节假日表
  assert.equal(overridden.isPeakDay('2026-10-01'), true)

  // 同义写法
  assert.equal(createCalendar({ overrides: { '2026-09-17': 'HOLIDAY' } }).isPeakDay('2026-09-17'), false)
  assert.equal(createCalendar({ overrides: { '2026-09-17': ' rest ' } }).isPeakDay('2026-09-17'), false)
})

test('非法覆盖项被记录而不是静默忽略', () => {
  const c = createCalendar({
    overrides: { '2026-13-40': 'off', '2026-09-17': '随便写的', '2026-09-18': 'off' },
  })
  assert.equal(c.invalidOverrides.length, 2)
  assert.equal(c.isPeakDay('2026-09-18'), false)
})

test('运行期刷新表优先于内置表', () => {
  const runtime = {
    2027: { holidays: { '2027-01-04': '测试节' }, workdays: {} },
  }
  const c = createCalendar({ runtime })
  assert.deepEqual(c.runtimeYears, [2027])
  assert.equal(c.dayKind('2027-01-04'), DAY_KIND.HOLIDAY)
  assert.equal(c.isPeakDay('2027-01-04'), false)
  assert.equal(c.describe('2027-01-04').label, '测试节')
  assert.equal(c.sourceOf('2027-01-04'), 'refresh')
  // 未覆盖的年份仍走内置表
  assert.equal(c.isPeakDay('2026-09-17'), true)
})

test('非法日期抛错，而不是猜一个', () => {
  assert.equal(isValidDate('2026-02-30'), false)
  assert.equal(isValidDate('2026-2-3'), false)
  assert.equal(isValidDate('20260917'), false)
  assert.throws(() => cal.isPeakDay('2026-02-30'), TypeError)
  assert.throws(() => cal.isPeakDay('today'), TypeError)
})

test('normalizeHolidayTable 接受 chinese-days 形状，拒绝脏数据', () => {
  const ok = normalizeHolidayTable({
    holidays: { '2027-01-01': "New Year's Day,元旦,1" },
    workdays: { '2027-01-09': 'Spring Festival,春节,4' },
  })
  assert.deepEqual(ok, { holidays: { '2027-01-01': '元旦' }, workdays: { '2027-01-09': '春节' } })

  assert.equal(normalizeHolidayTable(null), null)
  assert.equal(normalizeHolidayTable({}), null)
  assert.equal(normalizeHolidayTable({ holidays: {}, workdays: [] }), null)
  assert.equal(normalizeHolidayTable({ holidays: { 'not-a-date': 'x' }, workdays: {} }), null)
  // 空表必须被拒：否则一次空响应的联网刷新会静默遮蔽内置表
  assert.equal(normalizeHolidayTable({ holidays: {}, workdays: {} }), null)
  assert.equal(normalizeHolidayTable([]), null)
  assert.equal(normalizeHolidayTable({ holidays: [], workdays: {} }), null)
})

test('fetchHolidayYear 永不抛异常，失败一律返回 null', async () => {
  const goodJson = { holidays: { '2028-01-01': '元旦' }, workdays: {} }
  const okFetch = async () => ({ ok: true, json: async () => goodJson })
  assert.deepEqual(await fetchHolidayYear('https://example.test/2028.json', { fetchImpl: okFetch }), goodJson)

  const notOk = async () => ({ ok: false, json: async () => goodJson })
  assert.equal(await fetchHolidayYear('https://example.test/2028.json', { fetchImpl: notOk }), null)

  const throwing = async () => { throw new Error('network down') }
  assert.equal(await fetchHolidayYear('https://example.test/2028.json', { fetchImpl: throwing }), null)

  const garbage = async () => ({ ok: true, json: async () => ({ nope: 1 }) })
  assert.equal(await fetchHolidayYear('https://example.test/2028.json', { fetchImpl: garbage }), null)

  assert.equal(await fetchHolidayYear('', { fetchImpl: okFetch }), null)
  assert.equal(await fetchHolidayYear('https://example.test/2028.json', { fetchImpl: undefined, timeoutMs: 1 }), null)
})

test('时区工具：北京 09:00 等于 UTC 01:00', () => {
  const ms = Date.parse('2026-09-17T09:00:00+08:00')
  const p = zonedParts(ms, 'Asia/Shanghai')
  assert.equal(p.date, '2026-09-17')
  assert.equal(p.minutes, 9 * 60)

  const back = instantOf('2026-09-17', 9 * 60, 'Asia/Shanghai')
  assert.equal(back, ms)

  // 午夜必须是 00:00 而不是 24:00
  const midnight = zonedParts(instantOf('2026-09-17', 0, 'Asia/Shanghai'), 'Asia/Shanghai')
  assert.equal(midnight.minutes, 0)
})
