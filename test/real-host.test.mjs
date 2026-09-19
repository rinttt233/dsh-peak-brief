/**
 * 真实宿主测试 —— 用 **真实的 @deepseek-ai/cordis + 真实的 LlmRuntime** 装载本插件。
 *
 * 这一层补上的是之前所有测试都覆盖不到的假设：那些测试用的是手写的假 ctx，
 * 于是"插件在真实 cordis 下能否装载""真实的 llm/stream waterfall 会不会派发到
 * 我们的监听器""真实消费者能不能接受我们构造的终止 chunk"全都只是推断。
 *
 * 这里不需要启动 DSH、不碰任何 profile：只把 DSH 运行时里的 cordis 与 dsh-llm
 * 按绝对路径 import 进来，装一个 `stream` 的桩适配器，然后走 `runtime.stream()`——
 * 那就是真实代码路径（内部会 `ctx.waterfall(this, 'llm/stream', ...)`）。
 *
 * 找不到 DSH 运行时时整组跳过（可用 DSH_RUNTIME 指定）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import * as plugin from '../lib/index.js'

const RUNTIME = process.env.DSH_RUNTIME
  ?? 'D:/deepseekharness/actdsh-win-x64-0.1.5-rc.2/resources/dsh/runtime'
const NODE_MODULES = join(RUNTIME, 'node_modules', '@deepseek-ai')
const CORDIS = join(NODE_MODULES, 'cordis', 'lib', 'index.js')
const LLM = join(NODE_MODULES, 'dsh-llm', 'lib', 'index.js')
const SETTINGS_FILE = join(NODE_MODULES, 'dsh-settings-file', 'lib', 'index.js')

const available = existsSync(CORDIS) && existsSync(LLM)
const skip = available ? false : `找不到 DSH 运行时（${RUNTIME}）；设 DSH_RUNTIME 指向它`
const settingsAvailable = existsSync(SETTINGS_FILE)
const settingsSkip = settingsAvailable ? false : `找不到 dsh-settings-file（${SETTINGS_FILE}）`

const { Context } = available ? await import(pathToFileURL(CORDIS).href) : {}
const llmModule = available ? await import(pathToFileURL(LLM).href) : {}
const settingsModule = settingsAvailable ? await import(pathToFileURL(SETTINGS_FILE).href) : {}

/** 只实现 `stream` 的桩适配器：LlmAdapter 的其余成员都有默认实现。 */
class StubAdapter extends llmModule.LlmAdapter {
  constructor() {
    super()
    this.calls = 0
    this.seen = []
  }

  async *stream(options) {
    this.calls += 1
    this.seen.push(options)
    yield { type: 'text-delta', index: 0, text: '来自真实适配器' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const MESSAGES = [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }]

function shanghaiToday() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  })
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date()).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  )
  return `${parts.year}-${parts.month}-${parts.day}`
}

const TODAY = shanghaiToday()

/** 搭一个真实宿主：真 cordis、真 LlmRuntime、真 webServer.register。 */
async function buildHost(config, { settingsPath = null } = {}) {
  const ctx = new Context()
  const runtime = new llmModule.LlmRuntime(ctx)
  const adapter = new StubAdapter()
  runtime.registerAdapter(['stub-provider'], adapter)

  const routes = new Map()
  const webServer = {
    register({ path, handler }) {
      assert.equal(routes.has(path), false, `路由重复注册：${path}`)
      routes.set(path, handler)
      return () => routes.delete(path)
    },
  }

  ctx.set('llm', runtime)
  ctx.provide('agents', {})
  ctx.provide('sessions', {})
  ctx.provide('webServer', webServer)

  // 真实 settings 服务（文件后端）。必须在插件之前就位，否则 apply 时拿不到 ctx.settings。
  if (settingsPath !== null && settingsAvailable) {
    ctx.plugin(settingsModule.FileSettingsProvider, { path: settingsPath, watch: false })
    await new Promise((resolve) => { setTimeout(resolve, 80) })
  }

  const fork = ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, config)
  // 等 inject 满足后 apply 被真正调用
  await new Promise((resolve) => { setTimeout(resolve, 60) })

  async function call(path, { method = 'GET', body } = {}) {
    const handler = routes.get(path)
    assert.ok(handler, `路由未注册：${path}`)
    const res = { statusCode: 0, setHeader() {}, end(t) { this.body = t ?? '' } }
    const req = {
      method,
      url: path,
      on(event, cb) {
        if (event === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)))
        if (event === 'end') cb()
      },
    }
    await handler(req, res)
    return { status: res.statusCode, json: res.body === '' ? null : JSON.parse(res.body) }
  }

  async function stream() {
    const out = []
    for await (const chunk of runtime.stream({ provider: 'stub-provider', model: 'stub-model', messages: MESSAGES })) {
      out.push(chunk)
    }
    return out
  }

  return { ctx, fork, runtime, adapter, routes, call, stream, settings: ctx.settings ?? null }
}

