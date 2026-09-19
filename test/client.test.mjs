/**
 * Client 半身（浏览器 bundle）测试。
 *
 * lib/client.js 是**免构建的经典脚本**，通过 `window.__ModuleLoader__.load` 注册工厂。
 * 这里用 `vm` + 最小 React/DOM shim 把它真的跑起来（本机 dsh-chat-forward 用的同一套
 * 手法），验证两处 UI：
 *
 *   shell.overlay      —— 可关闭的提示横幅
 *   settings.section   —— 「设置 → 峰谷调度」整页配置界面
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const CODE = readFileSync(BUNDLE, 'utf8')

// ------------------------------------------------------------------ React shim

function makeReact() {
  const hookStates = []
  let hookIndex = 0
  const effects = []

  /** 每次顶层渲染前必须调用：hook 游标是 shim 的内部状态。 */
  const reset = () => {
    hookIndex = 0
    effects.length = 0
  }

  const React = {
    createElement(type, props, ...children) {
      return { vnode: true, type, props: props ?? {}, children: children.flat(Infinity) }
    },
    useState(initial) {
      const index = hookIndex++
      if (!(index in hookStates)) hookStates[index] = typeof initial === 'function' ? initial() : initial
      return [hookStates[index], (next) => {
        hookStates[index] = typeof next === 'function' ? next(hookStates[index]) : next
      }]
    },
    useEffect(fn) {
      effects.push(fn)
    },
    useRef(initial) {
      const index = hookIndex++
      if (!(index in hookStates)) hookStates[index] = { current: initial }
      return hookStates[index]
    },
    useCallback(fn) {
      hookIndex++
      return fn
    },
  }

  return { React, reset, effects, hookStates }
}

/**
 * 把函数组件就地展开成宿主元素树（真实 React 做同样的事）。
 * 被测组件不嵌套其它函数组件，所以不需要为子树保存/恢复 hook 游标。
 */
function expand(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return node
  if (Array.isArray(node)) return node.map((child) => expand(child))
  if (typeof node !== 'object' || node.vnode !== true) return node
  if (typeof node.type === 'function') {
    return expand(node.type({
      ...node.props,
      children: node.children.length === 1 ? node.children[0] : node.children,
    }))
  }
  return { ...node, children: node.children.map((child) => expand(child)) }
}

/** 深度优先收集所有宿主节点。 */
function collect(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out)
    return out
  }
  if (node.vnode !== true) return out
  out.push(node)
  for (const child of node.children) collect(child, out)
  return out
}

/** 收集一棵树里的全部文本。 */
function textOf(node) {
  const parts = []
  const walk = (value) => {
    if (typeof value === 'string') { parts.push(value); return }
    if (value === null || value === undefined || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const child of value) walk(child); return }
    if (value.vnode === true) { for (const child of value.children) walk(child); return }
  }
  walk(node)
  return parts.join(' ')
}

const byField = (tree, key) => collect(tree).find((n) => n.props?.['data-peak-brief-field'] === key)
const byAction = (tree, action) => collect(tree).find((n) => n.props?.['data-peak-brief-action'] === action)

/**
 * 跨 realm 归一化：vm 里造出来的数组/对象原型与宿主 realm 不同，
 * `assert.deepStrictEqual` 会因为原型不等而失败（即使结构一模一样）。
 */
const plain = (value) => JSON.parse(JSON.stringify(value))

// ------------------------------------------------------------------ 宿主搭建

