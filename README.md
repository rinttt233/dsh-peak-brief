# dsh-peak-brief

DSH（DeepSeek Harness）峰谷调度插件：**高峰前 N 分钟自动生成"仅供 AI 恢复用"的简报并停掉自动续跑，高峰期间硬拦模型请求（带逃生），闲时自动注入简报继续任务。**

> 当前状态：**P0–P5 + 设置界面**。`npm run accept` 的 8 条验收标准 **8/8 通过**；
> 另有两组"真实宿主"测试：用 DSH 运行时里真实的 `@deepseek-ai/cordis` +
> 真实 `LlmRuntime` + 真实 `dsh-settings-file` 装载本插件。
> 门控默认 `enabled: false`，所以**挂载它本身不会拦截任何请求、不排任何定时器**。

## 它要解决什么

DeepSeek 官方 API 在高峰时段按 2 倍计价（北京时间工作日 `09:00–12:00`、`14:00–18:00`；周末全天闲时）。
现有插件要么只做"提示"（各种徽标/倒计时），要么只做"暂停"（时间窗冻结），
**没有一个做到"先让 AI 把活交接清楚，再停"**。本插件补的就是这一步。

## 设计要点

- **两段式门控**
  - `T-leadMinutes`（默认 10 分钟）：等到会话空闲（`agent.whenIdle()`），跑一次
    `agent.runMaintenance()` 生成简报，然后**只停"自动续跑"**——你手动操作照常。
  - `T-0`（高峰起点）：`llm/stream` waterfall 拦截一切模型请求（硬拦），
    可用 `/peak-allow [分钟]` 临时放行。
- **简报是给 AI 的，不是给人看的**：结构化恢复要点，纯机器可读。
  生成在高峰**之前**，所以按闲时价计费。
- **闲时自动继续**：解拦 → `agent.inject(简报)` 给上下文 → `agent.followup()` 起一轮
  → **删除简报文件**（用完即弃）。
- **无活跃任务就不动作**：没有正在进行的工作时，不生成简报、不暂停、不烧钱。
- **峰谷日历**（按用户定义）
  ```
  isPeakDay(d) = isStatutoryWorkday(d) && weekday(d) ∈ {周一…周五}
  ```
  | 日型 | 判定 |
  |---|---|
  | 法定节假日 | 全天闲时 |
  | **调休上班日（周末上班）** | **全天闲时** |
  | 普通工作日 | 按 `peakWindows` |
  | 普通周末 | 全天闲时 |
  | 未知年份 | 降级为"周一至周五按峰谷"，绝不崩 |

## 门控细节（P2）

拦截点是 `llm/stream` —— 一个 waterfall：放行就是 `return next()`，拦截就是返回一个
只含终止 chunk 的流。三条经过实测/查证的设计决定：

1. **拦截用 `error` 而不是 `aborted`**。`aborted` 的语义是"被取消"，会让界面看起来
   像是用户自己中断的；这里是策略拒绝，必须说清原因。
2. **拦截码 `PEAK_BRIEF_BLOCKED` 是刻意自定义的**。`dsh-llm-retry` 只重试
   `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`；如果复用其中任何一个，
   一个必然再次被拦的请求会被无限重试。
3. **`blockAuxiliary` 默认 `true`**（连会话标题、自动压缩这类辅助请求一起拦）。
   想留一条缝就把它设为 `false`；普通对话请求在任何情况下都拦。

逃生窗口的语义是"放过这一段"：正在高峰时，窗口**不会超过本段高峰的结束时刻**——
在 14:10 申请 10 小时放行，实际只到 18:00。

**被拦时会告诉你。** 门控会在高峰期间拦下每一次请求，逐次弹提示会把界面刷屏，
所以按「本地日期 + 高峰窗口起点」去重：**一段高峰只弹一次**（红色 `peak` 级横幅，
带 `/peak-allow` 用法）。离开这一段后 key 改变，下一段会重新提醒。

## 简报（P3）

面向**模型**而非人：紧凑、结构化、不追求可读性。三条设计约束：

1. **零依赖**。外部挂载（绝对路径）的插件解析不到 `@deepseek-ai/*` 裸包名——
   profile 的 `.dsh-module-fallback/node_modules` 里**只有客户端种子模块**
   （`dsh-client-ui-primitives` / `dsh-client-ui-slots`），没有 host 包。
   所以这里既不 `import BlockAssembler`，也不 `import createUserMessage`：
   文本自己累积（`lib/brief.js` 的 `createStreamCollector`），消息字面量自己拼。