/** 把真实运行时的时钟推到某个瞬间，再跑一次 tick（插件自带的调试接口）。 */
async function tickAt(host, iso) {
  const res = await host.call('/api/peak-brief.debug-tick', { method: 'POST', body: { at: iso } })
  assert.equal(res.status, 200)
  return res.json
}

test('真实宿主：插件在真实 cordis 下装载，apply 真的执行', { skip }, async () => {
  const host = await buildHost({})

  assert.deepEqual(
    [...host.routes.keys()].sort(),
    [
      '/api/peak-brief.allow',
      '/api/peak-brief.allow-off',
      '/api/peak-brief.brief',
      '/api/peak-brief.debug-clock',
      '/api/peak-brief.debug-tick',
      '/api/peak-brief.dismiss',
      '/api/peak-brief.hello',
      '/api/peak-brief.refresh-holidays',
      '/api/peak-brief.state',
    ],
    'apply 必须在真实 cordis 下注册全部路由',
  )

  const state = await host.call('/api/peak-brief.state')
  assert.equal(state.json.ok, true)
  assert.equal(state.json.state.plugin, 'dsh-peak-brief')
})

test('真实宿主：未启用时，真实 llm/stream waterfall 放行到适配器', { skip }, async () => {
  const host = await buildHost({})
  const chunks = await host.stream()

  assert.equal(host.adapter.calls, 1, '真实运行时必须把请求送到适配器')
  assert.equal(chunks.at(-1).reason.kind, 'stop')

  // 请求确实被真实运行时准备过（provider/model 原样抵达）
  assert.equal(host.adapter.seen[0].provider, 'stub-provider')
  assert.equal(host.adapter.seen[0].model, 'stub-model')
})

test('真实宿主：高峰时在真实 waterfall 里拦下，适配器一次都不被调用', { skip }, async () => {
  const host = await buildHost({
    enabled: true,
    gateMode: 'hard',
    overrides: { [TODAY]: 'peak' },
    peakWindows: [['00:00', '24:00']],
  })

  const chunks = await host.stream()

  assert.equal(host.adapter.calls, 0, '拦截时绝不能触达适配器（等于没有产生费用）')
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].type, 'finish')
  assert.equal(chunks[0].reason.kind, 'error')
  assert.equal(chunks[0].reason.failure.code, 'PEAK_BRIEF_BLOCKED')
  assert.match(chunks[0].reason.failure.message, /已拦截本次模型请求/)
})

test('真实宿主：我们构造的终止 chunk 能被官方 BlockAssembler 正确消费', { skip }, async () => {
  const host = await buildHost({
    enabled: true,
    gateMode: 'hard',
    overrides: { [TODAY]: 'peak' },
    peakWindows: [['00:00', '24:00']],
  })

  // BlockAssembler 是官方消费者路径；形状不对它会抛，而不是静默给错结果。
  const assembler = new llmModule.BlockAssembler()
  for await (const chunk of host.runtime.stream({
    provider: 'stub-provider', model: 'stub-model', messages: MESSAGES,
  })) assembler.push(chunk)

  assert.equal(assembler.finish.kind, 'error')
  assert.equal(assembler.finish.failure.code, 'PEAK_BRIEF_BLOCKED')
  assert.deepEqual(assembler.blocks(), [], '被拦截的请求不该产出任何内容块')
  assert.equal(host.adapter.calls, 0)
})

