import test from 'node:test'
import assert from 'node:assert/strict'

import { createCalendar } from '../lib/calendar.js'
import {
  PHASE,
  createWindows,
  formatClock,
  normalizePeakWindows,
  parseClock,
} from '../lib/windows.js'
import { addDays, weekdayOf } from '../lib/tz.js'

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

/** 用显式 +08:00 构造瞬间，避免测试依赖被测的时区换算。 */
const bj = (text) => Date.parse(`${text}+08:00`)

test('parseClock / formatClock', () => {
  assert.equal(parseClock('09:00'), 540)
  assert.equal(parseClock('9:05'), 545)
  assert.equal(parseClock('00:00'), 0)
  assert.equal(parseClock('24:00'), 1440)
  assert.equal(formatClock(540), '09:00')
  assert.equal(formatClock(0), '00:00')
  assert.equal(formatClock(1440), '24:00')

  assert.throws(() => parseClock('25:00'), TypeError)
  assert.throws(() => parseClock('09:60'), TypeError)
  assert.throws(() => parseClock('24:30'), TypeError)
  assert.throws(() => parseClock('abc'), TypeError)
  assert.throws(() => parseClock(900), TypeError)
})

test('normalizePeakWindows：排序、对象形态、拒绝重叠与倒置', () => {
  const sorted = normalizePeakWindows([['14:00', '18:00'], ['09:00', '12:00']])
  assert.deepEqual(sorted, [{ start: 540, end: 720 }, { start: 840, end: 1080 }])

  assert.deepEqual(
    normalizePeakWindows([{ start: '09:00', end: '12:00' }]),
    [{ start: 540, end: 720 }],
  )

  assert.deepEqual(normalizePeakWindows([]), [])
  assert.deepEqual(normalizePeakWindows(undefined), [])

  assert.throws(() => normalizePeakWindows([['09:00', '12:00'], ['11:00', '13:00']]), /重叠/)
  assert.throws(() => normalizePeakWindows([['12:00', '09:00']]), /结束时刻必须晚于开始时刻/)
  assert.throws(() => normalizePeakWindows([['09:00', '09:00']]), /结束时刻必须晚于开始时刻/)
  assert.throws(() => normalizePeakWindows('09:00-12:00'), TypeError)
  assert.throws(() => normalizePeakWindows([['09:00']]), TypeError)
})

test('配置校验：非法时区与负提前量大声失败', () => {
  assert.throws(() => makeWindows({ timezone: 'Mars/Olympus' }), /非法 IANA 时区/)
  assert.throws(() => makeWindows({ leadMinutes: -1 }), /leadMinutes/)
  assert.throws(() => makeWindows({ leadMinutes: 1.5 }), /leadMinutes/)
  assert.throws(() => createWindows({ calendar: null }), /需要 calendar/)
})

test('普通工作日：相位序列正确（提前量 10 分钟）', () => {
  const w = makeWindows()
  const date = '2026-09-17' // 周四
  assert.equal(weekdayOf(date), 4)

  assert.equal(w.phaseAt(bj(`${date}T00:00`)), PHASE.OFF)
  assert.equal(w.phaseAt(bj(`${date}T08:00`)), PHASE.OFF)
  assert.equal(w.phaseAt(bj(`${date}T08:49`)), PHASE.OFF)
  assert.equal(w.phaseAt(bj(`${date}T08:50`)), PHASE.LEAD, '提前量起点')
  assert.equal(w.phaseAt(bj(`${date}T08:59`)), PHASE.LEAD)
  assert.equal(w.phaseAt(bj(`${date}T09:00`)), PHASE.PEAK)
  assert.equal(w.phaseAt(bj(`${date}T11:59`)), PHASE.PEAK)
  assert.equal(w.phaseAt(bj(`${date}T12:00`)), PHASE.OFF)
  assert.equal(w.phaseAt(bj(`${date}T13:49`)), PHASE.OFF)
  assert.equal(w.phaseAt(bj(`${date}T13:50`)), PHASE.LEAD)
  assert.equal(w.phaseAt(bj(`${date}T14:00`)), PHASE.PEAK)
  assert.equal(w.phaseAt(bj(`${date}T17:59`)), PHASE.PEAK)
  assert.equal(w.phaseAt(bj(`${date}T18:00`)), PHASE.OFF)
  assert.equal(w.phaseAt(bj(`${date}T23:59`)), PHASE.OFF)
})

