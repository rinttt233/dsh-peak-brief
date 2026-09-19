/**
 * dsh-peak-brief 验收脚本 —— 对着**真实的** lib/index.js 逐条核验 8 条验收标准。
 *
 * 完全离线：用假 ctx / 假 agent / 假 llm 驱动真实插件代码，并用插件自带的
 * 时钟覆盖（debug-clock）把一整天压缩进几毫秒——不必等到明早 8:50。
 *
 *   node scripts/acceptance.mjs
 *
 * 退出码 0 = 全部通过。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
import { briefPathFor, writeBriefFile } from '../lib/brief-store.js'
import { GATE_CODE } from '../lib/gate.js'

// ------------------------------------------------------------------ 测试夹具

function makeCtx(services = {}) {
  const routes = new Map()
  const listeners = new Map()
  const logs = []
  const ctx = {
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    effect: (fn) => fn(),
    on: (event, handler) => {
      listeners.set(event, [...(listeners.get(event) ?? []), handler])
    },
    /** 模型 cordis 的可选依赖注入：依赖齐了才跑回调。 */
    inject: (deps, callback) => {
      if (deps.every((dep) => ctx[dep] !== undefined && ctx[dep] !== null)) callback(ctx)
      return { dispose() {} }
    },
    webServer: {
      register: ({ path, handler }) => {
        routes.set(path, handler)
        return () => routes.delete(path)
      },
    },
    ...services,
  }
  return { ctx, routes, listeners, logs }
}

async function call(routes, path, { method = 'GET', body } = {}) {
  const res = {
    statusCode: 0,
    setHeader() {},
    end(text) { this.body = text ?? '' },
  }
  const req = {
    method,
    url: path,
    on(event, cb) {
      if (event === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)))
      if (event === 'end') cb()
    },
  }
  await routes.get(path.split('?')[0])(req, res)
  return { status: res.statusCode, json: res.body === '' ? null : JSON.parse(res.body) }
}

/** 跑一次 llm/stream 监听器，报告下游是否被调用、返回了什么 chunk。 */
async function runStream(listeners, options = { provider: 'p', model: 'm', messages: [] }) {
  const listener = (listeners.get('llm/stream') ?? [])[0]
  assert.ok(listener, 'llm/stream 监听器未注册')
  let nextCalled = 0
  const chunks = []
  for await (const chunk of listener(options, () => {
    nextCalled += 1
    return (async function* downstream() { yield { type: 'finish', reason: { kind: 'stop' } } })()
  })) chunks.push(chunk)
  return { nextCalled, chunks, blocked: nextCalled === 0 }
}

function makeGoals(over = {}) {
  const state = { phase: 'active', activation: 'armed', revision: 3, disarmed: 0, resumed: 0, ...over }
  return {
    state,
    get: () => ({
      id: 'goal-1', revision: state.revision, objective: '把 dsh-peak-brief 做完',
      phase: state.phase, activation: state.activation, roundsStarted: 1, maxGoalRounds: 40,
    }),
    disarm() { state.disarmed += 1; state.activation = 'disarmed'; return this.get() },
    resume() { state.resumed += 1; state.activation = 'armed'; state.revision += 1; return this.get() },
  }
}

function makeAgent(sessionId, messages = [{ role: 'user', content: [{ type: 'text', text: '把 P4 做完' }] }]) {
  const spy = { injected: [], followedUp: [] }
  return {
    spy,
    agent: {
      session: {
        id: sessionId,
        deriveMessages: () => messages,
        requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
      },
      inject: (m) => spy.injected.push(m),
      followup: (m) => spy.followedUp.push(m),
    },
  }
}

