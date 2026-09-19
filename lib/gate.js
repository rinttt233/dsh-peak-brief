/**
 * 门控 —— 高峰期间拦截模型请求，并管理"本次放行"逃生窗口。
 *
 * 本模块是纯决策逻辑：它不认识 cordis，也不自己发请求。真正的接线在
 * lib/index.js 里通过 `ctx.on('llm/stream', ...)` 完成。
 *
 * 拦截失败时返回的是一个**终止 finish chunk**：
 *
 *   { type: 'finish', reason: { kind: 'error', failure: { message, code } } }
 *
 * 形状取自 dsh-llm 的 StreamChunk 协议（适配器发射 usage 之后是终止 finish，
 * 其后不得再有 chunk）。用 `error` 而不是 `aborted`：aborted 语义是"被取消"，
 * 会让界面看起来像是用户自己中断的，而这里是策略拒绝，必须说清原因。
 *
 * code 用自定义值 `PEAK_BRIEF_BLOCKED`，刻意避开 dsh-llm 的可重试集合
 * （EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT）——
 * 否则 dsh-llm-retry 会不停重试一个必然再次被拦的请求。
 */

import { PHASE } from './windows.js'

/** 稳定、不可重试的拦截码。 */
export const GATE_CODE = 'PEAK_BRIEF_BLOCKED'

/** 逃生窗口的默认时长（分钟）。 */
export const DEFAULT_ALLOW_MINUTES = 30

/**
 * @param windows - createWindows() 的产物
 * @param config  - 插件配置（读 enabled / gateMode / blockAuxiliary）
 */
export function createGate({ windows, config }) {
  if (windows === undefined || windows === null) throw new TypeError('gate: 需要 windows')

  /**
   * 「自己人」标记。P3 生成简报时，我们自己的模型调用不能被自己拦掉
   * （尤其在提前量很长、简报生成刚好跨过高峰起点的情形）。
   * GenerateOptions 在派发前会被深冻结，所以不能往上挂字段——用对象身份记。
   */
  const owned = new WeakSet()

  /** 逃生窗口的截止时刻；null 表示没有。 */
  let allowUntilMs = null
  /** 逃生窗口是谁开的、为什么，仅用于展示。 */
  let allowNote = null

  let blockedCount = 0
  let lastBlockedAt = null

  function markOwn(options) {
    if (options !== null && typeof options === 'object') owned.add(options)
    return options
  }

  function allowStatus(nowMs) {
    if (allowUntilMs === null) return { active: false, until: null, remainingMs: 0, note: null }
    if (nowMs >= allowUntilMs) {
      allowUntilMs = null
      allowNote = null
      return { active: false, until: null, remainingMs: 0, note: null }
    }
    return {
      active: true,
      until: new Date(allowUntilMs).toISOString(),
      remainingMs: allowUntilMs - nowMs,
      note: allowNote,
    }
  }

  /**
   * 开一个逃生窗口。
   *
   * 正在高峰时，窗口**不会超过本段高峰的结束时刻**——"本次放行"的语义是
   * 放过这一段，而不是把整个下午的高峰都放过。
   */
  function allowFor(minutes, nowMs, note = null) {
    const requested = Number(minutes)
    const span = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_ALLOW_MINUTES
    const wanted = nowMs + span * 60000

    let until = wanted
    if (windows.phaseAt(nowMs) === PHASE.PEAK) {
      const next = windows.nextSwitchAt(nowMs)
      if (next !== null && next.to === PHASE.OFF) until = Math.min(wanted, next.at)
    }

    allowUntilMs = Math.max(nowMs, until)
    allowNote = note
    return allowStatus(nowMs)
  }

  function clearAllow() {
    allowUntilMs = null
    allowNote = null
  }

  /** 拦截时给用户看的话——必须说清"为什么"和"怎么放行"。 */
  function blockMessage(nowMs) {
    const view = windows.describe(nowMs)
    const next = view.nextSwitch === null ? '未知' : `${view.nextSwitch.date} ${view.nextSwitch.to}`
    return [
      `已拦截本次模型请求：当前处于 DeepSeek 高峰计价时段（${view.localDate} ${view.localTime}，${view.dayLabel}）。`,
      `本次不发送请求即不产生费用。下次切换：${next}。`,
      `需要现在就继续：调用 /peak-allow ${DEFAULT_ALLOW_MINUTES}（或 POST /api/peak-brief.allow）。`,
    ].join('\n')
  }

  /**
   * 判定一次模型请求是否该拦。
   * @returns { block, reason, code?, message? }
   */
  function decide(nowMs, options) {
    if (config.enabled !== true) return { block: false, reason: 'disabled' }
    if (config.gateMode !== 'hard') return { block: false, reason: 'gate-not-hard' }
    if (options !== undefined && options !== null && owned.has(options)) {
      return { block: false, reason: 'own-call' }
    }

    const allow = allowStatus(nowMs)
    if (allow.active) return { block: false, reason: 'allow-once' }

    const phase = windows.phaseAt(nowMs)
    if (phase !== PHASE.PEAK) return { block: false, reason: `phase-${phase}` }

    // 真实请求里 purpose 只会是 'compaction' | 'session-title' 或 undefined。
    if (config.blockAuxiliary !== true && typeof options?.purpose === 'string') {
      return { block: false, reason: `auxiliary-${options.purpose}` }
    }

    blockedCount += 1
    lastBlockedAt = nowMs
    return {
      block: true,
      reason: 'peak',
      code: GATE_CODE,
      message: blockMessage(nowMs),
    }
  }

  /** 构造被拦截请求的终止 chunk 序列。 */
  function blockedChunks(decision) {
    return [{
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: decision.message, code: decision.code ?? GATE_CODE },
      },
    }]
  }

  /** 把一次拦截包成异步可迭代的 chunk 流（waterfall 监听器要返回它）。 */
  function blockedStream(decision) {
    const chunks = blockedChunks(decision)
    return (async function* blocked() {
      for (const chunk of chunks) yield chunk
    })()
  }

  function snapshot(nowMs) {
    return {
      enabled: config.enabled === true,
      gateMode: config.gateMode,
      blockAuxiliary: config.blockAuxiliary === true,
      code: GATE_CODE,
      blocking: config.enabled === true && config.gateMode === 'hard' && windows.phaseAt(nowMs) === PHASE.PEAK,
      allow: allowStatus(nowMs),
      blockedCount,
      lastBlockedAt: lastBlockedAt === null ? null : new Date(lastBlockedAt).toISOString(),
    }
  }

  return { decide, blockedStream, blockedChunks, markOwn, allowFor, clearAllow, allowStatus, snapshot, owned }
}