test('必须按配置时区判定，而不是进程本地时区', () => {
  const w = makeWindows()
  // 同一瞬间：UTC 01:00 == 北京 09:00
  const ms = Date.parse('2026-09-17T01:00:00Z')
  assert.equal(w.phaseAt(ms), PHASE.PEAK)
  assert.equal(w.describe(ms).localTime, '09:00')
  assert.equal(w.describe(ms).timezone, 'Asia/Shanghai')
})

test('nextSwitchAt：一天之内的四次切换', () => {
  const w = makeWindows()
  const date = '2026-09-17'

  assert.deepEqual(
    { at: new Date(w.nextSwitchAt(bj(`${date}T08:00`)).at).toISOString(), to: w.nextSwitchAt(bj(`${date}T08:00`)).to },
    { at: new Date(bj(`${date}T08:50`)).toISOString(), to: PHASE.LEAD },
  )
  assert.equal(w.nextSwitchAt(bj(`${date}T08:50`)).to, PHASE.PEAK)
  assert.equal(new Date(w.nextSwitchAt(bj(`${date}T08:50`)).at).toISOString(), new Date(bj(`${date}T09:00`)).toISOString())

  assert.equal(new Date(w.nextSwitchAt(bj(`${date}T09:30`)).at).toISOString(), new Date(bj(`${date}T12:00`)).toISOString())
  assert.equal(w.nextSwitchAt(bj(`${date}T09:30`)).to, PHASE.OFF)

  assert.equal(new Date(w.nextSwitchAt(bj(`${date}T12:00`)).at).toISOString(), new Date(bj(`${date}T13:50`)).toISOString())
  assert.equal(w.nextSwitchAt(bj(`${date}T12:00`)).to, PHASE.LEAD)

  // 最后一个时段结束后，跳到下一个峰谷日的提前量起点
  const afterPeak = w.nextSwitchAt(bj(`${date}T18:00`))
  assert.equal(new Date(afterPeak.at).toISOString(), new Date(bj('2026-09-18T08:50')).toISOString())
  assert.equal(afterPeak.to, PHASE.LEAD)
  assert.equal(afterPeak.date, '2026-09-18')
})

test('跨周末：周五收盘后下一次是周一（跳过普通周末与调休上班日）', () => {
  const w = makeWindows()
  // 2026-09-18 周五 18:30；09-19 周六、09-20 周日（调休上班日）都不是峰谷日
  assert.equal(weekdayOf('2026-09-18'), 5)
  assert.equal(cal.isPeakDay('2026-09-19'), false)
  assert.equal(cal.isPeakDay('2026-09-20'), false)
  assert.equal(weekdayOf('2026-09-21'), 1)
  assert.equal(cal.isPeakDay('2026-09-21'), true)

  const next = w.nextSwitchAt(bj('2026-09-18T18:30'))
  assert.equal(next.date, '2026-09-21')
  assert.equal(new Date(next.at).toISOString(), new Date(bj('2026-09-21T08:50')).toISOString())
  assert.equal(next.to, PHASE.LEAD)
})

test('调休上班日：全天 off（不会因为是"工作日"就进高峰）', () => {
  const w = makeWindows()
  const makeups = ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10']
  for (const date of makeups) {
    for (const time of ['00:00', '08:50', '09:00', '10:00', '14:30', '18:00', '23:59']) {
      assert.equal(w.phaseAt(bj(`${date}T${time}`)), PHASE.OFF, `${date} ${time} 应全天闲时`)
    }
    assert.deepEqual(w.marksForDate(date), [])
  }
  // 调休日之后的下一次切换落在下一个真正的峰谷日
  assert.equal(w.nextSwitchAt(bj('2026-09-20T10:00')).date, '2026-09-21')
})

