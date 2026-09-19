/**
 * 配置契约 —— 设置界面与插件本体共用同一份默认值、规范化与校验规则。
 *
 * 为什么不用 schemastery：**外部挂载的插件解析不到裸包名**（已实测：
 * `@deepseek-ai/schemastery` / `@deepseek-ai/cordis` / `schemastery` 三个全部
 * ERR_MODULE_NOT_FOUND，因为插件目录向上没有任何 node_modules）。
 *
 * 而 dsh-settings 只用两种方式碰 schema：
 *
 *   resolve():  const value = schema(mergeLayers(base, section))
 *   describe(): registration.schema.toJSON()
 *
 * 所以这里给出一个**可调用的 schema 对象**（函数 + `toJSON`），两个调用点都满足，
 * 而且校验规则与 dsh-settings 的写入路径天然一致：`schema(merged)` 抛错，
 * 那次写入就被拒绝——这正是我们想要的"非法配置存不进去"。
 */

import { isValidTimeZone } from './tz.js'
import { normalizePeakWindows, formatClock } from './windows.js'

/** 设置命名空间（必须是 lower-kebab-case，见 dsh-settings 的命名约束）。 */
export const SETTINGS_NAMESPACE = 'peak-brief'

/** 设置页里展示的标题（客户端另有一份 i18n，这里供 Host 侧引用）。 */
export const SETTINGS_TITLE = '峰谷调度（dsh-peak-brief）'

export const NOTIFY_MODES = ['popup', 'message', 'off']
export const GATE_MODES = ['hard', 'off']

export const DEFAULT_CONFIG = {
  enabled: false,
  timezone: 'Asia/Shanghai',
  leadMinutes: 10,
  peakWindows: [
    ['09:00', '12:00'],
    ['14:00', '18:00'],
  ],
  notify: 'popup',
  gateMode: 'hard',
  /** 高峰时是否连辅助请求（会话标题、自动压缩）一起拦。 */
  blockAuxiliary: true,
  /** 手动覆盖：{ '2027-01-01': 'off', '2027-02-06': 'peak' } */
  overrides: {},
  /** 简报生成预算；dir 为 null 时落盘到 ~/.dsh/peak-brief（独立文件夹）。 */
  brief: { dir: null, provider: null, model: null },
  /** 联网刷新（默认关闭）；url 模板里的 {year} 会替换成目标年份。 */
  holidayRefresh: { enabled: false, url: '', years: [], timeoutMs: 8000, onStart: true },
}

const OVERRIDE_VALUES = new Set(['off', 'peak', 'holiday', 'rest', 'none', 'workday', 'on'])
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && Array.isArray(value) === false
}

function requireBoolean(value, field) {
  if (typeof value !== 'boolean') throw new TypeError(`${field} 必须是布尔值，收到 ${JSON.stringify(value)}`)
  return value
}

function requireEnum(value, allowed, field) {
  if (typeof value !== 'string' || allowed.includes(value) === false) {
    throw new TypeError(`${field} 必须是 ${allowed.join(' | ')} 之一，收到 ${JSON.stringify(value)}`)
  }
  return value
}

/** 把时段规范化成 `[['HH:MM','HH:MM'], …]`（排序、去重、严格校验）。 */
function requirePeakWindows(value) {
  const normalized = normalizePeakWindows(value) // 非法时抛 TypeError
  return normalized.map((w) => [formatClock(w.start), formatClock(w.end)])
}

function requireOverrides(value) {
  if (isPlainObject(value) === false) {
    throw new TypeError(`overrides 必须是对象，收到 ${JSON.stringify(value)}`)
  }
  const out = {}
  for (const [date, raw] of Object.entries(value)) {
    if (DATE_RE.test(date) !== true) {
      throw new TypeError(`overrides 的键必须是 YYYY-MM-DD，收到 ${JSON.stringify(date)}`)
    }
    const text = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
    if (OVERRIDE_VALUES.has(text) !== true) {
      throw new TypeError(`overrides["${date}"] 必须是 off / peak 之一，收到 ${JSON.stringify(raw)}`)
    }
    // 归一化成两种稳定取值，落盘后不会因为同义写法反复变化
    out[date] = text === 'peak' || text === 'workday' || text === 'on' ? 'peak' : 'off'
  }
  return out
}

function requireBrief(value) {
  if (value === undefined || value === null) return { ...DEFAULT_CONFIG.brief }
  if (isPlainObject(value) === false) throw new TypeError('brief 必须是对象')
  const out = { ...DEFAULT_CONFIG.brief, ...value }
  for (const field of ['dir', 'provider', 'model']) {
    if (out[field] !== null && typeof out[field] !== 'string') {
      throw new TypeError(`brief.${field} 必须是字符串或 null`)
    }
  }
  for (const field of ['maxInputBytes', 'maxOutputTokens', 'timeoutMs', 'maxMessages', 'maxCharsPerMessage', 'maxTotalChars', 'maxPendingAgeMs']) {
    if (out[field] === undefined) continue
    if (Number.isSafeInteger(out[field]) !== true || out[field] <= 0) {
      throw new TypeError(`brief.${field} 必须是正整数`)
    }
  }
  return out
}