2. **失败即降级，绝不丢工作**。模型不可用、输出不可解析、输出被截断、输入超预算——
   任何一种都退到不花钱的 `fallbackBrief()`（用 goal 目标或最后一条用户消息），
   并标记 `degraded: true` + 弹一条 `warn` 横幅。"没有简报就不许恢复"会让
   一次解析失败变成工作丢失。
3. **输出严格校验**。状态必须是 `in_progress|done|blocked`，`resumable` 必须是布尔，
   数组项必须是字符串。形状不对**整体判失败**，不猜不补——半对的简报会把恢复的 AI
   带向错误方向。`status: "done"` 时强制 `resumable: false`。

`purpose` 字段**故意不传**：它是封闭联合（`'compaction' | 'session-title'`），
乱填会踩到适配器的 purpose 分支；省略是官方文档里"普通请求"的默认行为。
代价是思考模式可能开启（多花一点推理 token），换来的是语义诚实。

生成的简报默认落在 **`~/.dsh/peak-brief/<sessionId>.json`** —— 一个独立文件夹，
不污染任何项目仓库。`config.brief.dir` 可改。

> **删除边界**：P4 恢复成功后删掉的是这个**文件**。注入到会话里的那条
> `user/message` 受 `model-visible ⟺ logged` 约束，无法从会话记录抹除，
> 只能之后被常规压缩带走。

## 恢复与周期调度（P4）

**两处关键机制选择，都有依据：**

- **停自动续跑用 `goals.disarm()` 而不是 `pause()`**。dsh-goal 的类型文档写明
  disarm「只移除进程内的续跑授权，不改持久相位与 revision」，而 `resume()` 明确支持
  「重新武装一个 active 但 disarmed 的目标」。用 pause 会把语义记成"被用户暂停了"，
  高峰结束后再 resume 就变成两件事。
- **完整简报走 `followup()`，不押在 `inject()` 上**。`inject()` 的文档明说可能
  "错过 pre-step 已认领的批次"——把恢复载荷全押在它上面，会在竞态下静默丢失，
  那等于活白交接了。所以：`inject` 只带一行 ≤120 字的 notice（省 token、界面有摘要），
  `followup` 携带完整简报，**保证送达**。

**周期决策是纯函数**（`decideCycle`），定时器每次醒来只做一件事：

| 相位 | 动作 |
|---|---|
| `lead` | 生成简报 + `disarm` 目标（同一高峰段内不重复——接受标准 7） |
| `peak` | 不做任何事（门控本身按相位生效） |
| `off` | 若存在未恢复的周期：`inject` + `followup` + 重新武装目标 + 删文件 |

**故障是隔离的。** `session.deriveMessages()` 这类真实契约是离线验证不到的，
所以：① 简报生成异常**不会**跳过"停自动续跑"（高峰定价才是要躲的东西，简报只是让恢复更顺）；
② 异常会被如实记录进 tick 结果并推一条 `peak` 级告警，而不是吞掉；
③ **单个会话炸掉不会带走其它会话的调度**；④ 没有简报时闲时仍会交回一条明确写着
"缺少简报"的恢复消息，而不是静默什么都不做。

## 重启对账（接受标准 8）

约定：**简报文件存在 ⟺ 有一次尚未恢复的暂停**（恢复成功就删文件，所以文件的存在
本身就是持久标记）。

没有这一步会有一个静默的洞：进程重启后内存里的 cycle 消失，`decideCycle` 认为
"没有待办"，那份简报就永远不会被交回——任务**静默地卡在暂停里**。
`agent/created` 时按上述约定对账，并带两道保护：超过 `maxPendingAgeMs`
（默认 12 小时）的旧简报不认领；恢复的目标只在"确实是我们 disarm 过、且它原本 armed"
时才重新武装。

## 斜杠命令

由 `ctx.commands.register` 注册（**不放进 `inject`**：inject 里缺一个服务会让整个插件
拒绝加载，而主功能都不依赖命令；服务不可用时状态接口会如实报告
`commands.registered: false`，而不是假装成功）。

| 命令 | 作用 |
|---|---|
| `/peak-allow [分钟]` | **逃生**：临时放行（默认 30 分钟，且不超过本段高峰结束） |
| `/peak-status` | 相位、门控、拦截次数、未恢复的暂停数 |
| `/peak-brief` | 立刻为当前会话生成一份恢复简报 |
| `/peak-resume` | 立刻按恢复简报继续（跳过等待闲时） |

