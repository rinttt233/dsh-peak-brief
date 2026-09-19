/**
 * dsh-peak-brief — host half.
 *
 * 阶段：P0 通路 → P1 峰谷日历 → P2 门控与逃生 → P3 恢复简报 → P4 周期调度与重启对账
 *       → P5 斜杠命令、联网刷新接线、验收脚本 → 设置界面（settings.section）。
 *
 * 门控只在 `enabled: true` 且进入 peak 相位时生效；默认 enabled=false，因此
 * 挂载本插件本身不会拦截任何请求、也不会排任何定时器。
 *
 * 零依赖约束：外部挂载（绝对路径）的插件解析不到 `@deepseek-ai/*` 裸包名，
 * 所以本文件只 import 同目录的相对模块，不 import 任何第三方包。
 */

import {
  DEFAULT_LIMITS as BRIEF_LIMITS,
  buildBriefRequest,
  fallbackBrief,
  generateBrief,
} from './brief.js'
import { deleteBriefFile, readBriefFile, writeBriefFile } from './brief-store.js'
import { createCalendar, fetchHolidayYear } from './calendar.js'
import { createGate, DEFAULT_ALLOW_MINUTES } from './gate.js'
import {
  buildNoticeMessage,
  buildResumeMessage,
  decideCycle,
  newCycle,
  planDisarm,
  planResume,
} from './resume.js'
import {
  DEFAULT_CONFIG,
  SETTINGS_NAMESPACE,
  createSettingsSchema,
  normalizeConfig,
  settingsBaseFrom,
} from './settings.js'
import { createWindows } from './windows.js'

const PLUGIN_ID = 'dsh-peak-brief'
const BASE = '/api/peak-brief'
/** 构建标记：用来确认当前跑的是哪一份代码（HMR 是否真的接管了）。 */
const BUILD = 'p5-settings-2026-09-19-b'
/** 阶段标签，出现在 publicState 与挂载提示里。 */
const STAGE = 'P5+设置界面'

export const name = PLUGIN_ID
/**
 * `agents` / `sessions` 代码里没有直接引用，但它们保证 `agent/created` 事件所依赖的
 * 服务在挂载前就已就位——周期调度完全建立在这个事件上。二者都是 base bundle 里的
 * 服务，任何能跑会话的组合都必然存在，所以多这两个要求不会增加加载失败面。
 *
 * `commands` / `settings` 刻意**不**放进 inject：cordis 的硬 inject 缺一个服务会让
 * 整个插件拒绝加载，而门控 / 简报 / 恢复都不依赖它们。它们走 `ctx.inject([...], cb)`
 * 的可选注入路径（见下）。
 */
export const inject = ['agents', 'llm', 'sessions', 'webServer']

/** 重启对账时，多旧的"待恢复"简报就不再认了（默认 12 小时）。 */
const DEFAULT_MAX_PENDING_AGE_MS = 12 * 60 * 60 * 1000