function loadBundle({ requireOverrides } = {}) {
  let registration = null
  const fetchCalls = []
  const timers = []

  const document = {
    body: { appendChild() {}, removeChild() {} },
    createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, appendChild() {}, remove() {} }),
  }

  /**
   * 必须用闭包里的 responder：`vm.runInNewContext` 会把 sandbox contextify，
   * 之后再给 sandbox 赋属性**不会**回流到 vm 内的全局对象。
   */
  let responder = null

  const sandbox = {
    console,
    document,
    fetch: async (url, options) => {
      fetchCalls.push({ url: String(url), options })
      if (responder !== null) return responder(String(url), options)
      return { ok: true, json: async () => ({ ok: true, state: { notice: null } }) }
    },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimeout: () => {},
  }
  sandbox.window = {
    __ModuleLoader__: { load: (value) => { registration = value } },
    setInterval: (fn, ms) => { timers.push({ fn, ms, interval: true }); return timers.length },
    clearInterval: () => {},
    setTimeout: sandbox.setTimeout,
    clearTimeout: sandbox.clearTimeout,
  }
  sandbox.globalThis = sandbox

  vm.runInNewContext(CODE, sandbox, { filename: 'client.js' })

  const hooks = makeReact()
  const ReactDOM = { createRoot: () => ({ render() {}, unmount() {} }) }
  const requested = []
  const mod = registration.factory((specifier) => {
    requested.push(specifier)
    if (requireOverrides?.[specifier] !== undefined) throw requireOverrides[specifier]
    if (specifier === 'react') return hooks.React
    if (specifier === 'react-dom') return ReactDOM
    throw new Error(`unexpected require: ${specifier}`)
  })

  return {
    registration,
    mod,
    requested,
    fetchCalls,
    timers,
    hooks,
    setResponder(fn) { responder = fn },
  }
}

/** 假 settings 作用域，记录每一次写入。 */
function makeScope(value) {
  const calls = { mutate: [], set: [], unset: [] }
  const listeners = new Set()
  let snapshot = {
    status: 'ready',
    value,
    base: {},
    user: {},
    revision: 3,
    writable: true,
    mode: 'host',
  }
  return {
    calls,
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    set: async (field, next) => { calls.set.push({ field, value: next }) },
    unset: async (field) => { calls.unset.push(field) },
    mutate: async (ops, revision) => { calls.mutate.push({ ops, revision }) },
    setSnapshot(next) {
      snapshot = { ...snapshot, ...next }
      for (const listener of listeners) listener()
    },
  }
}

const SETTINGS_VALUE = {
  enabled: false,
  timezone: 'Asia/Shanghai',
  leadMinutes: 10,
  peakWindows: [['09:00', '12:00'], ['14:00', '18:00']],
  notify: 'popup',
  gateMode: 'hard',
  blockAuxiliary: true,
  overrides: { '2027-01-01': 'off' },
}

/**
 * 装载模块并注册槽位。
 * @param options.withSettings - 是否提供 settingsScope（false 用于验证降级）
 * @param options.viaGet       - true 时只在 ctx.get('settingsScope') 上提供（验证回退路径）
 */