## 可选联网刷新节假日数据

在库里实现、并且在 Host 里接好了（配置项 `holidayRefresh`）：

```yaml
holidayRefresh:
  enabled: true
  url: 'https://cdn.jsdelivr.net/npm/chinese-days/dist/years/{year}.json'
  years: [2027, 2028]   # 省略则取"当前年 + 下一年"
  onStart: true         # 启动时自动跑一次
```

三条纪律：**永不抛异常**（失败只是那一年继续用内置表）、**永不覆盖已有数据**
（空表/脏表在 `normalizeHolidayTable` 就被拒，不会静默遮蔽内置表）、
**不阻塞启动**（异步跑，判定即时可用）。

并入的数据立即生效，不需要重建日历：`createCalendar` 每次判定时才按引用读
运行期表。手动触发：`POST /api/peak-brief.refresh-holidays`。

## 验证到什么程度（诚实清单）

| 已验证 | 方式 |
|---|---|
| 插件在**真实 cordis** 下装载、`inject` 满足、`apply` 真的执行 | `test/real-host.test.mjs`（真 `Context` + 真 `LlmRuntime`） |
| 拦截走的是**真实 `llm/stream` waterfall**；放行时请求真的抵达适配器；拦截时适配器**一次都不被调用** | 同上（桩适配器计数） |
| 我们构造的终止 chunk 能被官方 `BlockAssembler` 正确消费（不是自说自话的形状） | 同上 |
| 卸载后路由与 waterfall 监听一并拆除 | 同上（`fork.dispose()`） |
| Client 半身：注册工厂、挂进 `shell.overlay`、渲染出文案与关闭按钮、点关闭 POST dismiss 并本地隐藏、React 缺失时降级 | `test/client.test.mjs`（`vm` + React/DOM shim **真实执行** bundle 并展开组件树） |
| 设置页：注册 `settings.section`、渲染全部字段、保存写出正确的路径操作与 revision、非法输入不写盘、恢复默认走 `unset`、Host 拒绝时展示原因 | 同上 |
| **设置**：手写 schema 被官方 `FileSettingsProvider` 接受（注册 / `describe()` / `toJSON()`） | `test/real-host.test.mjs`（真实 `dsh-settings-file`） |
| **设置**：真实 `update()` 即时生效、`replace({})` 回退、非法写入被真实 provider 拒绝且不污染生效配置 | 同上 |
| 设置页在**真实桌面版里出现**，且真的写进了 `settings.yaml` 并即时改变相位推演 | 在运行实例上实测（见「客户端半个必须声明 inject」「写入链路实测结论」） |
| 8 条验收标准 | `npm run accept`（真实插件代码 + 时钟覆盖把一天压进几毫秒） |

| **仍未验证** | 为什么 |
|---|---|
| 真实 `agent/created` 派发、`session.deriveMessages()`、`session.requestHeader()?.config` | 需要真实的 agent/session/goal 组合，离线搭不出来；只能读类型定义推断（`/api/peak-brief.brief` 那条路已经在真实实例上跑过一次真实模型调用） |
| `ctx.goals.disarm()` / `resume()` 的权限策略 | 同上 |
| **真的拦下一次活的会话请求** | 会把这个会话自己锁死（被拦的请求没有模型回合可用，工具也跑不了），只有重启能解；故只在 `test/real-host.test.mjs` 的真实 waterfall 上验证过 |
| Host 半个的最新代码在你的运行实例里生效 | 桌面版只在启动时读 Host 代码；`client.js` 改完 Ctrl+R 即可，`index.js` 改完要重开 `actdsh.exe` |
| Client toast 在真实浏览器里的观感（CSS/portal/层级） | shim 验证的是逻辑与结构，不是像素 |

> 残余风险是**有界的**：插件装载、设置页注册与写入、核心拦截机制都已在真实运行时上跑通，
> 剩下的是具体服务契约（goal/agent/session）与"真拦一次活会话"这种需要你本人点头的操作。

## 设置界面

「**设置 → 峰谷调度**」是一整页配置界面，可改：启用开关、提前量、时区、高峰时段、
高峰拦截模式、是否连辅助请求一起拦、提示方式、按日手动覆盖。另有"保存 / 恢复默认 /
关闭"与一条实时运行状态（当前相位、下次切换、已拦截次数）。

