import test from 'node:test'
import assert from 'node:assert/strict'

import {
  NOTICE_SUMMARY_MAX_CHARS,
  briefNoticeSummary,
  buildNoticeMessage,
  buildResumeMessage,
  buildResumeText,
  decideCycle,
  newCycle,
  planDisarm,
  planResume,
} from '../lib/resume.js'

const BRIEF = {
  objective: '把 dsh-peak-brief 的 P4 做完',
  status: 'in_progress',
  resumable: true,
  done: ['P0', 'P1', 'P2', 'P3'],
  remaining: ['P5'],
  next_actions: ['写推演脚本'],
  files: ['lib/resume.js'],
  blockers: [],
  notes: '零依赖',
}

const goal = (over = {}) => ({
  id: 'goal-1', revision: 3, objective: 'obj', phase: 'active',
  roundsStarted: 1, maxGoalRounds: 40, activation: 'armed', ...over,
})

test('briefNoticeSummary 必须有界（notice 的 summary 上限 120）', () => {
  const summary = briefNoticeSummary(BRIEF)
  assert.ok(summary.length <= NOTICE_SUMMARY_MAX_CHARS)
  assert.match(summary, /把 dsh-peak-brief 的 P4 做完/)
  assert.match(summary, /可继续/)

  const long = briefNoticeSummary({ objective: 'x'.repeat(500), resumable: false })
  assert.ok(long.length <= NOTICE_SUMMARY_MAX_CHARS)
  assert.match(long, /无可续工作/)

  assert.equal(briefNoticeSummary(null), '高峰恢复简报已就绪')
})

test('buildNoticeMessage 用 notice 形式，且不携带简报正文', () => {
  const message = buildNoticeMessage(BRIEF)
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'plugin')
  assert.equal(message.source.plugin, 'dsh-peak-brief')
  assert.equal(message.source.form, 'notice')
  assert.equal(message.source.summary, briefNoticeSummary(BRIEF))
  assert.equal(message.content[0].text, briefNoticeSummary(BRIEF), 'notice 只该带摘要，不带正文')
})

test('buildResumeText 携带完整简报，并按 resumable 给出不同指令', () => {
  const text = buildResumeText(BRIEF, { pausedAt: 'P', resumedAt: 'R' })
  assert.match(text, /^\[PEAK-BRIEF RESUME\]/)
  assert.match(text, /不是用户的新指令/)
  assert.match(text, /paused_at: P/)
  assert.match(text, /resumed_at: R/)
  assert.match(text, /请从中断处继续完成该任务/)

  const jsonLine = text.split('\n').find((l) => l.startsWith('brief_json: '))
  const payload = JSON.parse(jsonLine.slice('brief_json: '.length))
  assert.equal(payload.objective, BRIEF.objective)
  assert.deepEqual(payload.next_actions, ['写推演脚本'])

  const done = buildResumeText({ ...BRIEF, resumable: false, status: 'done' })
  assert.match(done, /不要重启它/)
  assert.equal(done.includes('请从中断处继续完成该任务'), false)
})

test('buildResumeMessage 返回可注入的消息形状，且能容忍缺失简报', () => {
  const message = buildResumeMessage(BRIEF, {})
  assert.equal(message.role, 'user')
  assert.equal(typeof message.id, 'string')
  assert.match(message.content[0].text, /\[PEAK-BRIEF RESUME\]/)

  const fallback = buildResumeMessage(null, {})
  assert.match(fallback.content[0].text, /缺少简报/, '简报丢失时必须说清，而不是当成"已完成"')
  assert.match(fallback.content[0].text, /请从中断处继续完成该任务/)

  const payloadLine = fallback.content[0].text.split('\n').find((l) => l.startsWith('brief_json: '))
  assert.equal(JSON.parse(payloadLine.slice('brief_json: '.length)).resumable, true)
})