function mount(harness, { settingsVia = 'inject', bindThrows = false, noInjectMethod = false } = {}) {
  const registrations = []
  const slots = {
    inject(name, callback) {
      assert.ok(
        name === 'shell.overlay' || name === 'settings.section',
        `注册到了意料之外的槽位：${name}`,
      )
      return callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  }

  const scope = makeScope(SETTINGS_VALUE)
  const bound = []
  const settingsScope = {
    bind(spec) {
      if (bindThrows === true) throw new Error('命名空间不合法')
      bound.push(spec)
      return scope
    },
  }

  const reachable = settingsVia === 'inject' || settingsVia === 'get'
  const ctx = {
    get(key) {
      if (key === 'slots') return slots
      if (key === 'settingsScope' && reachable) return settingsScope
      return undefined
    },
    effect(fn) { return fn() },
  }

  // 真实 cordis：未在插件 inject 里声明的服务，**属性访问会抛**
  // （"cannot get property … without inject"）。之前这里直接挂了个普通属性，
  // 于是测试给了假阳性——这正是线上设置页没挂上而测试全绿的原因。
  Object.defineProperty(ctx, 'settingsScope', {
    get() { throw new Error('cannot get property "settingsScope" without inject') },
    configurable: true,
  })

  if (noInjectMethod !== true) {
    ctx.inject = (deps, callback) => {
      if (settingsVia === 'inject' && deps.includes('settingsScope')) {
        callback({
          settingsScope,
          get: ctx.get,
          effect: ctx.effect,
        })
      }
      return { dispose() {} }
    }
  }

  harness.mod.apply(ctx)

  const section = registrations.find((r) => r.options.name === 'settings.section')
  const overlay = registrations.find((r) => r.options.name === 'shell.overlay')

  return {
    registrations,
    overlay,
    section,
    scope,
    bound,
    /** 渲染任意注册组件；`extra` 会合进 props（settings.section 的 owner 会传 close）。 */
    render(component, extra = {}) {
      harness.hooks.reset()
      return expand(harness.hooks.React.createElement(component, extra))
    },
    /** 渲染设置页，自动带上 inject 提供的业务 props。 */
    renderSettings(extra = {}) {
      const props = section === undefined ? {} : section.options.inject()
      return this.render(section.component, { ...props, ...extra })
    },
  }
}

/** 触发客户端为"inject 回调没来"准备的那次延迟兜底检查。 */
function runFallbackTimers(harness) {
  for (const timer of harness.timers.filter((t) => t.interval !== true)) timer.fn()
  harness.timers.length = 0
}

/** 客户端写回 Host 的全部诊断文本（走 /api/peak-brief.hello）。 */
function diagnostics(harness) {
  return harness.fetchCalls
    .filter((c) => c.url === '/api/peak-brief.hello')
    .map((c) => JSON.parse(c.options.body).text)
}

/** 最后一条诊断（成功/失败结论总是最后上报的那条）。 */
const lastDiagnostic = (harness) => diagnostics(harness).at(-1) ?? ''

/** 跑一遍捕获到的 effect（相当于 React 的首次提交）。 */
function runEffects(effects) {
  const cleanups = []
  for (const fn of effects) {
    const cleanup = fn()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  }
  effects.length = 0
  return cleanups
}

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => { setImmediate(resolve) })
}

/** 渲染 → 跑 effect → 等轮询回来。 */
async function mountAndSettle(harness, options) {
  const mounted = mount(harness, options)
  mounted.renderSettings()
  runEffects(harness.hooks.effects)
  await flush()
  return mounted
}

// ------------------------------------------------------------------ overlay

test('client：bundle 执行即注册工厂，id 与包名一致', () => {
  const { registration } = loadBundle()
  assert.ok(registration, 'bundle 必须调用 window.__ModuleLoader__.load')
  assert.equal(registration.id, 'dsh-peak-brief')
  assert.equal(typeof registration.factory, 'function')
})

test('client：factory 只请求平台 seed 模块（无构建产物依赖）', () => {
  const { mod, requested } = loadBundle()
  assert.deepEqual([...new Set(requested)].sort(), ['react', 'react-dom'])
  assert.equal(mod.name, 'dsh-peak-brief')
  // vm 里造出来的数组原型与宿主 realm 不同，不能用 deepStrictEqual
  assert.equal(mod.inject.length, 0)
  assert.equal(typeof mod.apply, 'function')
})

test('client：两处槽位都注册（浮层 + 设置页），不会注册完一个就 return', () => {
  const harness = loadBundle()
  const mounted = mount(harness)

  assert.equal(mounted.registrations.length, 2, '必须同时挂上浮层与设置页')
  assert.equal(mounted.overlay.options.id, 'dsh-peak-brief')
  assert.equal(typeof mounted.overlay.options.order, 'number')
  assert.equal(typeof mounted.overlay.component, 'function')

  assert.equal(mounted.section.options.id, 'dsh-peak-brief')
  assert.equal(typeof mounted.section.options.order, 'number')
  assert.equal(typeof mounted.section.options.label, 'function')
  assert.equal(mounted.section.options.label(), '峰谷调度')
  assert.equal(typeof mounted.section.component, 'function')
  assert.equal(mounted.bound.length, 1)
  assert.equal(mounted.bound[0].namespace, 'peak-brief', '必须绑定 Host 的 peak-brief 命名空间')
})