**数据流**（Host 与 Client 各一半，都不自己存配置）：

```
Host   ctx.settings.register('peak-brief', schema, { base: patch配置, applies: 'live' })
         └─ scope.watch(next => applyConfig(next))   ← 写入后**即时生效**，无需重启
Client ctx.settingsScope.bind({ namespace: 'peak-brief' })
         └─ slots.register({ name: 'settings.section', id, order, label }, PeakBriefSettings)
```

三个要点：

1. **解析顺序是 schema 默认 → `base`（patch 层配置）→ 用户设置层**。
   所以设置页里"恢复默认"用的是 `unset` 全部字段（清空用户层），
   结果回退到**你在 patch 里写的值**，而不是硬回内置默认。
2. **非法配置存不进去**，这是结构性保证而不是 UI 礼貌：dsh-settings 的写入路径会调用
   `schema(merged)`，而我们的 schema 在遇到非法值（时区名、时段重叠、越界提前量……）
   时**抛错**，那次写入就被拒绝，生效配置保持不变。
3. **可选依赖**。用 `ctx.inject(['settings'], …)` 而不是把 `settings` 写进 `inject`：
   cordis 的硬 inject 缺一个服务会让**整个插件拒绝加载**，而门控/简报/恢复都不依赖它
   （这一点是实测出来的：直接访问 `ctx.settings` 会抛
   `cannot get property "settings" without inject`）。

### 客户端半个必须声明 `inject = ['slots']`（踩过的坑，附证据）

设置页曾经**完全不出现**，而所有单元测试全绿。根因不在注册代码，而在**启动顺序**：

```
渲染器 apply:  new SlotRegistry(ctx).install(...)   ← `slots` 服务在这里才被提供
我们的 apply:  在它之前跑了 → ctx.get('slots') === undefined
                → 两处槽位注册整段被跳过（悄悄退化成 react-dom 自建容器）
```

`ctx.get(name)` 是**可选查找**（不等服务就绪）。插件 `inject` 为空时，apply 会抢在渲染器
之前跑；这是**竞态**，所以表现时而正常、时而消失。官方插件（`settings-general` 等）
全都声明了 `inject = ['slots', 'locale', ...]`，就是把顺序交给 cordis 而不是交给运气。

修法：`exports.inject = ['slots']`。`settingsScope` **故意不声明**——它可能永不可用，
硬声明会让 apply 永不执行，所以那条路继续走可选的 `ctx.inject(['settingsScope'], …)` 并自报。

### 诊断通道（浏览器里发生的事，后端看得见）

客户端把关键结论 POST 回 `/api/peak-brief.hello`，Host 存进 `state.notice`
（`GET /api/peak-brief.state` 可读，客户端浮层也会显示）。当前会上报：

| 文本 | 含义 |
|---|---|
| `client apply 已执行（inject=[...] slots=可用/不可用）` | bundle 真的在浏览器里跑了；同时暴露服务竞态 |
| `settings-section: 已提交注册（…）` | 已调用 `slots.inject('settings.section', …)`（**不等于**注册成功） |
| `settings-section 终态：where=… spec=已声明/未声明 entries=N ids=… registered=是/否` | **确定信号**：读槽位台账——我们有没有真的进 `settings.section` |
| `settings-section 渲染报错：…` | 注册成功但组件渲染时抛错（走 `slots.onEntryError`） |

`slots.inject` 的**延迟语义**很关键：槽位被声明时回调才跑，而且它抛错**不会**被外面
`try/catch` 到（回调在声明者的 `register()` 里执行）。所以回调内部自带 `try/catch`，
另有一个 4 秒看门狗：槽位已声明却没进去就直连重试一次，仍失败则把台账写回后端。

实测确认（桌面版，运行实例）：`spec=已声明 entries=1 ids=dsh-peak-brief registered=是`。

### 桌面版的刷新 / 重启边界（实测）

`actdsh.exe` 是 Electron 套壳，主进程 spawn `dsh web`。因此：

| 改了什么 | 生效方式 |
|---|---|
| `lib/client.js` | **只需 Ctrl+R**（Host 每次按内容重新提供 `/plugins` bundle，实测抓包核对过） |
| `lib/index.js` 等 Host 半个 | 关窗（会连带 `taskkill /T` 结束整棵 dsh 进程树）后重开 `actdsh.exe` |
| 排障 | 窗口内 **Alt** 唤出菜单栏 → View → Toggle Developer Tools；Ctrl+R 刷新 |