test('planDisarm：只对 active + armed 的目标动手', () => {
  assert.deepEqual(planDisarm(undefined).disarm, false)
  assert.equal(planDisarm(undefined).reason, 'no-goal')
  assert.equal(planDisarm(null).reason, 'no-goal')

  assert.equal(planDisarm(goal()).disarm, true)
  assert.equal(planDisarm(goal()).reason, 'active-and-armed')

  assert.equal(planDisarm(goal({ activation: 'disarmed' })).disarm, false)
  assert.equal(planDisarm(goal({ activation: 'disarmed' })).reason, 'already-disarmed')

  for (const phase of ['paused', 'blocked', 'complete']) {
    assert.equal(planDisarm(goal({ phase })).disarm, false, `${phase} 本来就不会自己跑`)
    assert.equal(planDisarm(goal({ phase })).reason, `phase-${phase}`)
  }
})

test('planResume：只有"我们解除过、且它本来 armed"才恢复', () => {
  const ours = { attempted: true, wasArmed: true }

  assert.equal(planResume(goal(), ours).resume, true)

  assert.equal(planResume(goal(), { attempted: false, wasArmed: false }).reason, 'we-did-not-disarm')
  assert.equal(planResume(goal(), { attempted: true, wasArmed: false }).reason, 'was-not-armed')
  assert.equal(planResume(undefined, ours).reason, 'no-goal')
  assert.equal(planResume(goal({ phase: 'paused' }), ours).reason, 'phase-paused')
  assert.equal(
    planResume(goal({ roundsStarted: 40, maxGoalRounds: 40 }), ours).reason,
    'round-budget-exhausted',
    '预算用尽时 resume 会失败，必须提前识别',
  )
})

test('decideCycle：把一整天拆成 brief / resume / none', () => {
  const enabled = true
  const leadView = { phase: 'lead', nextSwitch: { at: 1000, to: 'peak', date: 'd' } }
  const offView = { phase: 'off', nextSwitch: { at: 2000, to: 'lead', date: 'd' } }
  const peakView = { phase: 'peak', nextSwitch: { at: 3000, to: 'off', date: 'd' } }

  // 未启用 → 一律不动
  assert.equal(decideCycle({ ...leadView, cycle: null, enabled: false }).reason, 'disabled')

  // lead：要简报
  const briefDecision = decideCycle({ ...leadView, cycle: null, enabled })
  assert.equal(briefDecision.action, 'brief')
  assert.equal(briefDecision.peakStartAt, 1000)

  // 同一个高峰起点已经简报过 → 不重复（接受标准 7）
  const done = newCycle(1000)
  done.briefed = true
  assert.equal(decideCycle({ ...leadView, cycle: done, enabled }).reason, 'already-briefed')

  // lead 但 nextSwitch 不是 peak（理论上不该发生）→ 不动
  assert.equal(
    decideCycle({ phase: 'lead', nextSwitch: { at: 1, to: 'off' }, cycle: null, enabled }).reason,
    'no-peak-ahead',
  )

  // off：有未恢复的周期 → 恢复
  assert.equal(decideCycle({ ...offView, cycle: done, enabled }).action, 'resume')

  const resumed = { ...done, resumed: true }
  assert.equal(decideCycle({ ...offView, cycle: resumed, enabled }).reason, 'nothing-pending')
  assert.equal(decideCycle({ ...offView, cycle: null, enabled }).reason, 'nothing-pending')

  // peak：门控本身按相位生效，定时器无事可做
  assert.equal(decideCycle({ ...peakView, cycle: done, enabled }).reason, 'peak')
})

test('newCycle 的初始形状', () => {
  const cycle = newCycle(1234)
  assert.equal(cycle.peakStartAt, 1234)
  assert.equal(cycle.briefed, false)
  assert.equal(cycle.resumed, false)
  assert.equal(cycle.disarm.attempted, false)
  assert.equal(cycle.briefPath, null)
})
