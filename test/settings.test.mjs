import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_CONFIG,
  GATE_MODES,
  NOTIFY_MODES,
  SETTINGS_NAMESPACE,
  createSettingsSchema,
  normalizeConfig,
  schemaJson,
  settingsBaseFrom,
} from '../lib/settings.js'

test('命名空间名必须符合 dsh-settings 的 lower-kebab-case 约束', () => {
  assert.equal(SETTINGS_NAMESPACE, 'peak-brief')
  assert.match(SETTINGS_NAMESPACE, /^[a-z][a-z0-9-]*$/)
})

test('空输入解析成默认值', () => {
  const config = normalizeConfig({})
  assert.deepEqual(config, DEFAULT_CONFIG)
  assert.deepEqual(config.peakWindows, [['09:00', '12:00'], ['14:00', '18:00']])
  assert.equal(config.enabled, false, '默认必须是关闭的：挂载插件本身不该开始拦截')
})

test('解析是幂等的（设置文档不会因为反复解析而漂移）', () => {
  const once = normalizeConfig({ leadMinutes: 20, overrides: { '2027-01-01': 'holiday' } })
  const twice = normalizeConfig(once)
  assert.deepEqual(twice, once)
})

test('非法值一律抛错 —— 这正是"非法配置存不进去"的结构性保证', () => {
  assert.throws(() => normalizeConfig({ timezone: 'Nowhere/Fake' }), /IANA 时区/)
  assert.throws(() => normalizeConfig({ timezone: '' }), /IANA 时区/)
  assert.throws(() => normalizeConfig({ leadMinutes: -1 }), /leadMinutes/)
  assert.throws(() => normalizeConfig({ leadMinutes: 1.5 }), /leadMinutes/)
  assert.throws(() => normalizeConfig({ leadMinutes: '10' }), /leadMinutes/)
  assert.throws(() => normalizeConfig({ enabled: 'yes' }), /enabled/)
  assert.throws(() => normalizeConfig({ blockAuxiliary: 1 }), /blockAuxiliary/)
  assert.throws(() => normalizeConfig({ gateMode: '随便' }), /gateMode/)
  assert.throws(() => normalizeConfig({ notify: 'sms' }), /notify/)
  assert.throws(() => normalizeConfig({ peakWindows: [['09:00', '12:00'], ['11:00', '13:00']] }), /重叠/)
  assert.throws(() => normalizeConfig({ peakWindows: [['12:00', '09:00']] }), /结束时刻必须晚于开始时刻/)
  assert.throws(() => normalizeConfig({ peakWindows: [['9点', '12:00']] }), /无法解析时刻/)
  assert.throws(() => normalizeConfig({ overrides: 'off' }), /overrides 必须是对象/)
  assert.throws(() => normalizeConfig({ overrides: { '2027/01/01': 'off' } }), /YYYY-MM-DD/)
  assert.throws(() => normalizeConfig({ overrides: { '2027-01-01': '放假' } }), /off \/ peak/)
  assert.throws(() => normalizeConfig({ holidayRefresh: { enabled: 'yes' } }), /holidayRefresh.enabled/)
  assert.throws(() => normalizeConfig({ holidayRefresh: { enabled: true, url: 5 } }), /holidayRefresh.url/)
  assert.throws(() => normalizeConfig({ brief: { maxInputBytes: 0 } }), /brief.maxInputBytes/)
})

test('时段被规范化成字符串对并排序（落盘形状稳定）', () => {
  const config = normalizeConfig({ peakWindows: [['14:00', '18:00'], ['9:05', '12:00']] })
  assert.deepEqual(config.peakWindows, [['09:05', '12:00'], ['14:00', '18:00']])
})

test('overrides 的同义写法被归一化成 off / peak', () => {
  const config = normalizeConfig({
    overrides: {
      '2027-01-01': 'HOLIDAY',
      '2027-01-02': ' rest ',
      '2027-02-06': 'workday',
      '2027-02-07': 'peak',
      '2027-02-08': 'none',
    },
  })
  assert.deepEqual(config.overrides, {
    '2027-01-01': 'off',
    '2027-01-02': 'off',
    '2027-02-06': 'peak',
    '2027-02-07': 'peak',
    '2027-02-08': 'off',
  })
})

test('非对象输入退回默认值，而不是崩', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.deepEqual(normalizeConfig(bad), DEFAULT_CONFIG)
  }
})

test('未知字段被忽略（不因为一个多余字段就让整份配置注册失败）', () => {
  const config = normalizeConfig({ enabled: true, 未来字段: 1 })
  assert.equal(config.enabled, true)
  assert.equal('未来字段' in config, false)
})

test('schema 可调用，并且在非法输入上抛错（dsh-settings 的写入路径依赖这一点）', () => {
  const schema = createSettingsSchema()
  assert.equal(typeof schema, 'function')

  const resolved = schema({ leadMinutes: 15 })
  assert.equal(resolved.leadMinutes, 15)
  assert.equal(resolved.timezone, DEFAULT_CONFIG.timezone, '未提供的字段要用默认值补齐')
  assert.throws(() => schema({ leadMinutes: -1 }), /leadMinutes/)
})

test('schema.toJSON 给出配置界面能读懂的结构', () => {
  const schema = createSettingsSchema()
  assert.equal(typeof schema.toJSON, 'function')
  const json = schema.toJSON()
  assert.equal(json.type, 'object')
  assert.equal(json.additionalProperties, false)
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    assert.ok(json.properties[key], `schema 必须覆盖 ${key}`)
  }
  assert.deepEqual(json.properties.gateMode.enum, GATE_MODES)
  assert.deepEqual(json.properties.notify.enum, NOTIFY_MODES)
  // 必须能被 JSON 序列化（要走 Remote 线）
  assert.equal(typeof JSON.stringify(json), 'string')
  assert.deepEqual(schemaJson().properties.leadMinutes.type, 'number')
})

test('settingsBaseFrom 只取受设置管辖的字段', () => {
  const base = settingsBaseFrom({ leadMinutes: 25, 别的插件字段: 'x', enabled: true })
  assert.deepEqual(base, { leadMinutes: 25, enabled: true })
  assert.deepEqual(settingsBaseFrom(undefined), {})
  assert.deepEqual(settingsBaseFrom(null), {})
  assert.deepEqual(settingsBaseFrom('nope'), {})
})

test('base 层参与解析：清空用户层会回退到 patch 里的值', () => {
  const schema = createSettingsSchema()
  const base = settingsBaseFrom({ leadMinutes: 25, timezone: 'UTC' })
  // 用户层为空 → 解析出 base
  const inherited = schema({ ...base })
  assert.equal(inherited.leadMinutes, 25)
  assert.equal(inherited.timezone, 'UTC')
  // 用户层覆盖 → 以用户层为准
  const overridden = schema({ ...base, leadMinutes: 5 })
  assert.equal(overridden.leadMinutes, 5)
  assert.equal(overridden.timezone, 'UTC', '没覆盖的字段仍继承 base')
})