function requireHolidayRefresh(value) {
  if (value === undefined || value === null) return { ...DEFAULT_CONFIG.holidayRefresh }
  if (isPlainObject(value) === false) throw new TypeError('holidayRefresh 必须是对象')
  const out = { ...DEFAULT_CONFIG.holidayRefresh, ...value }
  requireBoolean(out.enabled, 'holidayRefresh.enabled')
  if (typeof out.url !== 'string') throw new TypeError('holidayRefresh.url 必须是字符串')
  if (out.onStart !== undefined) requireBoolean(out.onStart, 'holidayRefresh.onStart')
  if (Array.isArray(out.years) !== true) throw new TypeError('holidayRefresh.years 必须是数组')
  out.years = out.years.map((year) => {
    if (Number.isSafeInteger(year) !== true) throw new TypeError('holidayRefresh.years 只能包含整数年份')
    return year
  })
  if (Number.isSafeInteger(out.timeoutMs) !== true || out.timeoutMs <= 0) {
    throw new TypeError('holidayRefresh.timeoutMs 必须是正整数')
  }
  return out
}

/**
 * 规范化并**严格校验**一整份配置。
 *
 * 抛错即代表这次写入被拒绝（dsh-settings 的写入路径会调用本函数），
 * 所以"非法配置存不进去"是结构性保证，而不是 UI 层的礼貌提示。
 */
export function normalizeConfig(raw) {
  const input = isPlainObject(raw) ? raw : {}
  const merged = { ...DEFAULT_CONFIG, ...input }

  const timezone = merged.timezone
  if (typeof timezone !== 'string' || isValidTimeZone(timezone) !== true) {
    throw new TypeError(`timezone 不是可用的 IANA 时区名：${JSON.stringify(timezone)}`)
  }

  const leadMinutes = merged.leadMinutes
  if (Number.isSafeInteger(leadMinutes) !== true || leadMinutes < 0) {
    throw new TypeError(`leadMinutes 必须是非负整数，收到 ${JSON.stringify(leadMinutes)}`)
  }

  return {
    enabled: requireBoolean(merged.enabled, 'enabled'),
    timezone,
    leadMinutes,
    peakWindows: requirePeakWindows(merged.peakWindows),
    notify: requireEnum(merged.notify, NOTIFY_MODES, 'notify'),
    gateMode: requireEnum(merged.gateMode, GATE_MODES, 'gateMode'),
    blockAuxiliary: requireBoolean(merged.blockAuxiliary, 'blockAuxiliary'),
    overrides: requireOverrides(merged.overrides),
    brief: requireBrief(merged.brief),
    holidayRefresh: requireHolidayRefresh(merged.holidayRefresh),
  }
}

/** 只挑出受设置管辖的字段（其余自定义字段原样保留给插件自己用）。 */
export function settingsBaseFrom(rawConfig) {
  const input = isPlainObject(rawConfig) ? rawConfig : {}
  const base = {}
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (Object.prototype.hasOwnProperty.call(input, key)) base[key] = input[key]
  }
  return base
}

/**
 * 造一个 dsh-settings 能接受的 schema：
 * 可调用（`schema(merged)` 求值并校验）+ 带 `toJSON()`（供配置界面读结构）。
 */
export function createSettingsSchema() {
  const schema = (value) => normalizeConfig(value)
  schema.toJSON = () => schemaJson()
  return schema
}

/** schemastery `toJSON()` 形状的最小等价物：够配置界面读懂结构即可。 */
export function schemaJson() {
  const windowPair = { type: 'array', items: { type: 'string' }, minLength: 2, maxLength: 2 }
  return {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: DEFAULT_CONFIG.enabled, description: '总开关' },
      timezone: { type: 'string', default: DEFAULT_CONFIG.timezone, description: 'IANA 时区' },
      leadMinutes: { type: 'number', default: DEFAULT_CONFIG.leadMinutes, description: '高峰前多少分钟开始准备' },
      peakWindows: {
        type: 'array',
        items: windowPair,
        default: DEFAULT_CONFIG.peakWindows,
        description: '高峰时段，HH:MM-HH:MM',
      },
      notify: { type: 'string', enum: NOTIFY_MODES, default: DEFAULT_CONFIG.notify },
      gateMode: { type: 'string', enum: GATE_MODES, default: DEFAULT_CONFIG.gateMode },
      blockAuxiliary: { type: 'boolean', default: DEFAULT_CONFIG.blockAuxiliary },
      overrides: { type: 'object', default: DEFAULT_CONFIG.overrides, description: '按日手动覆盖' },
      brief: { type: 'object', default: DEFAULT_CONFIG.brief },
      holidayRefresh: { type: 'object', default: DEFAULT_CONFIG.holidayRefresh },
    },
    additionalProperties: false,
  }
}
