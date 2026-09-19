/**
 * dsh-peak-brief — browser half.
 *
 * 经典脚本插件 bundle（无构建步骤）：执行时只注册 factory，模块体在首次
 * materialize 时才跑。只 require("react")（平台 seed 模块）。
 *
 * 提供两处 UI：
 *   1. `shell.overlay` —— 一条**可关闭**的提示横幅（高峰拦截 / 简报 / 恢复提醒）；
 *   2. `settings.section` —— 「设置 → 峰谷调度」整页配置界面，读写 Host 的
 *      `peak-brief` 设置命名空间（`ctx.settingsScope.bind`）。
 *
 * 数据流：Host 用 `ctx.settings.register()` 注册命名空间并 watch 变更即时生效；
 * 客户端只负责渲染与写入，不自己保存任何配置。
 */

window.__ModuleLoader__.load({
	id: 'dsh-peak-brief',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports

		const PLUGIN_ID = 'dsh-peak-brief'
		const API = '/api/peak-brief'
		const POLL_MS = 4000
		/** 必须与 Host 的 lib/settings.js 保持一致。 */
		const SETTINGS_NS = 'peak-brief'

		let React = null
		try { React = require('react') } catch { /* 平台 seed 缺失时下面会显式报错 */ }
		let ReactDOM = null
		try { ReactDOM = require('react-dom') } catch { /* 仅降级路径需要 */ }

		if (React === null) {
			exports.name = PLUGIN_ID
			exports.inject = []
			exports.apply = () => {
				console.error('[peak-brief] react 平台模块不可用，UI 未挂载')
			}
			return module.exports
		}

		const h = React.createElement
		const { useState, useEffect, useRef } = React

		const KIND_STYLE = {
			info: { accent: '#3b82f6', bg: 'rgba(23, 37, 61, 0.96)' },
			warn: { accent: '#f59e0b', bg: 'rgba(61, 45, 18, 0.96)' },
			peak: { accent: '#ef4444', bg: 'rgba(61, 24, 24, 0.96)' },
		}

		function styleOf(kind) {
			return KIND_STYLE[kind] ?? KIND_STYLE.info
		}

		// ------------------------------------------------------------ 轮询 Host 状态

		async function fetchState() {
			const res = await fetch(`${API}.state`, { headers: { accept: 'application/json' } })
			if (res === null || typeof res !== 'object' || res.ok !== true) return null
			const body = await res.json()
			return body && body.ok === true ? body.state : null
		}

		/**
		 * 轮询 Host 状态。返回 { state, dismiss }。
		 * 轮询失败只记在本地，不弹错——DSH 重启的瞬间必然会失败几次。
		 */
		function usePeakState() {
			const [state, setState] = useState(null)
			const [dismissedSeq, setDismissedSeq] = useState(0)
			const inFlight = useRef(false)

			useEffect(() => {
				let alive = true

				async function tick() {
					if (inFlight.current) return
					inFlight.current = true
					try {
						const next = await fetchState()
						if (alive && next !== null) setState(next)
					} catch {
						/* Host 未就绪或正在热重载 */
					} finally {
						inFlight.current = false
					}
				}

				void tick()
				const timer = window.setInterval(() => { void tick() }, POLL_MS)
				return () => {
					alive = false
					window.clearInterval(timer)
				}
			}, [])

			async function dismiss(seq) {
				setDismissedSeq(seq)
				try {
					await fetch(`${API}.dismiss`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ seq }),
					})
				} catch {
					/* 下次轮询会再次给出该通知，本地已先隐藏 */
				}
			}

			return { state, dismissedSeq, dismiss }
		}

		/** shell.overlay 里的一条可关闭横幅；无通知时渲染 null。 */
		function PeakNotice() {
			const { state, dismissedSeq, dismiss } = usePeakState()
			const notice = state?.notice ?? null
			if (notice === null || notice.seq === dismissedSeq) return null

			const tone = styleOf(notice.kind)
			return h('div', {
				'data-peak-brief': 'notice',
				style: {
					position: 'fixed',
					top: '14px',
					left: '50%',
					transform: 'translateX(-50%)',
					zIndex: 90,
					pointerEvents: 'auto',
					maxWidth: 'min(680px, calc(100vw - 32px))',
					display: 'flex',
					alignItems: 'flex-start',
					gap: '10px',
					padding: '10px 12px 10px 14px',
					borderRadius: '10px',
					border: `1px solid ${tone.accent}`,
					borderLeft: `4px solid ${tone.accent}`,
					background: tone.bg,
					color: '#f5f7fa',
					fontSize: '13px',
					lineHeight: '1.5',
					boxShadow: '0 10px 30px rgba(0, 0, 0, 0.35)',
				},
			},
				h('span', { style: { flex: '1 1 auto', whiteSpace: 'pre-wrap' } }, notice.text),
				h('button', {
					type: 'button',
					title: '关闭',
					'aria-label': '关闭',
					onClick: () => { void dismiss(notice.seq) },
					style: {
						flex: '0 0 auto',
						width: '22px',
						height: '22px',
						lineHeight: '20px',
						textAlign: 'center',
						borderRadius: '6px',
						border: '1px solid rgba(255,255,255,0.28)',
						background: 'transparent',
						color: '#f5f7fa',
						cursor: 'pointer',
						fontSize: '14px',
						padding: '0',
					},
				}, '×'),
			)
		}

		// ------------------------------------------------------------ 设置页

		/** 把设置命名空间的一个快照变成 React 状态。 */
		function useScopeSnapshot(scope) {
			const [snap, setSnap] = useState(() => (scope === null ? null : scope.getSnapshot()))
			useEffect(() => {
				if (scope === null) return undefined
				let alive = true
				const sync = () => { if (alive) setSnap(scope.getSnapshot()) }
				sync()
				const dispose = scope.subscribe(sync)
				return () => {
					alive = false
					if (typeof dispose === 'function') dispose()
				}
			}, [scope])
			return snap
		}

		const rowsToText = (rows) => (Array.isArray(rows) ? rows : [])
			.map((pair) => (Array.isArray(pair) ? `${pair[0]}-${pair[1]}` : '')).join('\n')

		/** 时段文本 → `[['HH:MM','HH:MM'], …]`。非法时抛错，由调用方展示。 */
		function textToRows(text) {
			const out = []
			for (const raw of String(text ?? '').split('\n')) {
				const line = raw.trim()
				if (line === '') continue
				const match = /^(\d{1,2}:\d{2})\s*[-~—]\s*(\d{1,2}:\d{2})$/.exec(line)
				if (match === null) throw new Error(`无法解析时段「${line}」，应形如 09:00-12:00`)
				out.push([match[1], match[2]])
			}
			return out
		}

		const jsonToText = (value) => JSON.stringify(value ?? {}, null, 2)

		function textToJson(text) {
			const parsed = JSON.parse(String(text ?? '{}'))
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
				throw new Error('必须是 JSON 对象')
			}
			return parsed
		}

		/**
		 * 字段声明。`toText` / `fromText` 成对出现：前者把设置值变成可编辑文本，
		 * 后者把编辑结果变回设置值并在非法时抛错。
		 */
		const FIELDS = [
			{ key: 'enabled', label: '启用峰谷调度', kind: 'boolean', hint: '关闭时不拦截任何请求、不排定时器' },
			{ key: 'leadMinutes', label: '提前量（分钟）', kind: 'number', hint: '高峰前多久生成简报并停掉自动续跑' },
			{ key: 'timezone', label: '时区', kind: 'text', hint: 'IANA 名称，例如 Asia/Shanghai' },
			{
				key: 'peakWindows',
				label: '高峰时段',
				kind: 'windows',
				hint: '每行一个 HH:MM-HH:MM；普通工作日按此判定',
				toText: rowsToText,
				fromText: textToRows,
			},
			{
				key: 'gateMode',
				label: '高峰拦截',
				kind: 'select',
				options: [['hard', '硬拦（推荐）'], ['off', '不拦，只观测']],
			},
			{
				key: 'blockAuxiliary',
				label: '连辅助请求一起拦',
				kind: 'boolean',
				hint: '会话标题、自动压缩这类调用同样按高峰计价',
			},
			{
				key: 'notify',
				label: '提示方式',
				kind: 'select',
				options: [['popup', '弹窗横幅'], ['message', '仅会话内'], ['off', '关闭提示']],
			},
			{
				key: 'overrides',
				label: '按日手动覆盖',
				kind: 'json',
				hint: 'JSON：{"2027-01-01":"off","2027-02-06":"peak"}（off=全天闲时，peak=按峰谷）',
				toText: jsonToText,
				fromText: textToJson,
			},
		]

		/** 设置值 → 编辑用的草稿（全部变成字符串/布尔/数字）。 */
		function draftFromValue(value) {
			const draft = {}
			for (const field of FIELDS) {
				const raw = value === undefined || value === null ? undefined : value[field.key]
				if (field.kind === 'boolean') draft[field.key] = raw === true
				else if (field.kind === 'number') draft[field.key] = raw === undefined ? '' : String(raw)
				else if (field.kind === 'select') draft[field.key] = raw === undefined ? '' : String(raw)
				else if (field.kind === 'windows') draft[field.key] = (field.toText ?? rowsToText)(raw)
				else if (field.kind === 'json') draft[field.key] = (field.toText ?? jsonToText)(raw)
				else draft[field.key] = raw === undefined || raw === null ? '' : String(raw)
			}
			return draft
		}

		/** 编辑草稿 → 设置值。任何一处非法就抛错（整次保存一起失败）。 */
		function valueFromDraft(draft) {
			const value = {}
			for (const field of FIELDS) {
				const raw = draft[field.key]
				if (field.kind === 'boolean') value[field.key] = raw === true
				else if (field.kind === 'number') {
					const n = Number(raw)
					if (Number.isFinite(n) !== true) throw new Error(`${field.label} 必须是数字`)
					value[field.key] = n
				} else if (field.kind === 'windows') value[field.key] = (field.fromText ?? textToRows)(raw)
				else if (field.kind === 'json') value[field.key] = (field.fromText ?? textToJson)(raw)
				else value[field.key] = String(raw ?? '')
			}
			return value
		}

		const LABEL_STYLE = { flex: '0 0 168px', paddingTop: '6px', fontSize: '13px', opacity: 0.92 }
		const HINT_STYLE = { display: 'block', fontSize: '11.5px', opacity: 0.6, marginTop: '3px', lineHeight: 1.45 }
		const CONTROL_STYLE = {
			flex: '1 1 auto',
			minWidth: '0',
			padding: '6px 8px',
			borderRadius: '7px',
			border: '1px solid rgba(255,255,255,0.18)',
			background: 'rgba(0,0,0,0.22)',
			color: 'inherit',
			fontSize: '13px',
			fontFamily: 'inherit',
		}
		const ROW_STYLE = { display: 'flex', gap: '12px', alignItems: 'flex-start', marginBottom: '14px' }
		const BUTTON_STYLE = {
			padding: '6px 14px',
			borderRadius: '7px',
			border: '1px solid rgba(255,255,255,0.24)',
			background: 'rgba(255,255,255,0.06)',
			color: 'inherit',
			cursor: 'pointer',
			fontSize: '13px',
		}

		function fieldControl(field, draft, setField, disabled) {
			const value = draft[field.key]
			const common = { style: { ...CONTROL_STYLE, ...(disabled ? { opacity: 0.55 } : {}) }, disabled: disabled === true }

			if (field.kind === 'boolean') {
				return h('input', {
					type: 'checkbox',
					checked: value === true,
					disabled: disabled === true,
					'data-peak-brief-field': field.key,
					onChange: (event) => setField(field.key, event.target.checked),
				})
			}
			if (field.kind === 'select') {
				return h('select', {
					...common,
					'data-peak-brief-field': field.key,
					value,
					onChange: (event) => setField(field.key, event.target.value),
				}, field.options.map(([key, text]) => h('option', { key, value: key }, text)))
			}
			if (field.kind === 'windows' || field.kind === 'json') {
				return h('textarea', {
					...common,
					'data-peak-brief-field': field.key,
					rows: field.kind === 'windows' ? 3 : 4,
					spellCheck: false,
					style: { ...common.style, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', resize: 'vertical' },
					value,
					onChange: (event) => setField(field.key, event.target.value),
				})
			}
			return h('input', {
				...common,
				type: field.kind === 'number' ? 'number' : 'text',
				'data-peak-brief-field': field.key,
				value,
				onChange: (event) => setField(field.key, event.target.value),
			})
		}

		/**
		 * 「设置 → 峰谷调度」整页。
		 * props.scope 是 Host 命名空间的客户端镜像（由注册时的 inject 提供）。
		 */
		function PeakBriefSettings(props) {
			const scope = props?.scope ?? null
			const snap = useScopeSnapshot(scope)
			const [draft, setDraft] = useState(null)
			const [busy, setBusy] = useState(false)
			const [error, setError] = useState(null)
			const [saved, setSaved] = useState(false)
			const [status, setStatus] = useState(null)

			// 运行状态（相位 / 下次切换）——只读展示，让配置页能立刻反映效果
			useEffect(() => {
				let alive = true
				async function tick() {
					try {
						const next = await fetchState()
						if (alive && next !== null) setStatus(next.status ?? null)
					} catch {
						/* Host 未就绪 */
					}
				}
				void tick()
				const timer = window.setInterval(() => { void tick() }, POLL_MS)
				return () => {
					alive = false
					window.clearInterval(timer)
				}
			}, [])

			const remote = snap?.value
			const writable = snap === null || snap === undefined ? false : snap.writable === true
			const current = draft ?? draftFromValue(remote)

			function setField(key, value) {
				setSaved(false)
				setError(null)
				setDraft({ ...current, [key]: value })
			}

			async function save() {
				if (scope === null) return
				setBusy(true)
				setError(null)
				setSaved(false)
				try {
					const value = valueFromDraft(current)
					const ops = FIELDS.map((field) => ({ op: 'set', path: [field.key], value: value[field.key] }))
					await scope.mutate(ops, snap?.revision)
					setDraft(null)
					setSaved(true)
				} catch (failure) {
					setError(String(failure?.message ?? failure))
				} finally {
					setBusy(false)
				}
			}

			/** 恢复默认：清空所有字段，让它们重新继承 patch 层与 schema 默认值。 */
			async function resetAll() {
				if (scope === null) return
				setBusy(true)
				setError(null)
				setSaved(false)
				try {
					await scope.mutate(FIELDS.map((field) => ({ op: 'unset', path: [field.key] })), snap?.revision)
					setDraft(null)
					setSaved(true)
				} catch (failure) {
					setError(String(failure?.message ?? failure))
				} finally {
					setBusy(false)
				}
			}

			const children = []

			// 运行状态条
			children.push(h('div', {
				key: 'status',
				'data-peak-brief': 'settings-status',
				style: {
					marginBottom: '16px',
					padding: '10px 12px',
					borderRadius: '9px',
					border: '1px solid rgba(255,255,255,0.14)',
					background: 'rgba(255,255,255,0.04)',
					fontSize: '12.5px',
					lineHeight: 1.6,
				},
			},
				h('div', null, status === null
					? '正在读取运行状态…'
					: `当前相位：${status.phase} · ${status.localDate} ${status.localTime} · ${status.dayLabel}`),
				h('div', null, status === null || status.nextSwitch === null
					? '下次切换：—'
					: `下次切换：${status.nextSwitch.date} → ${status.nextSwitch.to}`),
				h('div', null, `门控：${status !== null && status.gate?.blocking === true ? '正在硬拦' : '当前不拦'} · 已拦截 ${status?.gate?.blockedCount ?? 0} 次`),
			))

			if (snap !== null && snap !== undefined && snap.status === 'unavailable') {
				children.push(h('div', {
					key: 'unavailable',
					style: { marginBottom: '14px', fontSize: '12.5px', color: '#f59e0b' },
				}, 'Host 没有暴露 peak-brief 设置命名空间（可能插件未加载完成）。此页只读。'))
			}

			// 字段
			children.push(h('div', { key: 'fields' }, FIELDS.map((field) => h('div', { key: field.key, style: ROW_STYLE },
				h('label', { style: LABEL_STYLE, htmlFor: `pb-${field.key}` },
					field.label,
					field.hint === undefined ? null : h('span', { style: HINT_STYLE }, field.hint),
				),
				h('div', { style: { flex: '1 1 auto', minWidth: '0' } },
					fieldControl(field, current, setField, busy || writable !== true),
				),
			))))

			// 操作区
			children.push(h('div', { key: 'actions', style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
				h('button', {
					type: 'button',
					style: { ...BUTTON_STYLE, opacity: busy ? 0.6 : 1 },
					disabled: busy || writable !== true,
					'data-peak-brief-action': 'save',
					onClick: () => { void save() },
				}, busy ? '保存中…' : '保存'),
				h('button', {
					type: 'button',
					style: { ...BUTTON_STYLE, opacity: busy ? 0.6 : 1 },
					disabled: busy || writable !== true,
					'data-peak-brief-action': 'reset',
					onClick: () => { void resetAll() },
				}, '恢复默认'),
				h('button', {
					type: 'button',
					style: BUTTON_STYLE,
					'data-peak-brief-action': 'close',
					onClick: () => { if (typeof props?.close === 'function') props.close() },
				}, '关闭'),
				error === null ? null : h('span', {
					'data-peak-brief': 'settings-error',
					style: { color: '#ef4444', fontSize: '12.5px' },
				}, error),
				error !== null || saved !== true ? null : h('span', {
					'data-peak-brief': 'settings-saved',
					style: { color: '#34d399', fontSize: '12.5px' },
				}, '已保存并即时生效'),
			))

			return h('div', { 'data-peak-brief': 'settings', style: { padding: '4px 2px 8px' } }, children)
		}

		// ------------------------------------------------------------ 注册

		/**
		 * 诊断上报：把客户端的关键结论写回 Host 的通知槽。
		 *
		 * 目的很实际：浏览器里发生了什么，从后端看不见。把结论写回来之后，
		 * 直接读 GET /api/peak-brief.state 的 notice 就能知道
		 * 「客户端跑了吗 / 设置页挂上了吗 / 失败在哪一步」——
		 * 不需要用户去开开发者工具、也不需要他念任何东西。
		 */
		function reportDiagnostic(status) {
			try {
				// 必须 .catch()：try/catch 抓不到异步 rejection，Host 不可达时
				// 会留下未处理的 promise rejection（测试抓到过）。
				void fetch(`${API}.hello`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ text: `[peak-brief 诊断] ${status}` }),
				}).catch(() => {})
			} catch {
				/* 同步抛也要吞掉：上报失败不影响功能 */
			}
		}

		/**
		 * 把设置页挂进 Settings 的 section 槽位。
		 *
		 * 客户端 cordis 的访问规则（读 dsh-cordis-client-runner 得到）：
		 *   ctx.settingsScope   直接属性访问 —— **必须**在插件 inject 里声明，否则抛错
		 *   ctx.get(name)       可选查找 —— 不要求声明
		 *   ctx.inject(deps,cb) 可选依赖 —— 依赖就绪时回调，并给出允许属性访问的 ctx
		 *
		 * 所以先用 ctx.inject（官方路径，也是宿主侧已验证有效的写法），再退回 ctx.get。
		 * **结论一定上报**：成功报 mounted，失败报确切原因——上一版是静默 return false，
		 * 排查只能靠猜，那是我最该改掉的毛病。
		 */
		function mountSettingsSection(ctx, slots) {
			let reported = false

			function reportFailure(reason) {
				if (reported === true) return
				reported = true
				console.error(`[peak-brief] 设置页未挂载 —— ${reason}`)
				reportDiagnostic(`settings-section: 失败 —— ${reason}`)
			}

			function attempt(settingsScope, where) {
				if (settingsScope === undefined || settingsScope === null) {
					reportFailure(`${where}：settingsScope 不可用（${String(settingsScope)}）`)
					return false
				}
				if (typeof settingsScope.bind !== 'function') {
					reportFailure(`${where}：settingsScope 上没有 bind（${typeof settingsScope.bind}）`)
					return false
				}

				let scope
				try {
					scope = settingsScope.bind({ namespace: SETTINGS_NS })
				} catch (error) {
					reportFailure(`${where}：bind 失败 —— ${error?.message ?? error}`)
					return false
				}

				try {
					ctx.effect(() => slots.inject('settings.section', () => slots.register({
						name: 'settings.section',
						id: PLUGIN_ID,
						order: 150,
						label: () => '峰谷调度',
						inject: () => ({ scope }),
					}, PeakBriefSettings)), 'peak-brief: settings section')
				} catch (error) {
					reportFailure(`${where}：slots.inject 失败 —— ${error?.message ?? error}`)
					return false
				}
				reportDiagnostic(`settings-section: 已注册（${where}）`)
				return true
			}

			if (typeof ctx.inject === 'function') {
				let mounted = false
				ctx.inject(['settingsScope'], (scopedCtx) => {
					mounted = attempt(scopedCtx.settingsScope, 'inject')
				})
				// inject 回调可能因为服务永不可用而从不触发：给一次兜底与自报机会。
				window.setTimeout(() => {
					if (mounted === true || reported === true) return
					const viaGet = typeof ctx.get === 'function' ? ctx.get('settingsScope') : undefined
					if (attempt(viaGet, 'get 兜底') !== true && reported !== true) {
						reportFailure('inject 回调未触发，且 ctx.get 也拿不到 settingsScope')
					}
				}, 2500)
				return
			}

			const viaGet = typeof ctx.get === 'function' ? ctx.get('settingsScope') : undefined
			attempt(viaGet, 'get')
		}

		function apply(ctx) {
			const slots = typeof ctx.get === 'function' ? ctx.get('slots') : undefined
			const hasSlots = slots !== undefined && slots !== null && typeof slots.inject === 'function'

			// 第一件事就上报：如果后端连这条都收不到，说明浏览器根本没加载到新 bundle。
			reportDiagnostic(`client apply 已执行（slots=${hasSlots ? '可用' : '不可用'}）`)

			if (hasSlots) {
				ctx.effect(() => slots.inject('shell.overlay', () => slots.register({
					name: 'shell.overlay',
					id: PLUGIN_ID,
					order: 200,
				}, PeakNotice)), 'peak-brief: shell overlay notice')

				// 注意：两处注册都要做，不能像以前那样注册完浮层就 return。
				mountSettingsSection(ctx, slots)
				return
			}

			// slots 不可用（极少数环境）：退化成自建 fixed 容器，行为一致。
			if (ReactDOM === null || typeof document === 'undefined') {
				console.warn('[peak-brief] slots 与 react-dom 都不可用，UI 未挂载')
				return
			}
			ctx.effect(() => {
				const host = document.createElement('div')
				host.setAttribute('data-peak-brief', 'fallback')
				document.body.appendChild(host)
				const root = typeof ReactDOM.createRoot === 'function' ? ReactDOM.createRoot(host) : null
				if (root !== null) root.render(h(PeakNotice, {}))
				else if (typeof ReactDOM.render === 'function') ReactDOM.render(h(PeakNotice, {}), host)
				return () => {
					try {
						if (root !== null) root.unmount()
						else if (typeof ReactDOM.unmountComponentAtNode === 'function') ReactDOM.unmountComponentAtNode(host)
					} catch { /* 已卸载 */ }
					host.remove()
				}
			}, 'peak-brief: floating fallback notice')
		}

		exports.name = PLUGIN_ID
		exports.inject = []
		exports.apply = apply
		return module.exports
	},
})