function fakeLlm(payload) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      return (async function* run() {
        yield { type: 'text-delta', index: 0, text: typeof payload === 'string' ? payload : JSON.stringify(payload) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

/** 假命令注册表：记录 spec，便于直接调用 handler。 */
function makeCommands() {
  const registered = new Map()
  return {
    registered,
    register(spec) {
      registered.set(spec.name, spec)
      return () => registered.delete(spec.name)
    },
  }
}

const BRIEF_OK = {
  objective: '把 dsh-peak-brief 的 P5 做完',
  status: 'in_progress',
  resumable: true,
  done: ['P0-P4'],
  remaining: ['P5 验收'],
  next_actions: ['跑验收脚本'],
  files: ['lib/index.js'],
  blockers: [],
  notes: '',
}

/** 与集成测试同一套时区基准：把"今天"当作可控的普通工作日。 */
function todayInShanghai() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  })
  const p = Object.fromEntries(fmt.formatToParts(new Date()).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}`
}

const TODAY = todayInShanghai()
const B = (hms) => `${TODAY}T${hms}+08:00`

// ------------------------------------------------------------------ 报告框架

const results = []
let dir = null

async function criterion(id, title, fn) {
  const notes = []
  const record = (text) => notes.push(text)
  try {
    await fn(record)
    results.push({ id, title, ok: true, notes })
    process.stdout.write(`  [${id}] ${title} ... \x1b[32mPASS\x1b[0m\n`)
  } catch (error) {
    results.push({ id, title, ok: false, notes, error })
    process.stdout.write(`  [${id}] ${title} ... \x1b[31mFAIL\x1b[0m  ${error?.message ?? error}\n`)
  }
  for (const note of notes) process.stdout.write(`        · ${note}\n`)
}

function boot(config, services) {
  const { ctx, routes, listeners, logs } = makeCtx(services)
  apply(ctx, config)
  return { ctx, routes, listeners, logs }
}

const tick = (routes, at) => call(routes, '/api/peak-brief.debug-tick', { method: 'POST', body: at === undefined ? {} : { at } })
const statusAt = async (routes, at) => (await call(routes, `/api/peak-brief.state?at=${encodeURIComponent(at)}`)).json.state.status

// ------------------------------------------------------------------ 开始

process.stdout.write('\n=== dsh-peak-brief 验收（离线推演，真实插件代码）===\n')
process.stdout.write(`基准日期（Asia/Shanghai）：${TODAY}\n\n`)
dir = mkdtempSync(join(tmpdir(), 'peak-brief-accept-'))

const PEAK_CONFIG = {
  enabled: true,
  overrides: { [TODAY]: 'peak' },
  peakWindows: [['09:00', '12:00'], ['14:00', '18:00']],
  leadMinutes: 10,
  brief: { dir },
}

// ---- 标准 1 ----
await criterion(1, 'T-10：无活跃任务零动作；有则生成简报并停自动续跑', async (note) => {
  const llm = fakeLlm(BRIEF_OK)
  const goals = makeGoals()
  const idle = boot({ ...PEAK_CONFIG, brief: { dir: mkdtempSync(join(tmpdir(), 'acc-idle-')) } }, { llm, goals })
  const idleTick = await tick(idle.routes, B('08:50:00'))
  assert.deepEqual(idleTick.json.tick.actions, [], '没有活跃会话时不该有任何动作')
  assert.equal(llm.calls.length, 0, '没有活就不该调模型')
  note('无活跃任务：0 个动作、0 次模型调用')

  const { agent, spy } = makeAgent('acc-1')
  for (const l of idle.listeners.get('agent/created') ?? []) l({ agent })

  const lead = await tick(idle.routes, B('08:50:00'))
  assert.equal(lead.json.tick.actions[0].action, 'brief')
  assert.equal(lead.json.tick.actions[0].disarm.attempted, true)
  assert.equal(goals.state.disarmed, 1)
  assert.equal(llm.calls.length, 1)

  const path = lead.json.state.status.cycles[0].briefPath
  assert.equal(existsSync(path), true)
  note(`有活跃任务：生成简报 → ${path}`)
  note('自动续跑：已 disarm（持久相位不变）')
  assert.equal(spy.followedUp.length, 0, 'T-10 不该起新一轮')
})

// ---- 标准 2 ----
await criterion(2, 'T-0 硬拦；/peak-allow 逃生放行且到期自动收回', async (note) => {
  const llm = fakeLlm(BRIEF_OK)
  const goals = makeGoals()
  const commands = makeCommands()
  const { routes, listeners } = boot(PEAK_CONFIG, { llm, goals, commands })
  const { agent } = makeAgent('acc-2')
  for (const l of listeners.get('agent/created') ?? []) l({ agent })

  await tick(routes, B('08:50:00'))
  await tick(routes, B('09:00:00'))

  const blocked = await runStream(listeners)
  assert.equal(blocked.blocked, true, '高峰必须拦')
  assert.equal(blocked.chunks[0].reason.kind, 'error')
  assert.equal(blocked.chunks[0].reason.failure.code, GATE_CODE)
  note(`拦截码 ${GATE_CODE}，终止原因 error（非 aborted）`)

  // 逃生走 objective 指定的斜杠命令
  assert.ok(commands.registered.has('peak-allow'), '/peak-allow 必须已注册')
  const bad = await commands.registered.get('peak-allow').handler({ rawInput: '十分钟' })
  assert.equal(bad.kind, 'error', '非法参数必须被拒并给出用法')
  const slash = await commands.registered.get('peak-allow').handler({ rawInput: '30' })
  assert.equal(slash.kind, 'success')
  assert.equal((await runStream(listeners)).blocked, false, '放行后必须通过')
  note(`斜杠命令 /peak-allow 30 → ${slash.text}`)

  await tick(routes, B('09:31:00'))
  assert.equal((await runStream(listeners)).blocked, true, '到期必须自动收回')
  note('09:31 到期后已自动恢复拦截')

  // HTTP 路由是等价入口，同样能用
  const http = await call(routes, '/api/peak-brief.allow', { method: 'POST', body: { minutes: 5 } })
  assert.equal(http.status, 200)
  assert.equal((await runStream(listeners)).blocked, false)
  note('HTTP /api/peak-brief.allow 亦可放行（等价入口）')
})

// ---- 标准 3 ----
await criterion(3, '闲时：解拦 + 注入简报 + 起一轮继续 + 文件消失', async (note) => {
  const llm = fakeLlm(BRIEF_OK)
  const goals = makeGoals()
  const { routes, listeners } = boot(PEAK_CONFIG, { llm, goals })
  const { agent, spy } = makeAgent('acc-3')
  for (const l of listeners.get('agent/created') ?? []) l({ agent })

  await tick(routes, B('08:50:00'))
  const path = briefPathFor(dir, 'acc-3')
  assert.equal(existsSync(path), true)

  await tick(routes, B('09:30:00'))
  assert.equal((await runStream(listeners)).blocked, true)

  const resume = await tick(routes, B('12:00:00'))
  const action = resume.json.tick.actions[0]
  assert.equal(action.action, 'resume')
  assert.equal(spy.injected.length, 1, '必须 inject')
  assert.equal(spy.followedUp.length, 1, '必须 followup')
  assert.equal(action.goalResumed, true, '目标必须重新武装')
  assert.equal(action.fileDeleted, true, '简报文件必须删除')
  assert.equal(existsSync(path), false)
  assert.match(spy.followedUp[0].content[0].text, /\[PEAK-BRIEF RESUME\]/)

  assert.equal((await runStream(listeners)).blocked, false, '闲时必须放行')
  note('inject(notice) + followup(完整简报) + 目标 resume + 文件已删')
  note('闲时模型请求已放行')
})

// ---- 标准 4 ----
await criterion(4, '调休上班日：全天不产生任何拦截', async (note) => {
  const { routes, listeners } = boot({ enabled: true, brief: { dir } }, { llm: fakeLlm(BRIEF_OK), goals: makeGoals() })
  const makeups = ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10']
  for (const date of makeups) {
    for (const time of ['09:30', '10:00', '14:30', '17:00']) {
      const status = await statusAt(routes, `${date}T${time}:00+08:00`)
      assert.equal(status.phase, 'off', `${date} ${time} 应为闲时`)
      assert.equal(status.dayKind, 'makeup-workday')
    }
    await call(routes, '/api/peak-brief.debug-clock', { method: 'POST', body: { at: `${date}T10:00:00+08:00` } })
    assert.equal((await runStream(listeners)).blocked, false, `${date} 不该拦`)
  }
  await call(routes, '/api/peak-brief.debug-clock', { method: 'POST', body: { clear: true } })
  note(`核验 2026 年全部 ${makeups.length} 个调休上班日 × 4 个时刻`)
})

// ---- 标准 5 ----
await criterion(5, '法定节假日：全天不产生任何拦截', async (note) => {
  const { routes, listeners } = boot({ enabled: true, brief: { dir } }, { llm: fakeLlm(BRIEF_OK), goals: makeGoals() })
  const holidays = ['2026-01-01', '2026-02-17', '2026-04-05', '2026-05-03', '2026-06-20', '2026-09-26', '2026-10-03']
  for (const date of holidays) {
    const status = await statusAt(routes, `${date}T10:00:00+08:00`)
    assert.equal(status.dayKind, 'holiday', `${date} 应为法定节假日`)
    assert.equal(status.phase, 'off')
    await call(routes, '/api/peak-brief.debug-clock', { method: 'POST', body: { at: `${date}T10:00:00+08:00` } })
    assert.equal((await runStream(listeners)).blocked, false, `${date} 不该拦`)
  }
  await call(routes, '/api/peak-brief.debug-clock', { method: 'POST', body: { clear: true } })
  note(`核验元旦/春节/清明/劳动/端午/中秋/国庆各一天，均全天闲时`)
})

// ---- 标准 6 ----
await criterion(6, '未知年份：不崩，按周一至周五生效', async (note) => {
  const { routes } = boot({ enabled: true, brief: { dir } }, { llm: fakeLlm(BRIEF_OK), goals: makeGoals() })
  const wed = await statusAt(routes, '2027-03-10T10:00:00+08:00')
  assert.equal(wed.dayKind, 'unknown-year')
  assert.equal(wed.peakDay, true)
  assert.equal(wed.phase, 'peak')

  const sat = await statusAt(routes, '2027-03-13T10:00:00+08:00')
  assert.equal(sat.peakDay, false)
  assert.equal(sat.phase, 'off')
  note('2027 周三 → peak；2027 周六 → off；接口未报错')
})

// ---- 标准 7 ----
await criterion(7, '同一高峰段内不重复生成简报', async (note) => {
  const llm = fakeLlm(BRIEF_OK)
  const goals = makeGoals()
  const { routes, listeners } = boot(PEAK_CONFIG, { llm, goals })
  const { agent } = makeAgent('acc-7')
  for (const l of listeners.get('agent/created') ?? []) l({ agent })

  await tick(routes, B('08:50:00'))
  for (const at of ['08:51:00', '08:55:00', '08:59:00']) {
    const again = await tick(routes, B(at))
    assert.equal(again.json.tick.actions[0].reason, 'already-briefed', `${at} 不该重复简报`)
  }
  assert.equal(llm.calls.length, 1, '只能调一次模型')
  assert.equal(goals.state.disarmed, 1, '只能 disarm 一次')
  note('08:50 之后连续 3 次 tick：均为 already-briefed；模型 1 次、disarm 1 次')
})

// ---- 标准 8 ----
await criterion(8, '重启后对账：不会卡在暂停，也不会把过期任务拉起来', async (note) => {
  const recoverDir = mkdtempSync(join(tmpdir(), 'acc-recover-'))
  try {
    // 模拟上一次进程留下的"待恢复"简报
    writeBriefFile(recoverDir, 'acc-8', {
      brief: { objective: '重启前未完成的任务', status: 'in_progress', resumable: true },
      meta: {
        peakStartAt: Date.parse(B(`${'09:00:00'}`)),
        disarm: { attempted: true, reason: 'disarmed', wasArmed: true },
      },
    })

    const goals = makeGoals()
    const { routes, listeners } = boot(
      { ...PEAK_CONFIG, brief: { dir: recoverDir } },
      { llm: fakeLlm(BRIEF_OK), goals },
    )
    const { agent, spy } = makeAgent('acc-8')
    for (const l of listeners.get('agent/created') ?? []) l({ agent })

    const status = (await call(routes, '/api/peak-brief.state')).json.state.status
    assert.equal(status.cycles.length, 1, '必须从磁盘认领待恢复的周期')
    assert.equal(status.cycles[0].disarmAttempted, true, 'disarm 记录必须恢复')

    const resume = await tick(routes, B('12:00:00'))
    assert.equal(resume.json.tick.actions[0].action, 'resume')
    assert.equal(spy.followedUp.length, 1)
    assert.equal(goals.state.resumed, 1)
    note('重启后：认领待恢复周期 → 闲时交回简报 → 目标重新武装')

    // 过期简报不认领
    const staleDir = mkdtempSync(join(tmpdir(), 'acc-stale-'))
    writeFileSync(briefPathFor(staleDir, 'acc-old'), JSON.stringify({
      version: 1,
      plugin: 'dsh-peak-brief',
      writtenAt: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(),
      brief: { objective: '三天前', status: 'in_progress', resumable: true },
      meta: { peakStartAt: 0, disarm: { attempted: true, wasArmed: true } },
    }), 'utf8')
    const stale = boot({ ...PEAK_CONFIG, brief: { dir: staleDir } }, { llm: fakeLlm(BRIEF_OK), goals: makeGoals() })
    const { agent: staleAgent, spy: staleSpy } = makeAgent('acc-old')
    for (const l of stale.listeners.get('agent/created') ?? []) l({ agent: staleAgent })
    assert.equal((await call(stale.routes, '/api/peak-brief.state')).json.state.status.cycles.length, 0)
    await tick(stale.routes, B('12:00:00'))
    assert.equal(staleSpy.followedUp.length, 0)
    note('3 天前的简报不认领，不会把旧任务拉起来')
    rmSync(staleDir, { recursive: true, force: true })
  } finally {
    rmSync(recoverDir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ 汇总

rmSync(dir, { recursive: true, force: true })

const passed = results.filter((r) => r.ok).length
process.stdout.write(`\n${passed}/${results.length} 通过\n`)
if (passed !== results.length) {
  process.stdout.write('\n失败项：\n')
  for (const r of results.filter((x) => x.ok !== true)) {
    process.stdout.write(`  [${r.id}] ${r.title}\n    ${r.error?.message ?? ''}\n`)
  }
  process.exitCode = 1
} else {
  process.stdout.write('全部验收标准通过（离线推演）。\n')
}