test('client：无通知时浮层渲染 null；有通知时渲染文案与关闭按钮', async () => {
  const harness = loadBundle()
  const notice = { seq: 7, kind: 'peak', text: '本次模型请求已被拦截：高峰计价时段。' }
  harness.setResponder(async () => ({ ok: true, json: async () => ({ ok: true, state: { notice } }) }))

  const mounted = mount(harness)
  assert.equal(mounted.render(mounted.overlay.component, {}), null)

  mounted.render(mounted.overlay.component, {})
  runEffects(harness.hooks.effects)
  await flush()
  assert.ok(harness.fetchCalls.some((c) => c.url === '/api/peak-brief.state'))

  const nodes = collect(mounted.render(mounted.overlay.component, {}))
  const textNode = nodes.find((n) => typeof n.children?.[0] === 'string' && n.children[0].includes('已被拦截'))
  assert.ok(textNode, '必须渲染出通知文案')

  const button = nodes.find((n) => n.type === 'button')
  assert.ok(button)
  assert.equal(button.props['aria-label'], '关闭')

  const container = nodes[0]
  assert.equal(container.props.style.pointerEvents, 'auto', '浮层穿透点击，条目必须自己打开指针事件')
  assert.equal(container.props['data-peak-brief'], 'notice')
})

test('client：点关闭会 POST dismiss，并在本地先隐藏', async () => {
  const harness = loadBundle()
  const notice = { seq: 42, kind: 'info', text: '测试通知' }
  harness.setResponder(async () => ({ ok: true, json: async () => ({ ok: true, state: { notice } }) }))

  const mounted = mount(harness)
  mounted.render(mounted.overlay.component, {})
  runEffects(harness.hooks.effects)
  await flush()

  const button = collect(mounted.render(mounted.overlay.component, {})).find((n) => n.type === 'button')
  button.props.onClick()
  await flush()

  const dismiss = harness.fetchCalls.find((c) => c.url === '/api/peak-brief.dismiss')
  assert.ok(dismiss)
  assert.equal(dismiss.options.method, 'POST')
  assert.equal(JSON.parse(dismiss.options.body).seq, 42)
  assert.equal(mounted.render(mounted.overlay.component, {}), null, '关闭后必须立刻不再渲染')
})

test('client：React 不可用时降级为"只报错、不崩"', () => {
  const harness = loadBundle({ requireOverrides: { react: new Error('没有 react') } })
  const errors = []
  const originalError = console.error
  console.error = (message) => errors.push(String(message))
  try {
    assert.doesNotThrow(() => harness.mod.apply({ get: () => undefined, effect: (fn) => fn() }))
  } finally {
    console.error = originalError
  }
  assert.equal(errors.length, 1)
  assert.match(errors[0], /react/)
})

// ------------------------------------------------------------------ 设置页

test('设置页：渲染出全部字段与当前值', async () => {
  const harness = loadBundle()
  const mounted = await mountAndSettle(harness)
  const tree = mounted.renderSettings()

  const text = textOf(tree)
  for (const label of ['启用峰谷调度', '提前量（分钟）', '时区', '高峰时段', '高峰拦截', '连辅助请求一起拦', '提示方式', '按日手动覆盖']) {
    assert.ok(text.includes(label), `缺少字段：${label}`)
  }

  assert.equal(byField(tree, 'leadMinutes').props.value, '10')
  assert.equal(byField(tree, 'timezone').props.value, 'Asia/Shanghai')
  assert.equal(byField(tree, 'enabled').props.checked, false)
  assert.equal(byField(tree, 'gateMode').props.value, 'hard')
  assert.equal(byField(tree, 'notify').props.value, 'popup')
  assert.equal(byField(tree, 'blockAuxiliary').props.checked, true)
  assert.equal(byField(tree, 'peakWindows').props.value, '09:00-12:00\n14:00-18:00')
  assert.equal(JSON.parse(byField(tree, 'overrides').props.value)['2027-01-01'], 'off')

  // 运行状态条 + 三个操作按钮
  assert.ok(collect(tree).some((n) => n.props?.['data-peak-brief'] === 'settings-status'))
  assert.ok(byAction(tree, 'save'))
  assert.ok(byAction(tree, 'reset'))
  assert.ok(byAction(tree, 'close'))
})

