/**
 * 恢复 —— 高峰结束时把简报交回给 AI 并让它继续干活。
 *
 * 两个机制各自的位置（依据 dsh-agent 的类型文档）：
 *
 *   agent.inject(msg)    只把上下文塞进下一次 pre-step，**不唤醒**驱动。
 *                        空闲驱动会一直挂着，直到 followup 唤醒它。
 *                        注意其文档明说可能"错过 pre-step 已认领的批次"。
 *   agent.followup(msg)  起一轮普通 follow-up 并唤醒驱动。
 *
 * 因此这里的分工是：**followup 携带完整简报**（保证一定送达），
 * inject 只带一条 ≤120 字的 notice（省 token，同时让界面有一行摘要）。
 * 把简报全押在 inject 上会在竞态下静默丢失，那等于活白交接了。
 *
 * 目标的处理用 `disarm()` 而不是 `pause()`：disarm 只解除**进程内的续跑授权**，
 * 不改持久相位与 revision —— 语义上"目标仍是 active，只是在高峰期间不自动跑"，
 * 而 pause 会把它记成"被暂停"，高峰结束后再 resume 就变成了两件事。
 */

import { buildUserMessage, renderBriefForResume, truncate } from './brief.js'

/** notice 形式的 summary 有长度上限（CONTEXT_SUMMARY_MAX_CHARS = 120）。 */
export const NOTICE_SUMMARY_MAX_CHARS = 120

/** 简报摘要：给界面看的一行，必须短。 */
export function briefNoticeSummary(brief) {
  if (brief === null || typeof brief !== 'object') return '高峰恢复简报已就绪'
  const objective = truncate(brief.objective ?? '', 80)
  const tail = brief.resumable === true ? '可继续' : '无可续工作'
  return truncate(`高峰前交接：${objective}（${tail}）`, NOTICE_SUMMARY_MAX_CHARS)
}

/** 构造 notice 形式的注入消息（只带摘要，不带正文）。 */
export function buildNoticeMessage(brief) {
  const message = buildUserMessage(briefNoticeSummary(brief))
  return {
    ...message,
    source: {
      kind: 'plugin',
      plugin: 'dsh-peak-brief',
      form: 'notice',
      summary: briefNoticeSummary(brief),
    },
  }
}

/**
 * 构造跟随消息：**完整简报正文**。
 * 这是恢复能否成功的关键载荷，所以走"一定送达"的 followup。
 */
export function buildResumeMessage(brief, meta = {}) {
  return buildUserMessage(buildResumeText(brief, meta))
}

/** 独立出来便于单测：恢复消息的正文。复用 brief.js 的渲染，避免两处漂移。 */
export function buildResumeText(brief, meta = {}) {
  // 简报缺失时按"可继续"处理并明确写出原因：一份丢失的简报不该被解读成
  // "任务已完成"，那会让恢复静默地什么也不做。
  const safe = brief ?? { objective: '（缺少简报，请据会话自行判断如何继续）', status: 'in_progress', resumable: true }
  const base = renderBriefForResume(safe, meta)
  const instruction = safe.resumable === true
    ? '请从中断处继续完成该任务。'
    : '简报表明该任务已完成或无需继续：不要重启它，只做必要确认后停下。'
  return `${base}\ninstruction: ${instruction}`
}

// ------------------------------------------------------------------ 目标授权

/**
 * 决定 T-10 是否要解除续跑授权。
 * @param goalView - ctx.goals.get(agent) 的返回值（可能 undefined）
 */
export function planDisarm(goalView) {
  if (goalView === undefined || goalView === null) {
    return { disarm: false, reason: 'no-goal' }
  }
  const phase = goalView.phase
  if (phase !== 'active') {
    // paused / blocked / complete 本来就不会自己跑，不归我们管
    return { disarm: false, reason: `phase-${phase}` }
  }
  if (goalView.activation !== 'armed') {
    return { disarm: false, reason: 'already-disarmed' }
  }
  return { disarm: true, reason: 'active-and-armed', phase }
}

/** 决定闲时是否要把目标重新武装。只有"我们 disarm 过、且它本来就是 armed"才恢复。 */
export function planResume(goalView, disarmRecord) {
  if (goalView === undefined || goalView === null) return { resume: false, reason: 'no-goal' }
  if (disarmRecord?.attempted !== true) return { resume: false, reason: 'we-did-not-disarm' }
  if (disarmRecord?.wasArmed !== true) return { resume: false, reason: 'was-not-armed' }
  if (goalView.phase !== 'active') return { resume: false, reason: `phase-${goalView.phase}` }
  if (goalView.maxGoalRounds !== undefined && goalView.roundsStarted >= goalView.maxGoalRounds) {
    return { resume: false, reason: 'round-budget-exhausted' }
  }
  return { resume: true, reason: 'rearm' }
}

// ------------------------------------------------------------------ 周期决策

/**
 * 定时器每次醒来时对**一个会话**的决策。纯函数，便于把整条链路离线测透。
 *
 * @param phase      - 当前相位
 * @param nextSwitch - windows.describe().nextSwitch
 * @param cycle      - 该会话的周期记录（可能为 null）
 * @param enabled    - config.enabled
 * @returns { action: 'none'|'brief'|'resume', reason, peakStartAt? }
 */
export function decideCycle({ phase, nextSwitch, cycle, enabled }) {
  if (enabled !== true) return { action: 'none', reason: 'disabled' }

  if (phase === 'lead') {
    const peakStartAt = nextSwitch !== null && nextSwitch !== undefined && nextSwitch.to === 'peak'
      ? nextSwitch.at
      : null
    if (peakStartAt === null) return { action: 'none', reason: 'no-peak-ahead' }
    if (cycle?.peakStartAt === peakStartAt && cycle.briefed === true) {
      return { action: 'none', reason: 'already-briefed' }
    }
    return { action: 'brief', reason: 'lead-approaching', peakStartAt }
  }

  if (phase === 'off') {
    if (cycle?.briefed === true && cycle.resumed !== true) {
      return { action: 'resume', reason: 'off-after-peak' }
    }
    return { action: 'none', reason: 'nothing-pending' }
  }

  // peak：门控本身按相位生效，定时器在这里无事可做
  return { action: 'none', reason: 'peak' }
}

/** 一个新的周期记录。 */
export function newCycle(peakStartAt) {
  return {
    peakStartAt,
    briefed: false,
    resumed: false,
    disarm: { attempted: false, reason: 'pending', wasArmed: false },
    briefPath: null,
  }
}
