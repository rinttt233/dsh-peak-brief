/**
 * 峰谷时段状态机 —— 把「日历 + 时段配置 + 提前量」压成一个时间函数。
 *
 * 三个相位：
 *
 *   off   闲时：一切正常
 *   lead  预备：距高峰起点还有 <= leadMinutes，该生成简报并停掉自动续跑了
 *   peak  高峰：硬拦模型请求
 *
 * 本模块是纯函数：给一个 UTC 毫秒，回答「现在是什么相位、下一次切换在何时」。
 * 它不认识 DSH，也不认识 cordis，因此可以完全离线单测。
 */

import { addDays, instantOf, isValidTimeZone, zonedParts } from './tz.js'

export const PHASE = { OFF: 'off', LEAD: 'lead', PEAK: 'peak' }

/** 同分钟冲突时的优先级：越靠后越"新"，排在后面覆盖前面。 */
const PHASE_RANK = { [PHASE.OFF]: 0, [PHASE.LEAD]: 1, [PHASE.PEAK]: 2 }

const CLOCK_RE = /^(\d{1,2}):(\d{2})$/

/** 'HH:MM' → 当日分钟数。允许 '24:00' 表示一日之末（1440）。 */
export function parseClock(text) {
  if (typeof text !== 'string') throw new TypeError(`peakWindows: 时刻必须是字符串，收到 ${JSON.stringify(text)}`)
  const match = CLOCK_RE.exec(text.trim())
  if (match === null) throw new TypeError(`peakWindows: 无法解析时刻 ${JSON.stringify(text)}（需要 HH:MM）`)
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (minute > 59) throw new TypeError(`peakWindows: 分钟越界 ${JSON.stringify(text)}`)
  if (hour > 24 || (hour === 24 && minute !== 0)) {
    throw new TypeError(`peakWindows: 小时越界 ${JSON.stringify(text)}（24:00 是上限）`)
  }
  return hour * 60 + minute
}

/** 当日分钟数 → 'HH:MM'。 */
export function formatClock(minutes) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/**
 * 规范化并严格校验时段配置。**配置错误在这里大声失败**，而不是在半夜静默跑错。
 * 接受 `[['09:00','12:00']]` 或 `[{ start:'09:00', end:'12:00' }]`。
 */
export function normalizePeakWindows(list) {
  if (list === undefined || list === null) return []
  if (!Array.isArray(list)) throw new TypeError('peakWindows: 必须是数组')

  const normalized = list.map((entry, index) => {
    let startText
    let endText
    if (Array.isArray(entry)) {
      ;[startText, endText] = entry
    } else if (entry !== null && typeof entry === 'object') {
      startText = entry.start
      endText = entry.end
    } else {
      throw new TypeError(`peakWindows[${index}]: 需要 ['HH:MM','HH:MM'] 或 { start, end }`)
    }
    const start = parseClock(startText)
    const end = parseClock(endText)
    if (end <= start) {
      throw new TypeError(`peakWindows[${index}]: 结束时刻必须晚于开始时刻（${startText} → ${endText}）`)
    }
    return { start, end }
  })

  normalized.sort((a, b) => a.start - b.start)
  for (let i = 1; i < normalized.length; i += 1) {
    if (normalized[i].start < normalized[i - 1].end) {
      throw new TypeError(
        `peakWindows: 时段重叠 ${formatClock(normalized[i - 1].start)}-${formatClock(normalized[i - 1].end)} 与 `
        + `${formatClock(normalized[i].start)}-${formatClock(normalized[i].end)}`,
      )
    }
  }
  return normalized
}

/**
 * @param calendar    - createCalendar() 的产物
 * @param peakWindows - 时段配置
 * @param timezone    - IANA 时区
 * @param leadMinutes - 提前量（默认 10）
 * @param searchDays  - 向后搜索下一次峰谷日的上限
 */
export function createWindows({
  calendar,
  peakWindows,
  timezone = 'Asia/Shanghai',
  leadMinutes = 10,
  searchDays = 21,
} = {}) {
  if (calendar === undefined || calendar === null) throw new TypeError('windows: 需要 calendar')
  if (!isValidTimeZone(timezone)) throw new TypeError(`windows: 非法 IANA 时区 ${JSON.stringify(timezone)}`)
  if (!Number.isSafeInteger(leadMinutes) || leadMinutes < 0) {
    throw new TypeError(`windows: leadMinutes 必须是非负整数，收到 ${JSON.stringify(leadMinutes)}`)
  }

  const windows = normalizePeakWindows(peakWindows)

  /**
   * 某一天的相位边界。非峰谷日返回 []（即全天 off）。
   *
   * 提前量会被**夹住**，不允许侵入上一个时段：否则 leadMinutes 配得过大时，
   * 会出现 peak → lead → off → peak 这种自相矛盾的序列。
   */
  function marksForDate(dateStr) {
    if (!calendar.isPeakDay(dateStr)) return []

    const marks = []
    let floor = 0
    for (const window of windows) {
      const leadAt = Math.max(floor, window.start - leadMinutes, 0)
      if (leadAt < window.start) marks.push({ at: leadAt, to: PHASE.LEAD })
      marks.push({ at: window.start, to: PHASE.PEAK })
      marks.push({ at: window.end, to: PHASE.OFF })
      floor = window.end
    }

    marks.sort((a, b) => (a.at - b.at) || (PHASE_RANK[a.to] - PHASE_RANK[b.to]))
    return marks
  }

  /** 当前相位。 */
  function phaseAt(instantMs) {
    const parts = zonedParts(instantMs, timezone)
    let phase = PHASE.OFF
    for (const mark of marksForDate(parts.date)) {
      if (parts.minutes >= mark.at) phase = mark.to
      else break
    }
    return phase
  }

  /** 下一次相位切换；找不到（理论上不会）返回 null。 */
  function nextSwitchAt(instantMs) {
    const parts = zonedParts(instantMs, timezone)

    for (const mark of marksForDate(parts.date)) {
      if (mark.at > parts.minutes) {
        return { at: instantOf(parts.date, mark.at, timezone), to: mark.to, date: parts.date }
      }
    }

    let date = addDays(parts.date, 1)
    for (let i = 0; i < searchDays; i += 1) {
      const marks = marksForDate(date)
      if (marks.length > 0) {
        return { at: instantOf(date, marks[0].at, timezone), to: marks[0].to, date }
      }
      date = addDays(date, 1)
    }
    return null
  }

  /** 汇总视图，供状态命令与日志使用。 */
  function describe(instantMs) {
    const parts = zonedParts(instantMs, timezone)
    const phase = phaseAt(instantMs)
    const next = nextSwitchAt(instantMs)
    const day = calendar.describe(parts.date)
    return {
      phase,
      timezone,
      localDate: parts.date,
      localTime: formatClock(parts.minutes),
      peakDay: day.peakDay,
      dayLabel: day.label,
      leadMinutes,
      windows: windows.map((w) => ({ start: formatClock(w.start), end: formatClock(w.end) })),
      nextSwitch: next === null ? null : { at: new Date(next.at).toISOString(), to: next.to, date: next.date },
      phaseEndsAt: next === null ? null : new Date(next.at).toISOString(),
    }
  }

  return { phaseAt, nextSwitchAt, describe, marksForDate, windows, leadMinutes, timezone }
}