### 写入链路实测结论

设置页保存 → `settings.yaml` 落盘 → 生效配置即时改变 → **参与相位推演**：

```
改「提前量」10 → 20 并保存
  settings.yaml:            leadMinutes: 20
  GET /api/peak-brief.state: config.leadMinutes=20（无重启）
  status.nextSwitch:        2026-09-21T00:50:00Z → 2026-09-21T00:40:00Z
```

最后一行是重点：提前量不是"存了个数"，它真的把下次进入 `lead` 的时刻往前挪了 10 分钟。

### 为什么 schema 是手写的

外部挂载的插件**解析不到裸包名**（实测 `@deepseek-ai/schemastery`、
`@deepseek-ai/cordis`、`schemastery` 全部 `ERR_MODULE_NOT_FOUND`），所以不能用
`schemastery` 的 `Schema`。而 dsh-settings 只以两种方式碰 schema：

```js
resolve():  const value = schema(mergeLayers(base, section))   // 可调用
describe(): registration.schema.toJSON()                        // 需要一个 toJSON
```

于是 `lib/settings.js` 给出一个**可调用的函数 + `toJSON()`**，两个调用点都满足。
这一点已用**真实的 `FileSettingsProvider`** 验证过：注册、`describe()`、写入、拒绝非法写入
四条路径都跑通了。

## 目录结构

```
dsh-peak-brief/
  package.json              dsh.client.platform = web；main = lib/index.js
  cordis.patch.yml          挂载行参考（真正生效的在 profile 的 patch 层）
  data/2025.json 2026.json  节假日原始数据（来源可追溯）
  scripts/build-holidays.mjs  由 data/ 生成 lib/holidays.js
  scripts/acceptance.mjs      8 条验收标准的离线推演报告
  test/real-host.test.mjs     真实 cordis + 真实 LlmRuntime + 真实 dsh-settings-file
  test/client.test.mjs        Client 半身：vm + React shim 真实执行并展开组件树
  lib/holidays.js           内置兜底表（自动生成，勿手改）
  lib/tz.js                 时区/日期工具（零依赖，只用 Intl）
  lib/calendar.js           峰谷日历：日型判定 + 覆盖 + 联网刷新 + 降级
  lib/windows.js            相位状态机：off / lead / peak + 下次切换
  lib/gate.js               门控决策 + 逃生窗口（纯逻辑，不自建请求）
  lib/brief.js              简报：转录压缩、请求构造、严格校验、降级兜底
  lib/brief-store.js        简报落盘（用完即弃的物理载体）
  lib/resume.js             周期决策、目标授权、恢复消息构造
  lib/settings.js           配置契约：默认值、规范化、校验、可调用 schema
  lib/index.js              Host 半身（ESM，无构建）
  lib/client.js             Client 半身（经典脚本 bundle，免构建）
  test/                     calendar / windows / host 集成 / smoke
```

## 节假日数据