test('法定节假日：整段长假全天 off，节后自动恢复', () => {
  const w = makeWindows()
  for (let i = 0; i < 7; i += 1) {
    const date = addDays('2026-10-01', i)
    assert.equal(w.phaseAt(bj(`${date}T09:30`)), PHASE.OFF, `${date} 应在国庆假期内`)
  }
  // 2026-10-08 是节后第一个工作日（周四）
  assert.equal(cal.isPeakDay('2026-10-08'), true)
  const next = w.nextSwitchAt(bj('2026-10-01T10:00'))
  assert.equal(next.date, '2026-10-08')
  assert.equal(new Date(next.at).toISOString(), new Date(bj('2026-10-08T08:50')).toISOString())
})

test('leadMinutes=0：没有预备相位，直接进高峰', () => {
  const w = makeWindows({ leadMinutes: 0 })
  assert.equal(w.phaseAt(bj('2026-09-17T08:59')), PHASE.OFF)
  assert.equal(w.phaseAt(bj('2026-09-17T09:00')), PHASE.PEAK)
  assert.deepEqual(w.marksForDate('2026-09-17').map((m) => m.to), [PHASE.PEAK, PHASE.OFF, PHASE.PEAK, PHASE.OFF])
})

test('提前量过大时被夹住，不会侵入上一个时段', () => {
  const w = makeWindows({ leadMinutes: 180 })
  // 第二个时段的提前量本会落在 11:00（还在第一个高峰里），必须被夹到 12:00
  assert.equal(w.phaseAt(bj('2026-09-17T11:00')), PHASE.PEAK, '不得在第一个高峰中途变成 lead')
  assert.equal(w.phaseAt(bj('2026-09-17T11:59')), PHASE.PEAK)
  assert.equal(w.phaseAt(bj('2026-09-17T12:00')), PHASE.LEAD)
  assert.equal(w.phaseAt(bj('2026-09-17T13:00')), PHASE.LEAD)
  assert.equal(w.phaseAt(bj('2026-09-17T14:00')), PHASE.PEAK)
})

test('手动覆盖能把周末变成峰谷日', () => {
  const sat = createCalendar({ overrides: { '2026-09-19': 'peak' } })
  const w = createWindows({
    calendar: sat,
    peakWindows: [['09:00', '12:00']],
    timezone: 'Asia/Shanghai',
    leadMinutes: 10,
  })
  assert.equal(w.phaseAt(bj('2026-09-19T08:50')), PHASE.LEAD)
  assert.equal(w.phaseAt(bj('2026-09-19T10:00')), PHASE.PEAK)
  assert.equal(w.phaseAt(bj('2026-09-19T12:00')), PHASE.OFF)
})

test('未知年份不崩，按周一至周五走', () => {
  const w = makeWindows()
  // 2027-03-10 是周三
  assert.equal(weekdayOf('2027-03-10'), 3)
  assert.equal(w.phaseAt(bj('2027-03-10T10:00')), PHASE.PEAK)
  // 2027-03-13 是周六
  assert.equal(weekdayOf('2027-03-13'), 6)
  assert.equal(w.phaseAt(bj('2027-03-13T10:00')), PHASE.OFF)
})

test('空时段配置 = 永不进入高峰', () => {
  const w = makeWindows({ peakWindows: [] })
  assert.equal(w.phaseAt(bj('2026-09-17T10:00')), PHASE.OFF)
  assert.deepEqual(w.marksForDate('2026-09-17'), [])
  assert.equal(w.nextSwitchAt(bj('2026-09-17T10:00')), null)
})

test('describe 给出状态命令需要的全部字段', () => {
  const w = makeWindows()
  const d = w.describe(bj('2026-09-17T09:30'))
  assert.equal(d.phase, PHASE.PEAK)
  assert.equal(d.localDate, '2026-09-17')
  assert.equal(d.localTime, '09:30')
  assert.equal(d.peakDay, true)
  assert.equal(d.leadMinutes, 10)
  assert.deepEqual(d.windows, [
    { start: '09:00', end: '12:00' },
    { start: '14:00', end: '18:00' },
  ])
  assert.equal(d.nextSwitch.to, PHASE.OFF)
  assert.equal(d.phaseEndsAt, new Date(bj('2026-09-17T12:00')).toISOString())
})