test('设置页：改动后保存，写出正确的路径操作与 revision', async () => {
  const harness = loadBundle()
  const mounted = await mountAndSettle(harness)

  // 勾选启用、改提前量、改时段
  byField(mounted.renderSettings(), 'enabled').props.onChange({ target: { checked: true } })
  byField(mounted.renderSettings(), 'leadMinutes').props.onChange({ target: { value: '20' } })
  byField(mounted.renderSettings(), 'peakWindows').props.onChange({ target: { value: '08:30-11:30\n13:30-17:30' } })
  byField(mounted.renderSettings(), 'overrides').props.onChange({ target: { value: '{"2027-05-01":"off"}' } })

  byAction(mounted.renderSettings(), 'save').props.onClick()
  await flush()

  assert.equal(mounted.scope.calls.mutate.length, 1, '一次保存应当只写一次')
  const { ops, revision } = mounted.scope.calls.mutate[0]
  assert.equal(revision, 3, '必须带上读到的 revision 作为乐观锁')

  const byPath = Object.fromEntries(ops.filter((op) => op.op === 'set').map((op) => [op.path[0], op.value]))
  assert.equal(byPath.enabled, true)
  assert.equal(byPath.leadMinutes, 20, '数字字段必须是数字而不是字符串')
  assert.deepEqual(plain(byPath.peakWindows), [['08:30', '11:30'], ['13:30', '17:30']])
  assert.deepEqual(plain(byPath.overrides), { '2027-05-01': 'off' })
  assert.equal(byPath.timezone, 'Asia/Shanghai', '没改的字段也要一起写（保持整份一致）')

  const after = mounted.renderSettings()
  assert.ok(collect(after).some((n) => n.props?.['data-peak-brief'] === 'settings-saved'), '保存成功要有反馈')
})

test('设置页：非法输入不写盘，并给出可读错误', async () => {
  const harness = loadBundle()
  const mounted = await mountAndSettle(harness)

  byField(mounted.renderSettings(), 'peakWindows').props.onChange({ target: { value: '今天下午' } })
  byAction(mounted.renderSettings(), 'save').props.onClick()
  await flush()

  assert.equal(mounted.scope.calls.mutate.length, 0, '解析失败绝不能写盘')

  const tree = mounted.renderSettings()
  const error = collect(tree).find((n) => n.props?.['data-peak-brief'] === 'settings-error')
  assert.ok(error, '必须显示错误')
  assert.match(textOf(error), /无法解析时段/)
})

test('设置页：非法 JSON 覆盖同样被拦住', async () => {
  const harness = loadBundle()
  const mounted = await mountAndSettle(harness)

  byField(mounted.renderSettings(), 'overrides').props.onChange({ target: { value: '[1,2,3]' } })
  byAction(mounted.renderSettings(), 'save').props.onClick()
  await flush()

  assert.equal(mounted.scope.calls.mutate.length, 0)
  const error = collect(mounted.renderSettings()).find((n) => n.props?.['data-peak-brief'] === 'settings-error')
  assert.match(textOf(error), /必须是 JSON 对象/)
})

test('设置页：恢复默认 = unset 全部字段，让它们回退到 patch 层', async () => {
  const harness = loadBundle()
  const mounted = await mountAndSettle(harness)

  byAction(mounted.renderSettings(), 'reset').props.onClick()
  await flush()

  assert.equal(mounted.scope.calls.mutate.length, 1)
  const { ops, revision } = mounted.scope.calls.mutate[0]
  assert.equal(revision, 3)
  assert.ok(ops.length > 0)
  assert.ok(ops.every((op) => op.op === 'unset'), '恢复默认只能靠 unset（清空用户层）')
  assert.ok(ops.some((op) => op.path[0] === 'leadMinutes'))
})

test('设置页：写入被 Host 拒绝时展示原因，不假装成功', async () => {
  const harness = loadBundle()
  const mounted = await mountAndSettle(harness)
  mounted.scope.mutate = async () => { throw new Error('leadMinutes 必须是非负整数') }

  byAction(mounted.renderSettings(), 'save').props.onClick()
  await flush()

  const tree = mounted.renderSettings()
  const error = collect(tree).find((n) => n.props?.['data-peak-brief'] === 'settings-error')
  assert.ok(error)
  assert.match(textOf(error), /必须是非负整数/)
  assert.equal(collect(tree).some((n) => n.props?.['data-peak-brief'] === 'settings-saved'), false)
})