- 数据来源：[chinese-days](https://github.com/vsme/chinese-days)（MIT）· 覆盖 2025–2026
- 重新生成：`npm run build:holidays`
- 数据年份之外一律走**降级**路径（周一至周五），不会按一份不存在的日历执行
- **空表会被拒绝**：否则一次返回空响应的联网刷新会静默遮蔽内置表
- 手动覆盖：配置里 `overrides: { '2027-01-01': 'off', '2027-02-06': 'peak' }`
  （`off` = 当天全天闲时；`peak` = 当天按峰谷时段）

## HTTP 接口

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/peak-brief.state` | GET | 插件状态 + 完整相位判定 + 门控状态；`?at=<RFC3339>` 可查询任意瞬间 |
| `/api/peak-brief.allow` | POST | **逃生**：`{ minutes?, note? }` 本次放行（缺省 30 分钟，且不超过本段高峰结束） |
| `/api/peak-brief.allow-off` | POST | 立刻关闭逃生窗口，恢复拦截 |
| `/api/peak-brief.brief` | POST | **生成简报**：`{ sessionId? }`（只有一个活会话时可省略）；落盘并返回简报 |
| `/api/peak-brief.debug-tick` | POST | **推进一次周期检查**：`{ at? }` 可先把时钟覆盖到某个瞬间，用于不等真时间就能推演 |
| `/api/peak-brief.debug-clock` | POST | 装 / 卸时钟覆盖：`{ at }` 装入，`{ clear: true }` 卸下（默认不覆盖） |
| `/api/peak-brief.dismiss` | POST | 关闭指定 `seq` 的通知（过期 seq 不会误关新通知） |
| `/api/peak-brief.hello` | POST | 自检：推一条通知，验证 Host→Client 通路 |

```sh
# 查询任意瞬间的判定，不必等到明早 8:50
curl 'http://127.0.0.1:3080/api/peak-brief.state?at=2026-09-17T08:50:00%2B08:00'
```

> 注意：这些路由经 `ctx.webServer.register` 注册，**不经过 Web 应用的鉴权层**
> （与 `dsh-chat-forward`、`dsh-save-money` 同）。仅供本机使用。
> 卸载插件后这些路径会回落到应用的 401 鉴权响应。

## 挂载

`$DSH_HOME/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: peak-brief
      name: 'D:/deepseekharness/tmp/dsh-peak-brief/lib/index.js'
      config:
        leadMinutes: 10
        notify: popup
```

绝对路径挂载之所以可行：`@deepseek-ai/dsh-client-modules` 的 `nearestPackage()`
会从入口文件向上找最近的 `package.json`，据此读 `dsh.client.platform`
并解析 `exports["./client"]`。**无需 npm 安装**，整个插件就是一个自包含文件夹。

## 开发闭环（实测结论，含一个反直觉的坑）

```sh
node --check lib/*.js     # 语法
node --test               # 全部测试（单测 + Host 集成 + 烟测）
npm run accept            # 8 条验收标准的离线推演报告（不需要等到明早 8:50）

# 非侵入式挂载校验（不碰正在用的 profile）
dsh --profile web --patch test/patch.probe.yml --dump-config
```

**关于热重载，实测事实如下**（不要相信"patch 层是 live 所以就全能热更"）：

| 变更类型 | 是否即时生效 |
|---|---|
| profile patch 层（改配置 / 加减挂载行） | ✅ 即时生效，无需重启（`patchReload: live`） |
| 插件**源码**（`lib/*.js` 内容） | ❌ **不会生效，必须重启 DSH** |

原因：patch 层重载会 dispose 并用新配置重新 `apply()`，但 **Node 的 ESM 模块缓存
仍返回旧模块体**（同一 `file://` URL）。实测排除的绕法：

- 触碰文件 mtime —— 无效（被内容哈希过滤）
- **摘除挂载行再挂回** —— 无效，仍是旧模块（但顺带验证了 dispose 确实注销了路由）
- 作用域限定的 `@deepseek-ai/cordis-plugin-hmr` 实例 —— 未能接管
- 该 profile 自带的 `hmr` 行本身是 `disabled: true`

判断当前跑的是哪份代码：`GET /api/peak-brief.state` 里的 `build` 字段。

## 阶段进度

- [x] **P0** Host + Client 通路（可关闭提示横幅 + 状态/自检路由）
- [x] **P1** `calendar` + `windows` + 单测与 Host 集成测试（只读，不拦截任何东西）
- [x] **P2** `gate`：`llm/stream` 硬拦 + `/peak-allow` 逃生窗口
- [x] **P3** `brief`：`ctx.llm.stream` 生成结构化简报并落盘
- [x] **P4** `resume`：周期调度 + `inject`/`followup` + 目标 `disarm`/`resume` + 删文件 + 重启对账
- [x] **P5** 端到端：`npm run accept` 离线推演 8/8 通过（含斜杠命令逃生）
- [x] **真实宿主验证**：真实 cordis + 真实 LlmRuntime 装载与拦截
- [ ] **线上验收**：需要一次 DSH 重启（源码变更不被热重载）
- [ ] **P5** 端到端（`debug-tick` 推演工作日 / 调休日 / 法定节假日）

## 已知限制（不修，只记录）

- **不能中断正在进行的轮次**：只能在轮次之间动作，`T-0` 前在途的请求无法追回。
- **冷会话唤不醒**：DSH 进程不在 / 会话没活，就没有"闲时自动继续"。
- **简报的"删除"只对文件成立**：注入的那条 `user/message` 受
  `model-visible ⟺ logged` 约束，无法从会话记录抹除，只能之后被常规压缩带走。
- **目标续跑的 `armed` 是 process-local**：每次 session-start 都会解除武装，重启后需重新武装。
- **源码改动需重启 DSH**（见上）。

## License

MIT
