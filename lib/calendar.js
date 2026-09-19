/**
 * 峰谷日历 —— 决定「某一天是否要按峰谷时段计算」。
 *
 * 规则（已与用户确认）：
 *
 *   isPeakDay(d) = isStatutoryWorkday(d) && weekday(d) ∈ {周一…周五}
 *
 * 展开成四种日型：
 *
 *   法定节假日   → 全天闲时
 *   调休上班日   → 全天闲时   ← 国务院把某个周六/周日调成工作日，仍算闲时
 *   普通工作日   → 按峰谷时段
 *   普通周末     → 全天闲时
 *
 * 数据年份之外的日期走「未知年份降级」：只按周一至周五判断，
 * 既不崩，也不会静默按一份不存在的日历执行。
 */

import { BUNDLED, BUNDLED_YEARS } from './holidays.js'
import { isMonToFri, isValidDate } from './tz.js'

export const DAY_KIND = {
  /** 法定节假日：全天闲时 */
  HOLIDAY: 'holiday',
  /** 调休上班日：全天闲时（本插件的明确规则） */
  MAKEUP_WORKDAY: 'makeup-workday',
  /** 普通工作日：按峰谷时段 */
  WEEKDAY: 'weekday',
  /** 普通周末：全天闲时 */
  WEEKEND: 'weekend',
  /** 数据缺失的年份：降级为「周一至周五按峰谷」 */
  UNKNOWN_YEAR: 'unknown-year',
}

export const DAY_KIND_LABEL = {
  [DAY_KIND.HOLIDAY]: '法定节假日',
  [DAY_KIND.MAKEUP_WORKDAY]: '调休上班日',
  [DAY_KIND.WEEKDAY]: '工作日',
  [DAY_KIND.WEEKEND]: '周末',
  [DAY_KIND.UNKNOWN_YEAR]: '未知年份（降级为周一至周五）',
}

/** 手动覆盖的两种取值；同时接受几组同义写法。 */
const OVERRIDE_PEAK = new Set(['peak', 'workday', 'on'])
const OVERRIDE_OFF = new Set(['off', 'holiday', 'rest', 'none'])

function normalizeOverride(value) {
  if (typeof value !== 'string') return undefined
  const v = value.trim().toLowerCase()
  if (OVERRIDE_PEAK.has(v)) return 'peak'
  if (OVERRIDE_OFF.has(v)) return 'off'
  return undefined
}

/**
 * 把外部数据源（chinese-days 的年份 JSON，或本插件生成的同构表）规范化成
 * `{ holidays: {date: name}, workdays: {date: name} }`。
 * 形状不认识时返回 null —— 宁可不用，也不要把脏数据并进日历。
 */
export function normalizeHolidayTable(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const holidays = raw.holidays
  const workdays = raw.workdays
  if (holidays === null || typeof holidays !== 'object' || Array.isArray(holidays)) return null
  if (workdays === null || typeof workdays !== 'object' || Array.isArray(workdays)) return null

  function pick(source) {
    const out = {}
    for (const [date, value] of Object.entries(source)) {
      if (!isValidDate(date)) return null
      // chinese-days: "New Year's Day,元旦,1" → 取中文简称
      const text = String(value)
      const cells = text.split(',')
      out[date] = cells.length >= 2 && cells[1] !== '' ? cells[1] : text
    }
    return out
  }

  const pickedHolidays = pick(holidays)
  const pickedWorkdays = pick(workdays)
  if (pickedHolidays === null || pickedWorkdays === null) return null

  // 空表必须拒掉：否则一次拿到空响应的联网刷新会**静默遮蔽内置表**，
  // 把有法定节假日的年份降级成"只按周一至周五"，而且没有任何报错。
  if (Object.keys(pickedHolidays).length === 0 && Object.keys(pickedWorkdays).length === 0) return null

  return { holidays: pickedHolidays, workdays: pickedWorkdays }
}

/**
 * 联网取一年的节假日数据。**永不抛异常**：任何失败都返回 null，
 * 由调用方继续用内置兜底表。
 */