/** 把时间戳（数字 / ISO 字符串 / 缺失）安全地转成 ISO 字符串；无效返回 null。 */
function toIso(value) {
  if (value === null || value === undefined || value === '') return null
  const ms = typeof value === 'number' ? value : Date.parse(String(value))
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1_000_000) raw = raw.slice(0, 1_000_000)
    })
    req.on('end', () => {
      if (raw === '') return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

export function apply(ctx, rawConfig) {
  /**
   * 生效配置。**可变**：设置界面写入后会由 applyConfig() 重新赋值。
   *
   * calendar / windows / gate 也声明成 `let`：所有闭包引用的是同一个绑定，
   * 重新赋值就能让每一个已注册的监听器、路由、定时器立刻用上新配置，
   * 不需要把整个文件改成 `runtime.xxx` 的间接访问。
   */
  let config = normalizeConfig({ ...DEFAULT_CONFIG, ...(rawConfig ?? {}) })

  /**
   * 联网刷新并入的运行期年份表。
   *
   * createCalendar 每次判定时才按引用读 `runtime[year]`，所以可以先建日历、稍后
   * 再把数据填进来。重建日历时必须沿用**同一个**对象，否则刷新过的数据会丢。
   */
  const runtimeHolidays = {}

  /** 由一份配置构造全部派生物。 */
  function buildDerived(cfg) {
    const nextCalendar = createCalendar({ overrides: cfg.overrides, runtime: runtimeHolidays })
    const nextWindows = createWindows({
      calendar: nextCalendar,
      peakWindows: cfg.peakWindows,
      timezone: cfg.timezone,
      leadMinutes: cfg.leadMinutes,
    })
    return {
      calendar: nextCalendar,
      windows: nextWindows,
      gate: createGate({ windows: nextWindows, config: cfg }),
    }
  }

  let { calendar, windows, gate } = buildDerived(config)

  /**
   * 应用一份新配置：重建派生物并重排定时器。
   * 抛错时保留上一份可用配置——设置界面写坏一个字段不该让插件瘫痪。
   */
  function applyConfig(next) {
    const normalized = normalizeConfig(next)
    const built = buildDerived(normalized)
    config = normalized
    calendar = built.calendar
    windows = built.windows
    gate = built.gate
    scheduleTick()
    return normalized
  }

  /**
   * 注册设置命名空间（供「设置 → 峰谷调度」页读写）。
   *
   * `base` 是 patch 层里的组合配置：解析顺序为 schema 默认值 → base → 用户设置层，
   * 所以在设置页里清空某个字段会回退到 patch 里的值，而不是硬回内置默认。
   *
   * 用 `ctx.inject(['settings'], …)` 而不是把 'settings' 写进 inject：硬 inject 缺一个
   * 服务会让整个插件拒绝加载，而门控 / 简报 / 恢复都不依赖 settings。也**不能**直接读
   * `ctx.settings`——那会抛 `cannot get property "settings" without inject`。
   */
  const settingsInfo = {
    registered: false,
    namespace: SETTINGS_NAMESPACE,
    applies: 'live',
    reason: 'settings-service-unavailable',
  }

  function registerSettings(settingsCtx) {
    try {
      const scope = settingsCtx.settings.register(SETTINGS_NAMESPACE, createSettingsSchema(), {
        base: settingsBaseFrom(rawConfig),
        applies: 'live',
      })
      const rebuilt = buildDerived(scope.get())
      config = scope.get()
      calendar = rebuilt.calendar
      windows = rebuilt.windows
      gate = rebuilt.gate
      scope.watch((next) => {
        try {
          applyConfig(next)
          ctx.logger?.info?.(`${PLUGIN_ID} 设置已更新并即时生效`)
        } catch (error) {
          // schema 已经保证了合法性，走到这里说明是派生物构造出了问题：
          // 保留旧配置并大声抱怨，不要带着半套配置继续跑。
          ctx.logger?.warn?.(`${PLUGIN_ID} 新设置无法应用，保留上一份：${String(error?.message ?? error)}`)
        }
      })
      settingsInfo.registered = true
      settingsInfo.reason = null
    } catch (error) {
      // 例如文档里存了一份 schema 判为非法的 section——注册本身就会失败。
      settingsInfo.reason = `register-failed: ${String(error?.message ?? error)}`
    }
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => { registerSettings(settingsCtx) })
  }

  /**
   * 时钟覆盖：只由 /api/peak-brief.debug-clock 设置，默认 null（走真实时间）。
   * 存在的意义是能在不等到明早 8:50 的前提下把一整个工作日推演一遍。
   */
  let clockOverrideMs = null
  const now = () => (clockOverrideMs === null ? Date.now() : clockOverrideMs)

  // 定时器句柄与计数提到最前面：agent/created 的处理器可能在 apply 期间就被调用。
  let tickTimer = null
  let tickCount = 0

  /**
   * 已经为哪一段高峰推过「已拦截」提示。
   * 门控会在高峰期间拦下每一次请求——逐次弹提示会把界面刷屏，所以按
   * 「本地日期 + 高峰窗口起点」去重，一段只提醒一次（离开这一段后 key 改变，
   * 下一段会重新提醒）。
   */
  let lastBlockNoticeKey = null

  /** 当前瞬间落在哪个高峰窗口里；用日期 + 窗口起点作为这一段的身份。 */
  function peakSegmentKey(view) {
    const minutes = Number(view.localTime.slice(0, 2)) * 60 + Number(view.localTime.slice(3, 5))
    const hit = windows.windows.find((w) => minutes >= w.start && minutes < w.end)
    return hit === undefined ? `${view.localDate}#?` : `${view.localDate}#${hit.start}`
  }

  /** 一段高峰只推一条「被拦了、怎么放行」的提示。 */
  function noteBlockedOnce(view) {
    const key = peakSegmentKey(view)
    if (key === lastBlockNoticeKey) return false
    lastBlockNoticeKey = key
    pushNotice(
      'peak',
      '本次模型请求已被拦截：当前处于 DeepSeek 高峰计价时段。\n'
      + `${view.localDate} ${view.localTime} · ${view.dayLabel}\n`
      + '本次不发送请求即不产生费用。需要继续：/peak-allow 30',
    )
    return true
  }

  /**
   * 唯一的拦截点：llm/stream 是 waterfall，返回值取代下游的适配器流。
   * 放行就是 `return next()`；拦截就是返回一个只含终止 finish 的流。
   */
  ctx.on('llm/stream', (options, next) => {
    const at = now()
    const decision = gate.decide(at, options)
    if (decision.block !== true) return next()
    ctx.logger?.info?.(`${PLUGIN_ID} 已拦截一次模型请求（${decision.reason}）`)
    // 用户是在浏览器里等回复的：不提示的话，界面只会「什么都没发生」。
    noteBlockedOnce(windows.describe(at))
    return gate.blockedStream(decision)
  })

  const state = {
    /** 自增序号，Client 用它做 key，保证同文本重复提示也能重放动画。 */
    seq: 0,
    /** 当前待提示的通知；null 表示无。 */
    notice: null,
    /** 每个会话最近一次生成的简报（内存镜像，落盘的是同一份内容）。 */
    briefs: new Map(),
    /** 每个会话当前的峰谷周期记录（briefed / disarmed / resumed）。 */
    cycles: new Map(),
  }

  /** 活着的 root agent，按 sessionId 索引——恢复时要靠它。 */
  const liveAgents = new Map()

  ctx.on('agent/created', ({ agent }) => {
    const id = String(agent?.session?.id ?? '')
    if (id === '') return
    liveAgents.set(id, agent)
    const outcome = reconcileSession(id)
    if (outcome.reconciled === true) {
      pushNotice('warn', `发现一份未恢复的暂停简报（重启对账），闲时将继续该任务。\n会话 ${id}`)
    }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const id = String(agent?.session?.id ?? '')
    if (id !== '') liveAgents.delete(id)
  })

  /** 目标状态是可选的：没挂 dsh-goal 时不该拦住整个流程。 */
  function readGoal(agent) {
    try {
      return ctx.goals?.get?.(agent) ?? null
    } catch {
      return null
    }
  }

  /** 决定这次简报用哪条模型路由：配置覆盖优先，否则用本会话已记录的请求路由。 */
  function resolveRoute(session) {
    const provider = config.brief?.provider
    const model = config.brief?.model
    if (typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== '') {
      return { provider, model }
    }
    try {
      const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : null
      const cfg = header?.config
      if (typeof cfg?.provider === 'string' && typeof cfg?.model === 'string') {
        return { provider: cfg.provider, model: cfg.model }
      }
    } catch {
      /* 没有已记录的请求路由 */
    }
    return null
  }

  /**
   * 可选的联网节假日刷新。
   *
   * 三条纪律：**永不抛异常**（失败只是那一年继续用内置表）、**永不覆盖已有数据**
   * （空表/脏表在 normalizeHolidayTable 就被拒了，不会静默遮蔽内置表）、
   * **不阻塞启动**（异步跑，判定仍然即时可用）。
   */
  async function refreshHolidays({ years, reason = 'manual' } = {}) {
    const cfg = config.holidayRefresh ?? {}
    if (cfg.enabled !== true) return { skipped: 'disabled', results: [] }

    const url = typeof cfg.url === 'string' ? cfg.url : ''
    if (url === '') return { skipped: 'no-url', results: [] }

    const view = windows.describe(now())
    const currentYear = Number(view.localDate.slice(0, 4))
    const configured = Array.isArray(cfg.years) && cfg.years.length > 0 ? cfg.years : null
    const wanted = Array.isArray(years) && years.length > 0
      ? years
      : (configured ?? [currentYear, currentYear + 1])

    const results = []
    for (const year of wanted) {
      if (!Number.isSafeInteger(year)) {
        results.push({ year, ok: false, reason: 'bad-year' })
        continue
      }
      if (Object.prototype.hasOwnProperty.call(runtimeHolidays, year) === true) {
        results.push({ year, ok: true, reason: 'already-loaded' })
        continue
      }
      const target = url.includes('{year}') ? url.split('{year}').join(String(year)) : url
      const timeoutMs = Number(cfg.timeoutMs ?? 8000)
      const table = await fetchHolidayYear(target, {
        fetchImpl: globalThis.fetch,
        timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 8000,
      })
      if (table === null) {
        results.push({ year, ok: false, reason: 'fetch-or-shape-failed', url: target })
        continue
      }
      runtimeHolidays[year] = table
      results.push({
        year,
        ok: true,
        holidays: Object.keys(table.holidays).length,
        workdays: Object.keys(table.workdays).length,
        url: target,
      })
    }
    return { reason, results }
  }

  /**
   * 生成并落盘一份恢复简报。
   *
   * 任何失败都降级到不花钱的 fallbackBrief —— 「没有简报就不许恢复」会让
   * 一次解析失败变成工作丢失。
   */
  async function runBriefing(agent) {
    const session = agent?.session
    if (session === undefined || session === null) {
      return { ok: false, error: { code: 'NO_SESSION', message: '没有可用会话' } }
    }

    const sessionId = String(session.id)
    const at = now()
    const view = windows.describe(at)
    const messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
    const goal = readGoal(agent)
    const limits = { ...BRIEF_LIMITS, ...(config.brief ?? {}) }
    const request = buildBriefRequest({ messages, goal, view, limits })

    let result = { ok: false, error: { code: 'BRIEF_SKIPPED', message: '未执行' } }
    if (request.overBudget === true) {
      result = {
        ok: false,
        error: {
          code: 'BRIEF_OVER_BUDGET',
          message: `简报输入 ${request.inputBytes} 字节，超出 maxInputBytes ${limits.maxInputBytes}`,
        },
      }
    } else {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller === null ? null : setTimeout(() => controller.abort(), limits.timeoutMs)
      try {
        result = await generateBrief({
          llm: ctx.llm,
          route: resolveRoute(session),
          system: request.system,
          userText: request.userText,
          sessionId,
          limits,
          signal: controller?.signal,
          // 自己的调用不能被自己的门控拦掉
          markOwn: gate.markOwn,
        })
      } catch (error) {
        result = { ok: false, error: { code: 'BRIEF_THREW', message: String(error?.message ?? error) } }
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    }

    const degraded = result.ok !== true
    const brief = result.ok === true
      ? result.brief
      : fallbackBrief({ messages, goal, reason: result.error?.code })

    const payload = {
      brief,
      meta: {
        sessionId,
        pausedAt: new Date(at).toISOString(),
        phase: view.phase,
        localDate: view.localDate,
        localTime: view.localTime,
        nextSwitch: view.nextSwitch,
        degraded,
        error: degraded ? result.error : null,
        route: degraded ? null : (result.route ?? null),
        usage: result.usage ?? null,
        stats: request.stats,
        inputBytes: request.inputBytes,
      },
    }

    let filePath = null
    let writeError = null
    try {
      filePath = writeBriefFile(config.brief?.dir ?? null, sessionId, payload)
    } catch (error) {
      writeError = String(error?.message ?? error)
    }

    const record = { ...payload, filePath, writeError, generatedAt: at }
    state.briefs.set(sessionId, record)

    pushNotice(
      degraded ? 'warn' : 'info',
      `已生成恢复简报（${degraded ? `降级：${result.error?.code}` : '正常'}）\n`
      + `会话 ${sessionId} · ${view.localDate} ${view.localTime}\n`
      + `目标：${brief.objective}\n`
      + `可继续：${brief.resumable === true ? '是' : '否'}`,
    )

    return { ok: true, brief, degraded, filePath, writeError, meta: record.meta }
  }

  // ------------------------------------------------------------ 峰谷周期调度

  /**
   * 启动期对账。约定：**简报文件存在 ⟺ 有一次尚未恢复的暂停**
   * （恢复成功就删文件，所以文件的存在本身就是持久标记）。
   *
   * 没有这一步，进程重启后内存里的 cycle 消失，decideCycle 会认为「没有待办」，
   * 那份简报就永远不会被交回——任务静默地卡在暂停里。
   */
  function reconcileSession(sessionId) {
    if (state.briefs.has(sessionId) === true) return { reconciled: false, reason: 'already-in-memory' }

    const record = readBriefFile(config.brief?.dir ?? null, sessionId)
    if (record === null) return { reconciled: false, reason: 'no-pending-brief' }

    // 太旧的简报不认：把一周前的任务重新拉起来只会让人莫名其妙。
    const maxAge = Number(config.brief?.maxPendingAgeMs ?? DEFAULT_MAX_PENDING_AGE_MS)
    const writtenAt = Date.parse(String(record.writtenAt ?? ''))
    if (Number.isFinite(writtenAt) && Number.isFinite(maxAge) && now() - writtenAt > maxAge) {
      return { reconciled: false, reason: 'stale-brief', ageMs: now() - writtenAt }
    }

    const meta = record.meta ?? {}
    const cycle = newCycle(Number.isFinite(meta.peakStartAt) ? meta.peakStartAt : now())
    cycle.briefed = true
    cycle.resumed = false
    cycle.disarm = meta.disarm ?? { attempted: false, reason: 'recovered-from-disk', wasArmed: false }
    cycle.briefPath = record.filePath ?? null

    state.cycles.set(sessionId, cycle)
    // 归一化成与内存记录相同的形状：磁盘记录用的是 `writtenAt`，
    // 直接塞进 state.briefs 会让下游读到 undefined 并炸在 toISOString 上。
    state.briefs.set(sessionId, {
      ...record,
      filePath: cycle.briefPath,
      writeError: null,
      generatedAt: Number.isFinite(writtenAt) ? writtenAt : now(),
      reconciled: true,
    })
    return { reconciled: true, briefPath: cycle.briefPath, disarm: cycle.disarm }
  }

  /** 在下一个相位边界唤醒自己。返回距下次唤醒的毫秒数。 */
  function scheduleTick() {
    if (tickTimer !== null) {
      clearTimeout(tickTimer)
      tickTimer = null
    }
    if (config.enabled !== true) return null
    const at = now()
    const next = windows.nextSwitchAt(at)
    if (next === null) return null
    const delay = Math.max(1000, next.at - at + 250)
    tickTimer = setTimeout(() => {
      tickTimer = null
      void runTick('timer')
    }, delay)
    if (typeof tickTimer.unref === 'function') tickTimer.unref()
    return delay
  }

  /** 解除目标的进程内续跑授权（不改持久相位）。 */
  function disarmGoal(agent) {
    const goals = ctx.goals
    if (goals === undefined || goals === null || typeof goals.get !== 'function') {
      return { attempted: false, reason: 'no-goal-service', wasArmed: false }
    }
    let view
    try {
      view = goals.get(agent)
    } catch (error) {
      return { attempted: false, reason: `get-failed: ${String(error?.message ?? error)}`, wasArmed: false }
    }
    const plan = planDisarm(view)
    if (plan.disarm !== true) return { attempted: false, reason: plan.reason, wasArmed: false }
    try {
      goals.disarm(agent)
      return { attempted: true, reason: 'disarmed', wasArmed: true, phase: plan.phase }
    } catch (error) {
      return { attempted: false, reason: `disarm-failed: ${String(error?.message ?? error)}`, wasArmed: false }
    }
  }

  /** T-10：生成简报 + 停掉自动续跑。 */
  async function doBriefPhase(agent, sessionId, peakStartAt) {
    // 简报生成的每一步都可能因为未预期的服务契约而抛（例如 session 接口变化）。
    // 一次生成失败绝不能中断整个调度循环，也不能让「停自动续跑」这一步被跳过——
    // 高峰定价才是要躲的东西，简报只是让恢复更顺。
    let outcome
    let failure = null
    try {
      outcome = await runBriefing(agent)
    } catch (error) {
      failure = String(error?.message ?? error)
      outcome = { ok: false, brief: null, filePath: null, error: { code: 'BRIEF_THREW', message: failure } }
    }

    let disarm
    try {
      disarm = disarmGoal(agent)
    } catch (error) {
      disarm = { attempted: false, reason: `disarm-threw: ${String(error?.message ?? error)}`, wasArmed: false }
    }

    const cycle = newCycle(peakStartAt)
    cycle.briefed = true
    cycle.disarm = disarm
    cycle.briefPath = outcome.filePath ?? null
    state.cycles.set(sessionId, cycle)

    // 把 disarm 记录一并写进简报文件：进程重启后靠它决定是否要重新武装目标。
    try {
      const existing = state.briefs.get(sessionId)
      if (existing !== undefined && existing !== null) {
        writeBriefFile(config.brief?.dir ?? null, sessionId, {
          brief: existing.brief,
          meta: { ...existing.meta, peakStartAt, disarm },
        })
      }
    } catch {
      /* 写不进去不影响本次周期，只影响重启后的对账 */
    }

    pushNotice(failure === null ? 'warn' : 'peak', [
      `高峰将至：已生成恢复简报并停止自动续跑（${new Date(peakStartAt).toISOString()} 进入高峰）。`,
      `会话 ${sessionId}`,
      `目标续跑：${disarm.attempted ? '已解除授权，闲时自动恢复' : `未改动（${disarm.reason}）`}`,
      failure === null ? null : `⚠ 简报生成异常，闲时将以降级方式恢复：${failure}`,
    ].filter((line) => line !== null).join('\n'))

    return { outcome, disarm, failure }
  }

  /** 闲时：把简报交回给 AI，并重新武装目标。 */
  function doResumePhase(agent, sessionId) {
    const cycle = state.cycles.get(sessionId) ?? null
    const record = state.briefs.get(sessionId) ?? null
    // 进程重启过的话内存里没有，退回磁盘上的记录。
    const disk = record === null ? readBriefFile(config.brief?.dir ?? null, sessionId) : null
    const brief = record?.brief ?? disk?.brief ?? null
    const meta = record?.meta ?? disk?.meta ?? {}

    const result = {
      injected: false,
      followedUp: false,
      skipped: null,
      goalResumed: false,
      goalResumeSkipped: null,
      fileDeleted: false,
      error: null,
    }

    const resumable = brief === null ? true : brief.resumable !== false
    if (resumable !== true) {
      // 简报判定「没有未完成的工作」——那就不要凭空起一轮把已收尾的活重新拉起来。
      result.skipped = 'brief-not-resumable'
    } else {
      try {
        // inject 只带一行 notice（可能错过 pre-step 已认领的批次）；
        // followup 携带**完整简报**，保证一定送达。
        agent.inject(buildNoticeMessage(brief))
        result.injected = true
        agent.followup(buildResumeMessage(brief ?? {
          objective: '（缺少简报）', status: 'in_progress', resumable: true,
        }, {
          pausedAt: meta.pausedAt ?? null,
          resumedAt: new Date(now()).toISOString(),
        }))
        result.followedUp = true
      } catch (error) {
        result.error = `deliver-failed: ${String(error?.message ?? error)}`
      }
    }

    // 目标重新武装：只有「我们解除过、且它本来是 armed」才恢复。
    if (cycle?.disarm?.attempted === true && result.error === null && resumable === true) {
      try {
        const view = ctx.goals?.get?.(agent) ?? null
        const plan = planResume(view, cycle.disarm)
        if (plan.resume === true) {
          ctx.goals.resume(agent, { id: view.id, revision: view.revision })
          result.goalResumed = true
        } else {
          result.goalResumeSkipped = plan.reason
        }
      } catch (error) {
        result.goalResumeSkipped = `resume-failed: ${String(error?.message ?? error)}`
      }
    }

    // 简报文件用完即弃。注意：这只是**文件**；注入进会话的消息无法从记录抹除。
    try {
      result.fileDeleted = deleteBriefFile(config.brief?.dir ?? null, sessionId)
    } catch {
      result.fileDeleted = false
    }

    if (cycle !== null) cycle.resumed = true

    pushNotice('info', [
      resumable === true ? '高峰结束：已交回恢复简报并继续任务。' : '高峰结束：简报判定任务已收尾，未自动继续。',
      `会话 ${sessionId}`,
      result.goalResumed ? '目标已重新武装' : `目标续跑：${result.goalResumeSkipped ?? '无需处理'}`,
    ].join('\n'))

    return result
  }

  /** 定时器或调试接口触发的一次周期检查。 */
  async function runTick(source = 'timer') {
    tickCount += 1
    const at = now()
    const view = windows.describe(at)
    const enabled = config.enabled === true
    const actions = []

    for (const [sessionId, agent] of liveAgents) {
      const decision = decideCycle({
        phase: view.phase,
        nextSwitch: view.nextSwitch,
        cycle: state.cycles.get(sessionId) ?? null,
        enabled,
      })
      // 逐个会话隔离：某一个会话炸了不能把其余会话的调度一起带走。
      try {
        if (decision.action === 'brief') {
          const { disarm, failure } = await doBriefPhase(agent, sessionId, decision.peakStartAt)
          actions.push({ sessionId, action: 'brief', peakStartAt: decision.peakStartAt, disarm, failure })
        } else if (decision.action === 'resume') {
          actions.push({ sessionId, action: 'resume', ...doResumePhase(agent, sessionId) })
        } else {
          actions.push({ sessionId, action: 'none', reason: decision.reason })
        }
      } catch (error) {
        const message = String(error?.message ?? error)
        ctx.logger?.warn?.(`${PLUGIN_ID} 会话 ${sessionId} 的周期动作失败：${message}`)
        actions.push({ sessionId, action: decision.action, error: message })
      }
    }

    const nextTickInMs = scheduleTick()
    return {
      source,
      at: new Date(at).toISOString(),
      phase: view.phase,
      peakDay: view.peakDay,
      tickCount,
      enabled,
      liveSessions: liveAgents.size,
      actions,
      nextTickInMs,
    }
  }

  // ------------------------------------------------------------ 斜杠命令

  /**
   * 注册人类可用的斜杠命令。
   *
   * 用 `ctx.inject(['commands'], …)` 而不是把 `commands` 写进 inject：硬 inject 缺一个
   * 服务会让整个插件拒绝加载，而门控 / 简报 / 恢复都不依赖命令。也**不能**直接读
   * `ctx.commands`——那会抛 `cannot get property "commands" without inject`
   * （线上实测踩过：命令静默没注册上）。
   */
  function registerCommands(commands) {
    if (commands === undefined || commands === null || typeof commands.register !== 'function') {
      return { registered: false, reason: 'commands-service-unavailable', names: [] }
    }

    const specs = [
      {
        name: 'peak-allow',
        description: '临时放行高峰拦截（默认 30 分钟，且不超过本段高峰结束）',
        handler: async (invocation) => {
          const raw = String(invocation?.rawInput ?? '').trim()
          let minutes = DEFAULT_ALLOW_MINUTES
          if (raw !== '') {
            const parsed = Number(raw)
            if (Number.isFinite(parsed) !== true || parsed <= 0) {
              return { kind: 'error', text: `用法：/peak-allow [分钟数]。收到 ${JSON.stringify(raw)}` }
            }
            minutes = parsed
          }
          const before = windows.describe(now())
          const allow = gate.allowFor(minutes, now(), 'slash-command')
          pushNotice('info', `已放行本次高峰（/peak-allow）：到 ${allow.until} 为止不再拦截。`)
          return {
            kind: 'success',
            text: before.phase === 'peak'
              ? `已放行 ${Math.round(minutes)} 分钟（本段高峰内），到 ${allow.until} 恢复拦截。`
              : `当前不在高峰（相位 ${before.phase}），已记下 ${Math.round(minutes)} 分钟的放行窗口到 ${allow.until}。`,
          }
        },
      },
      {
        name: 'peak-status',
        description: '查看峰谷相位、门控状态与待恢复简报',
        handler: async () => {
          const view = windows.describe(now())
          const snap = gate.snapshot(now())
          const cycles = [...state.cycles.values()]
          return {
            kind: 'success',
            text: [
              `相位 ${view.phase} · ${view.localDate} ${view.localTime} · ${view.dayLabel}`,
              `时区 ${view.timezone} · 提前量 ${view.leadMinutes} 分钟 · 时段 ${view.windows.map((w) => `${w.start}-${w.end}`).join(' / ') || '（无）'}`,
              `下次切换：${view.nextSwitch === null ? '无' : `${view.nextSwitch.date} → ${view.nextSwitch.to}`}`,
              `门控：${snap.enabled === true ? (snap.blocking ? '正在硬拦' : '已启用但当前不拦') : '未启用'}${snap.allow.active ? ` · 已放行至 ${snap.allow.until}` : ''}`,
              `拦截次数：${snap.blockedCount}`,
              `活会话：${liveAgents.size} · 未恢复的暂停：${cycles.filter((c) => c.briefed === true && c.resumed !== true).length}`,
            ].join('\n'),
          }
        },
      },
      {
        name: 'peak-brief',
        description: '立刻为当前会话生成一份恢复简报',
        handler: async (invocation) => {
          const agent = invocation?.agent
          if (agent === undefined || agent === null) return { kind: 'error', text: '没有可用会话。' }
          const outcome = await runBriefing(agent)
          if (outcome.ok !== true) {
            return { kind: 'error', text: `简报生成失败：${outcome.error?.code} ${outcome.error?.message ?? ''}` }
          }
          return {
            kind: 'success',
            text: `简报已生成${outcome.degraded ? '（降级）' : ''}：${outcome.brief.objective}\n可继续：${outcome.brief.resumable === true ? '是' : '否'}\n文件：${outcome.filePath ?? '（未落盘）'}`,
          }
        },
      },
      {
        name: 'peak-resume',
        description: '立刻按恢复简报继续当前会话（跳过等待闲时）',
        handler: async (invocation) => {
          const agent = invocation?.agent
          if (agent === undefined || agent === null) return { kind: 'error', text: '没有可用会话。' }
          const sessionId = String(agent.session?.id ?? '')
          const outcome = doResumePhase(agent, sessionId)
          if (outcome.error !== null) return { kind: 'error', text: `恢复失败：${outcome.error}` }
          if (outcome.skipped === 'brief-not-resumable') {
            return { kind: 'success', text: '简报判定该任务已收尾，未启动新一轮。' }
          }
          return {
            kind: 'success',
            text: `已交回简报并启动一轮继续${outcome.goalResumed ? '，目标已重新武装' : ''}。`,
          }
        },
      },
    ]

    const names = []
    for (const spec of specs) {
      try {
        ctx.effect(() => commands.register(spec), `peak-brief: /${spec.name} command`)
        names.push(spec.name)
      } catch (error) {
        ctx.logger?.warn?.(`${PLUGIN_ID} 注册 /${spec.name} 失败：${String(error?.message ?? error)}`)
      }
    }
    return { registered: true, reason: null, names }
  }

  /** 斜杠命令的注册结果（服务不可用时如实报告，而不是假装成功）。 */
  const commandRegistration = { registered: false, reason: 'commands-service-unavailable', names: [] }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], (commandCtx) => {
      try {
        const outcome = registerCommands(commandCtx.commands)
        commandRegistration.registered = outcome.registered
        commandRegistration.reason = outcome.reason
        commandRegistration.names = outcome.names
      } catch (error) {
        commandRegistration.reason = `register-failed: ${String(error?.message ?? error)}`
      }
    })
  }

  function pushNotice(kind, text) {
    state.seq += 1
    state.notice = { seq: state.seq, kind, text, at: new Date().toISOString() }
    return state.notice
  }

  /** 给定瞬间的完整判定结果（纯读）。 */
  function statusAt(instantMs) {
    const view = windows.describe(instantMs)
    const day = calendar.describe(view.localDate)
    return {
      ...view,
      dayKind: day.kind,
      daySource: day.source,
      enabled: config.enabled === true,
      gateMode: config.gateMode,
      notify: config.notify,
      /** enabled 且进入 peak 时真的会拦截。 */
      enforcement: gate.snapshot(instantMs).blocking ? 'hard-block' : 'none',
      gate: gate.snapshot(instantMs),
      /** 活着的 root agent 与各自的简报状态。 */
      liveSessions: [...liveAgents.keys()],
      briefs: [...state.briefs.entries()].map(([sessionId, record]) => ({
        sessionId,
        objective: record.brief?.objective ?? null,
        resumable: record.brief?.resumable ?? null,
        degraded: record.meta?.degraded === true,
        filePath: record.filePath ?? null,
        generatedAt: toIso(record.generatedAt),
        reconciled: record.reconciled === true,
      })),
      /** 每个会话当前的峰谷周期：是否已简报 / 是否已解除续跑 / 是否已恢复。 */
      cycles: [...state.cycles.entries()].map(([sessionId, cycle]) => ({
        sessionId,
        peakStartAt: toIso(cycle.peakStartAt),
        briefed: cycle.briefed === true,
        resumed: cycle.resumed === true,
        disarmAttempted: cycle.disarm?.attempted === true,
        disarmReason: cycle.disarm?.reason ?? null,
        briefPath: cycle.briefPath ?? null,
      })),
      clockOverridden: clockOverrideMs !== null,
      tickCount,
      /** 斜杠命令注册结果（服务不可用时如实报告，而不是假装成功）。 */
      commands: commandRegistration,
      /** 设置命名空间注册结果（设置页的数据来源）。 */
      settings: settingsInfo,
      bundledYears: calendar.bundledYears,
      runtimeYears: calendar.runtimeYears,
      invalidOverrides: calendar.invalidOverrides,
    }
  }

  function publicState(instantMs) {
    return {
      plugin: PLUGIN_ID,
      build: BUILD,
      phase: STAGE,
      now: new Date(instantMs).toISOString(),
      config,
      seq: state.seq,
      notice: state.notice,
      status: statusAt(instantMs),
    }
  }

  // 挂载时推一条真实相位，让横幅立刻能反映当前日历判定。
  {
    const view = windows.describe(now())
    const day = calendar.describe(view.localDate)
    pushNotice(
      'info',
      `${PLUGIN_ID} 已挂载（${STAGE}）\n`
      + `当前：${view.localDate} ${view.localTime} · ${day.label} · 相位 ${view.phase}\n`
      + `门控：${config.enabled === true ? (config.gateMode === 'hard' ? '硬拦已启用' : `gateMode=${config.gateMode}`) : '未启用（enabled=false，不拦任何请求）'}\n`
      + `下次切换：${view.nextSwitch === null ? '无' : `${view.nextSwitch.date} → ${view.nextSwitch.to}`}`,
    )
  }

  const routes = {
    [`${BASE}.state`]: (req, res) => {
      if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
        return
      }
      // ?at=<RFC3339> 可以查询任意瞬间的判定，用于演练与排障。
      const query = new URL(req.url ?? '/', 'http://localhost').searchParams
      const atRaw = query.get('at')
      let instantMs = now()
      if (atRaw !== null && atRaw !== '') {
        const parsed = Date.parse(atRaw)
        if (Number.isNaN(parsed)) {
          sendJson(res, 400, { ok: false, error: 'bad_at', detail: `无法解析 at=${atRaw}` })
          return
        }
        instantMs = parsed
      }
      sendJson(res, 200, { ok: true, state: publicState(instantMs) })
    },

    [`${BASE}.dismiss`]: async (req, res) => {
      if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
        return
      }
      const body = await readBody(req)
      const seq = Number(body?.seq)
      // 只关掉客户端正在显示的那一条：晚到的 dismiss 不应该抹掉更新的通知。
      if (state.notice !== null && Number.isFinite(seq) && state.notice.seq === seq) {
        state.notice = null
      }
      sendJson(res, 200, { ok: true, state: publicState(now()) })
    },

    // 逃生窗口：本次放行。POST { minutes?, note? }；minutes 缺省 30。
    [`${BASE}.allow`]: async (req, res) => {
      if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
        return
      }
      const body = await readBody(req)
      const rawMinutes = body?.minutes
      const minutes = rawMinutes === undefined || rawMinutes === null ? DEFAULT_ALLOW_MINUTES : Number(rawMinutes)
      if (!Number.isFinite(minutes) || minutes <= 0) {
        sendJson(res, 400, { ok: false, error: 'bad_minutes', detail: 'minutes 必须是正数' })
        return
      }
      const note = typeof body?.note === 'string' && body.note !== '' ? body.note : null
      const allow = gate.allowFor(minutes, now(), note)
      pushNotice('info', `已放行本次高峰：${Math.round(minutes)} 分钟内不再拦截（实际到 ${allow.until}）。`)
      sendJson(res, 200, { ok: true, allow, state: publicState(now()) })
    },

    // 关闭逃生窗口，立即恢复拦截。
    [`${BASE}.allow-off`]: async (req, res) => {
      if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
        return
      }
      gate.clearAllow()
      sendJson(res, 200, { ok: true, allow: gate.allowStatus(now()), state: publicState(now()) })
    },

    /**
     * 立刻对某个会话跑一次简报生成（手动入口；周期调度也会在 T-lead 自动调用）。
     * POST { sessionId? }——省略 sessionId 时，只有一个活会话才自动选中。
     */
    [`${BASE}.brief`]: async (req, res) => {
      if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
        return
      }
      const body = await readBody(req)
      const wanted = typeof body?.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : null

      let agent
      if (wanted !== null) agent = liveAgents.get(wanted)
      else if (liveAgents.size === 1) agent = [...liveAgents.values()][0]
      else if (liveAgents.size === 0) {
        sendJson(res, 409, { ok: false, error: 'no_live_agent', detail: '当前没有活着的 root agent' })
        return
      } else {
        sendJson(res, 409, {
          ok: false,
          error: 'ambiguous_session',
          detail: `有 ${liveAgents.size} 个活会话，请显式指定 sessionId`,
          sessions: [...liveAgents.keys()],
        })
        return
      }

      if (agent === undefined) {
        sendJson(res, 404, { ok: false, error: 'unknown_session', detail: `没有找到会话 ${wanted}` })
        return
      }

      const outcome = await runBriefing(agent)
      if (outcome.ok !== true) {
        sendJson(res, 500, { ok: false, error: outcome.error.code, detail: outcome.error.message })
        return
      }
      sendJson(res, 200, outcome)
    },

    /**
     * 手动推进一次周期检查（演练与排障用）。
     * POST { at? }——给了 at 就先把这个瞬间装进时钟覆盖，再跑一次 tick，
     * 这样不必真等到明早 8:50 就能把 T-10 / T-0 / 闲时三个动作走一遍。
     */
    [`${BASE}.debug-tick`]: async (req, res) => {
      if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
        return
      }
      const body = await readBody(req)
      if (body?.at !== undefined && body.at !== null && body.at !== '') {
        const parsed = Date.parse(String(body.at))
        if (Number.isNaN(parsed)) {
          sendJson(res, 400, { ok: false, error: 'bad_at', detail: `无法解析 at=${String(body.at)}` })
          return
        }
        clockOverrideMs = parsed
      }
      const tick = await runTick('debug')
      sendJson(res, 200, { ok: true, tick, clockOverrideMs, state: publicState(now()) })
    },

    /** 装 / 卸时钟覆盖。POST { at } 装入；POST { clear: true } 卸下。 */
    [`${BASE}.debug-clock`]: async (req, res) => {
      if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
        return
      }
      const body = await readBody(req)
      if (body?.clear === true) {
        clockOverrideMs = null
      } else {
        const parsed = Date.parse(String(body?.at ?? ''))
        if (Number.isNaN(parsed)) {
          sendJson(res, 400, { ok: false, error: 'bad_at', detail: '需要 at 或 clear:true' })
          return
        }
        clockOverrideMs = parsed
      }
      const nextTickInMs = scheduleTick()
      sendJson(res, 200, {
        ok: true,
        clockOverrideMs,
        overridden: clockOverrideMs !== null,
        nextTickInMs,
        state: publicState(now()),
      })
    },

    /**
     * 手动触发一次节假日联网刷新。POST { years?: number[] }
     * 失败只影响那一年（继续用内置兜底表），永远不返回 5xx。
     */
    [`${BASE}.refresh-holidays`]: async (req, res) => {
      if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
        return
      }
      const body = await readBody(req)
      const years = Array.isArray(body?.years) ? body.years.map(Number) : undefined
      const outcome = await refreshHolidays({ years, reason: 'manual' })
      sendJson(res, 200, {
        ok: true,
        ...outcome,
        runtimeYears: calendar.runtimeYears,
        bundledYears: calendar.bundledYears,
      })
    },

    // 自检：手动推一条通知，验证 Host→Client 通路可重复工作。
    [`${BASE}.hello`]: async (req, res) => {
      if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method_not_allowed' })
        return
      }
      const body = await readBody(req)
      const text = typeof body?.text === 'string' && body.text !== ''
        ? body.text
        : `通路自检 · ${new Date().toLocaleTimeString('zh-CN')}`
      const notice = pushNotice('info', text)
      sendJson(res, 200, { ok: true, notice })
    },
  }

  ctx.effect(() => {
    const disposers = Object.entries(routes).map(([path, handler]) =>
      ctx.webServer.register({
        path,
        handler: (req, res) => {
          // 必须 return：否则异步 handler 的完成对调用方不可见（也为可测试性）。
          return Promise.resolve()
            .then(() => handler(req, res))
            .catch((error) => {
              try {
                sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
              } catch {
                /* 响应已经发出 */
              }
            })
        },
      }),
    )
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 已经注销 */
        }
      }
    }
  }, 'peak-brief: /api/peak-brief.* routes')

  // 周期调度。默认 enabled=false → 一个定时器都不排，插件完全惰性。
  ctx.effect(() => {
    if (config.enabled !== true) return undefined
    scheduleTick()
    return () => {
      if (tickTimer !== null) {
        clearTimeout(tickTimer)
        tickTimer = null
      }
    }
  }, 'peak-brief: peak/off-peak cycle timer')

  // 可选的启动期节假日刷新。默认关闭；关闭时这里什么都不做。
  ctx.effect(() => {
    if (config.holidayRefresh?.enabled !== true) return undefined
    if (config.holidayRefresh?.onStart === false) return undefined
    void refreshHolidays({ reason: 'startup' }).then((outcome) => {
      const loaded = (outcome?.results ?? []).filter((r) => r.ok === true && r.reason !== 'already-loaded')
      if (loaded.length > 0) {
        ctx.logger?.info?.(
          `${PLUGIN_ID} 节假日联网刷新完成：${loaded.map((r) => `${r.year}(假 ${r.holidays} / 调休 ${r.workdays})`).join(' ')}`,
        )
      } else if (outcome?.skipped === undefined) {
        ctx.logger?.warn?.(`${PLUGIN_ID} 节假日联网刷新未取得任何数据，继续使用内置兜底表`)
      }
    })
    return undefined
  }, 'peak-brief: optional holiday refresh')

  const view = windows.describe(now())
  ctx.logger?.info?.(
    `${PLUGIN_ID} 已挂载（${STAGE}）· 时区 ${config.timezone} · 相位 ${view.phase}`
    + ` · 门控 ${config.enabled === true && config.gateMode === 'hard' ? '已启用' : '未启用'} · 路由前缀 ${BASE}`,
  )
}

export default { name, inject, apply }