test('真实宿主：逃生放行后，请求真的抵达适配器', { skip }, async () => {
  const host = await buildHost({
    enabled: true,
    gateMode: 'hard',
    overrides: { [TODAY]: 'peak' },
    peakWindows: [['00:00', '24:00']],
  })

  const blocked = await host.stream()
  assert.equal(blocked.at(-1).reason.kind, 'error')
  assert.equal(host.adapter.calls, 0)

  const allow = await host.call('/api/peak-brief.allow', { method: 'POST', body: { minutes: 10 } })
  assert.equal(allow.status, 200)
  assert.equal(allow.json.allow.active, true)

  const allowed = await host.stream()
  assert.equal(host.adapter.calls, 1, '放行后必须真的走到适配器')
  assert.equal(allowed.at(-1).reason.kind, 'stop')

  await host.call('/api/peak-brief.allow-off', { method: 'POST' })
  const blockedAgain = await host.stream()
  assert.equal(blockedAgain.at(-1).reason.kind, 'error')
  assert.equal(host.adapter.calls, 1, '关闭放行后不该再触达适配器')
})

test('真实宿主：时钟推进一整天，门控随相位自动开关', { skip }, async () => {
  const host = await buildHost({
    enabled: true,
    overrides: { [TODAY]: 'peak' },
    peakWindows: [['09:00', '12:00']],
    leadMinutes: 10,
  })

  const at = (hms) => `${TODAY}T${hms}+08:00`

  assert.equal((await tickAt(host, at('08:30:00'))).tick.phase, 'off')
  assert.equal((await host.stream()).at(-1).reason.kind, 'stop', '闲时应放行')

  assert.equal((await tickAt(host, at('09:30:00'))).tick.phase, 'peak')
  assert.equal((await host.stream()).at(-1).reason.kind, 'error', '高峰应拦下')

  assert.equal((await tickAt(host, at('12:30:00'))).tick.phase, 'off')
  assert.equal((await host.stream()).at(-1).reason.kind, 'stop', '闲时应恢复放行')

  // 收尾：去掉时钟覆盖，避免影响其它断言
  await host.call('/api/peak-brief.debug-clock', { method: 'POST', body: { clear: true } })
})

test('真实宿主：插件卸载后路由与 waterfall 监听一并拆除', { skip }, async () => {
  const host = await buildHost({
    enabled: true,
    gateMode: 'hard',
    overrides: { [TODAY]: 'peak' },
    peakWindows: [['00:00', '24:00']],
  })
  assert.equal(host.routes.size, 9)
  assert.equal((await host.stream()).at(-1).reason.kind, 'error')

  assert.equal(typeof host.fork?.dispose, 'function', 'cordis 的 fork 应当可卸载')
  await host.fork.dispose()
  await new Promise((resolve) => { setTimeout(resolve, 30) })

  assert.equal(host.routes.size, 0, '卸载后路由必须注销')

  const after = await host.stream()
  assert.equal(after.at(-1).reason.kind, 'stop', '卸载后门控必须彻底失效，不能再拦')
  assert.equal(host.adapter.calls, 1)
})

// ------------------------------------------------- 真实 settings 服务（文件后端）

function tempSettingsFile(section) {
  const dir = mkdtempSync(join(tmpdir(), 'peak-settings-'))
  const file = join(dir, 'settings.json')
  writeFileSync(file, JSON.stringify(section ?? {}), 'utf8')
  return { dir, file }
}

