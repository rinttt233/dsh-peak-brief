/**
 * 时区与日期工具 —— 零依赖，只用 Node 自带的 Intl。
 *
 * 峰谷判定必须与**用户配置的 IANA 时区**一致，不能依赖进程本地时区
 * （DSH 可能跑在任意 TZ 的机器上）。Asia/Shanghai 没有夏令时，
 * 但这里仍然按通用情形处理，避免以后换时区时静默出错。
 */

const FORMATTERS = new Map()

function formatterFor(timeZone) {
  let fmt = FORMATTERS.get(timeZone)
  if (fmt === undefined) {
    // hourCycle:'h23' 保证午夜是 00 而不是 24，避免 0 点被算成 1440 分钟。
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    FORMATTERS.set(timeZone, fmt)
  }
  return fmt
}

/** 校验 IANA 时区名是否可用。 */
export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone === '') return false
  try {
    formatterFor(timeZone).format(new Date(0))
    return true
  } catch {
    return false
  }
}

/** UTC 毫秒 → 该时区的本地日历字段。 */
export function zonedParts(instantMs, timeZone) {
  const parts = {}
  for (const part of formatterFor(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  const hour = Number(parts.hour)
  const minute = Number(parts.minute)
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute,
    second: Number(parts.second),
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: hour * 60 + minute,
  }
}

/** 某瞬间在该时区的 UTC 偏移（分钟，东正西负）。 */
export function zoneOffsetMinutes(instantMs, timeZone) {
  const p = zonedParts(instantMs, timeZone)
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return Math.round((asIfUtc - instantMs) / 60000)
}

/**
 * 「该时区的本地日期 + 当日分钟数」→ UTC 毫秒。
 *
 * 两趟求解：先按猜出的瞬间求偏移，再用修正后瞬间的真实偏移复算一次。
 * 单趟解在夏令时切换附近会差一小时，两趟解是这类换算的常规做法。
 */
export function instantOf(dateStr, minutes, timeZone) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const naive = Date.UTC(y, m - 1, d, 0, 0, 0) + minutes * 60000
  const firstOffset = zoneOffsetMinutes(naive, timeZone)
  const candidate = naive - firstOffset * 60000
  const secondOffset = zoneOffsetMinutes(candidate, timeZone)
  return secondOffset === firstOffset ? candidate : naive - secondOffset * 60000
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** 严格校验 'YYYY-MM-DD'，并拒绝 2026-02-30 这类不存在的日期。 */
export function isValidDate(dateStr) {
  if (typeof dateStr !== 'string') return false
  const match = DATE_RE.exec(dateStr)
  if (match === null) return false
  const [, y, m, d] = match
  const probe = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
  return probe.getUTCFullYear() === Number(y)
    && probe.getUTCMonth() === Number(m) - 1
    && probe.getUTCDate() === Number(d)
}

/** 日历日加减天数（纯日期运算，与时区无关）。 */
export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  t.setUTCDate(t.getUTCDate() + days)
  return t.toISOString().slice(0, 10)
}

/** 星期几：0=周日 … 6=周六。日期本身无时区含义，用 UTC 解析即可。 */
export function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

export const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 是否周一至周五。 */
export function isMonToFri(dateStr) {
  const weekday = weekdayOf(dateStr)
  return weekday >= 1 && weekday <= 5
}