test('设置页：命名空间不可用时只读，不提供保存', async () => {
  const harness = loadBundle()
  const mounted = await mountAndSettle(harness)
  mounted.scope.setSnapshot({ status: 'unavailable', value: undefined, writable: false })

  const tree = mounted.renderSettings()
  assert.equal(byAction(tree, 'save').props.disabled, true)
  assert.equal(byAction(tree, 'reset').props.disabled, true)
  assert.match(textOf(tree), /没有暴露 peak-brief 设置命名空间/)
})

test('设置页：关闭按钮调用 owner 给的 close()', async () => {
  const harness = loadBundle()
  const mounted = await mountAndSettle(harness)

  let closed = 0
  byAction(mounted.renderSettings({ close: () => { closed += 1 } }), 'close').props.onClick()
  assert.equal(closed, 1)
})

test('设置页：settingsScope 完全不可用时，浮层照常挂 + 自报原因（不再静默）', async () => {
  const harness = loadBundle()
  const errors = []
  const originalError = console.error
  console.error = (message) => errors.push(String(message))

  let mounted
  try {
    mounted = mount(harness, { settingsVia: 'none' })
    assert.equal(mounted.registrations.length, 1, '只应挂上浮层')
    assert.equal(mounted.registrations[0].options.name, 'shell.overlay')

    // inject 回调没触发 → 跑一次延迟兜底，必须自报（console.error 仍处于接管状态）
    runFallbackTimers(harness)
    await flush()
  } finally {
    console.error = originalError
  }

  assert.equal(errors.length, 1)
  assert.match(errors[0], /设置页未挂载/)
  assert.match(lastDiagnostic(harness), /settingsScope/, '必须把确切原因写回 Host 供后端读取')
})

test('设置页：只有 ctx.get 可用（无 ctx.inject）时走回退路径', () => {
  const harness = loadBundle()
  const mounted = mount(harness, { settingsVia: 'get', noInjectMethod: true })
  assert.equal(mounted.registrations.length, 2)
  assert.equal(mounted.bound.length, 1)
  assert.equal(mounted.bound[0].namespace, 'peak-brief')
})

test('设置页：bind 抛错时自报，浮层不受影响', async () => {
  const harness = loadBundle()
  const errors = []
  const originalError = console.error
  console.error = (message) => errors.push(String(message))

  let mounted
  try {
    mounted = mount(harness, { bindThrows: true })
  } finally {
    console.error = originalError
  }

  assert.equal(mounted.registrations.length, 1)
  assert.equal(mounted.registrations[0].options.name, 'shell.overlay')

  await flush()
  assert.equal(errors.length, 1)
  assert.match(errors[0], /bind 失败/)
  assert.match(lastDiagnostic(harness), /bind 失败/)
})

test('设置页：挂载成功时也会写回诊断（后端可据此确认浏览器真的挂上了）', () => {
  const harness = loadBundle()
  const mounted = mount(harness)
  assert.equal(mounted.registrations.length, 2)

  const notes = diagnostics(harness)
  assert.ok(notes.some((t) => t.includes('client apply 已执行')), '第一件事就上报 apply 已执行')
  assert.match(lastDiagnostic(harness), /settings-section: 已注册/)
})

test('设置页：走 ctx.get 回退成功时，诊断里标明是 get 路径', () => {
  const harness = loadBundle()
  mount(harness, { settingsVia: 'get', noInjectMethod: true })
  assert.match(lastDiagnostic(harness), /已注册（get）/)
})

test('client：Host 没起来时两个 UI 都不崩', async () => {
  const harness = loadBundle()
  harness.setResponder(async () => { throw new Error('Host 还没起来') })

  const mounted = await mountAndSettle(harness)
  assert.equal(mounted.render(mounted.overlay.component, {}), null)
  assert.ok(mounted.renderSettings(), '设置页应当仍然渲染（只是状态读不到）')
})