test('真实设置服务：手写的"类 schema"能被官方 FileSettingsProvider 接受', { skip: settingsSkip }, async () => {
  const { dir, file } = tempSettingsFile({ 'peak-brief': { leadMinutes: 42, timezone: 'UTC' } })
  try {
    const host = await buildHost({}, { settingsPath: file })
    assert.ok(host.settings, '必须真的拿到 ctx.settings')

    // describe() 会调用我们 schema 的 toJSON()——形状不对这里就会炸
    const described = host.settings.describe()
    const descriptor = described.find((d) => d.ns === 'peak-brief')
    assert.ok(descriptor, 'describe() 必须列出 peak-brief 命名空间')
    assert.equal(descriptor.schema.type, 'object')
    assert.equal(descriptor.schema.additionalProperties, false)

    // 解析顺序：schema 默认 → base → 用户层。用户层里的 42 必须生效。
    assert.equal(descriptor.value.leadMinutes, 42)
    assert.equal(descriptor.value.timezone, 'UTC')
    assert.equal(descriptor.value.enabled, false, '未覆盖的字段走 schema 默认')

    // 插件确实注册上了，并把解析结果作为生效配置
    const state = (await host.call('/api/peak-brief.state')).json.state
    assert.equal(state.status.settings.registered, true)
    assert.equal(state.status.leadMinutes, 42)
    assert.equal(state.config.timezone, 'UTC')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('真实设置服务：写入即时生效，无需重启', { skip: settingsSkip }, async () => {
  const { dir, file } = tempSettingsFile({})
  try {
    const host = await buildHost({}, { settingsPath: file })

    const before = (await host.call('/api/peak-brief.state')).json.state
    assert.equal(before.status.enabled, false)
    assert.equal((await host.stream()).at(-1).reason.kind, 'stop')

    // 通过真实 provider 写入用户层
    await host.settings.update('peak-brief', {
      enabled: true,
      gateMode: 'hard',
      overrides: { [TODAY]: 'peak' },
      peakWindows: [['00:00', '24:00']],
    })

    const after = (await host.call('/api/peak-brief.state')).json.state
    assert.equal(after.status.enabled, true, '设置写入必须即时反映到生效配置')
    assert.equal(after.status.phase, 'peak')

    const callsBefore = host.adapter.calls
    const blocked = await host.stream()
    assert.equal(blocked.at(-1).reason.kind, 'error', '写入后必须真的开始拦截')
    assert.equal(host.adapter.calls, callsBefore, '拦截时适配器调用次数不得增加')

    // 清空用户层 → 回退到 schema 默认（关闭），并恢复放行
    await host.settings.replace('peak-brief', {})
    const back = (await host.call('/api/peak-brief.state')).json.state
    assert.equal(back.status.enabled, false)
    assert.equal((await host.stream()).at(-1).reason.kind, 'stop', '清空设置后必须恢复放行')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('真实设置服务：非法写入被拒，生效配置保持不变', { skip: settingsSkip }, async () => {
  const { dir, file } = tempSettingsFile({})
  try {
    const host = await buildHost({ leadMinutes: 17 }, { settingsPath: file })
    assert.equal((await host.call('/api/peak-brief.state')).json.state.status.leadMinutes, 17)

    // 每一种非法值都必须被真实 provider 的写入路径拒绝（因为它会调用我们的 schema）
    await assert.rejects(host.settings.update('peak-brief', { leadMinutes: -1 }), /leadMinutes/)
    await assert.rejects(host.settings.update('peak-brief', { timezone: 'Nowhere/Fake' }), /IANA 时区/)
    await assert.rejects(host.settings.update('peak-brief', { gateMode: '瞎写' }), /gateMode/)
    await assert.rejects(
      host.settings.update('peak-brief', { peakWindows: [['09:00', '12:00'], ['11:00', '13:00']] }),
      /重叠/,
    )

    const after = (await host.call('/api/peak-brief.state')).json.state
    assert.equal(after.status.leadMinutes, 17, '被拒的写入绝不能污染生效配置')
    assert.deepEqual(after.config.peakWindows, [['09:00', '12:00'], ['14:00', '18:00']])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