export async function fetchHolidayYear(url, { fetchImpl, timeoutMs = 8000 } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') return null
  if (typeof url !== 'string' || url === '') return null

  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await doFetch(url, controller === null ? undefined : { signal: controller.signal })
    if (res === null || typeof res !== 'object' || res.ok !== true) return null
    const raw = await res.json()
    return normalizeHolidayTable(raw)
  } catch {
    return null
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * 建一个日历。
 *
 * @param overrides - 手动覆盖：`{ '2027-01-01': 'off', '2027-02-06': 'peak' }`
 * @param bundled   - 内置年份表，默认用生成的 holidays.js
 * @param runtime   - 运行期由联网刷新并入的年份表，优先级高于 bundled
 */
export function createCalendar({ overrides = {}, bundled = BUNDLED, runtime = {} } = {}) {
  const normalizedOverrides = new Map()
  const invalidOverrides = []
  for (const [date, value] of Object.entries(overrides ?? {})) {
    const normalized = normalizeOverride(value)
    if (!isValidDate(date) || normalized === undefined) {
      invalidOverrides.push({ date, value })
      continue
    }
    normalizedOverrides.set(date, normalized)
  }

  function tableForYear(year) {
    const runtimeTable = runtime?.[year]
    if (runtimeTable !== undefined && runtimeTable !== null) return { table: runtimeTable, source: 'refresh' }
    const bundledTable = bundled?.[year]
    if (bundledTable !== undefined && bundledTable !== null) return { table: bundledTable, source: 'bundled' }
    return null
  }

  function dayKind(dateStr) {
    if (!isValidDate(dateStr)) {
      throw new TypeError(`calendar: 非法日期 ${JSON.stringify(dateStr)}（需要 YYYY-MM-DD）`)
    }

    const override = normalizedOverrides.get(dateStr)
    if (override === 'peak') return DAY_KIND.WEEKDAY
    if (override === 'off') return DAY_KIND.HOLIDAY

    const found = tableForYear(Number(dateStr.slice(0, 4)))
    if (found === null) return DAY_KIND.UNKNOWN_YEAR

    const { table } = found
    if (table.holidays?.[dateStr] !== undefined) return DAY_KIND.HOLIDAY
    if (table.workdays?.[dateStr] !== undefined) return DAY_KIND.MAKEUP_WORKDAY
    return isMonToFri(dateStr) ? DAY_KIND.WEEKDAY : DAY_KIND.WEEKEND
  }

  function isPeakDay(dateStr) {
    const kind = dayKind(dateStr)
    if (kind === DAY_KIND.WEEKDAY) return true
    // 未知年份降级：只按周一至周五判断
    if (kind === DAY_KIND.UNKNOWN_YEAR) return isMonToFri(dateStr)
    // 法定节假日 / 调休上班日 / 周末 一律全天闲时
    return false
  }

  function sourceOf(dateStr) {
    if (normalizedOverrides.has(dateStr)) return 'override'
    const found = tableForYear(Number(dateStr.slice(0, 4)))
    return found === null ? 'fallback' : found.source
  }

  /** 人类可读描述，供提示横幅与状态命令使用。 */
  function describe(dateStr) {
    const kind = dayKind(dateStr)
    const year = Number(dateStr.slice(0, 4))
    const found = tableForYear(year)
    let label = DAY_KIND_LABEL[kind]
    if (kind === DAY_KIND.HOLIDAY || kind === DAY_KIND.MAKEUP_WORKDAY) {
      const name = found?.table?.[kind === DAY_KIND.HOLIDAY ? 'holidays' : 'workdays']?.[dateStr]
      if (typeof name === 'string' && name !== '') label = name
    }
    return {
      date: dateStr,
      kind,
      label,
      peakDay: isPeakDay(dateStr),
      source: sourceOf(dateStr),
    }
  }

  return {
    dayKind,
    isPeakDay,
    sourceOf,
    describe,
    /** 内置表覆盖的年份。 */
    bundledYears: Array.isArray(BUNDLED_YEARS) ? [...BUNDLED_YEARS] : [],
    /**
     * 运行期已并入的年份。必须是**实时视图**：调用方可以先建日历、稍后再
     * 把联网刷新的数据填进 runtime 表，这里要如实反映当下的状态。
     */
    get runtimeYears() {
      return Object.keys(runtime ?? {}).map(Number).sort((a, b) => a - b)
    },
    /** 配置里被忽略的非法覆盖项，供状态命令提示用户。 */
    invalidOverrides,
  }
}
