/**
 * 从 data/<year>.json 生成 lib/holidays.js（内置兜底节假日表）。
 *
 * 数据来源：chinese-days（MIT, © 2024 Yawei sun），其内容跟随国务院发布的
 * 节假日安排。原始年份 JSON 原样放在 data/ 下以便追溯，本脚本只做去噪：
 * 丢掉英文名与内部层级编号，只保留「日期 → 中文简称」。
 *
 *   node scripts/build-holidays.mjs
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const dataDir = join(root, 'data')
const outFile = join(root, 'lib', 'holidays.js')

/** "New Year's Day,元旦,1" -> "元旦" */
function shortName(value) {
  const parts = String(value).split(',')
  return parts.length >= 2 && parts[1] !== '' ? parts[1] : String(value)
}

function pick(source) {
  const out = {}
  for (const date of Object.keys(source ?? {}).sort()) out[date] = shortName(source[date])
  return out
}

const years = readdirSync(dataDir)
  .filter((f) => /^\d{4}\.json$/.test(f))
  .map((f) => Number(f.slice(0, 4)))
  .sort((a, b) => a - b)

if (years.length === 0) {
  console.error('build-holidays: data/ 下没有 <year>.json')
  process.exit(1)
}

const table = {}
for (const year of years) {
  const raw = JSON.parse(readFileSync(join(dataDir, `${year}.json`), 'utf8'))
  table[year] = { holidays: pick(raw.holidays), workdays: pick(raw.workdays) }
}

/**
 * 数据指纹：对 data/ 原始文件取 sha256，取前 12 位。
 *
 * 这里**故意不放生成时间**。此前头部写的是 `生成时间：<new Date().toISOString()>`，
 * 后果是每次重跑都产生一条假的 diff —— 于是"重跑生成器再 diff"这个最自然的
 * 漂移检查完全失效（打包体检就是在这里抓到它的）。指纹是确定性的：既记录了
 * 这份内置表出自哪一版数据，又让重跑变成幂等操作。
 */
const fingerprint = createHash('sha256')
for (const year of years) fingerprint.update(readFileSync(join(dataDir, `${year}.json`)))
const digest = fingerprint.digest('hex').slice(0, 12)

const lines = []
lines.push('/**')
lines.push(' * 内置兜底节假日表 —— 由 scripts/build-holidays.mjs 自动生成，请勿手改。')
lines.push(' *')
lines.push(' *   holidays: 法定节假日（放假，全天闲时）')
lines.push(' *   workdays: 调休上班日（周末被调整为工作日；按本插件规则同样全天闲时）')
lines.push(' *')
lines.push(` * 数据来源：chinese-days（MIT）· 覆盖年份：${years.join(', ')}`)
lines.push(` * 数据指纹：sha256(data/*.json)[0:12] = ${digest}`)
lines.push(' *')
lines.push(' * 数据年份之外的日期一律走「未知年份降级」路径，绝不按错误日历执行。')
lines.push(' */')
lines.push('')
lines.push('export const BUNDLED_YEARS = [' + years.join(', ') + ']')
lines.push('')
lines.push('export const BUNDLED = {')
for (const year of years) {
  lines.push(`  ${year}: {`)
  for (const section of ['holidays', 'workdays']) {
    const entries = Object.entries(table[year][section])
    lines.push(`    ${section}: {`)
    for (const [date, name] of entries) {
      lines.push(`      '${date}': '${name}',`)
    }
    lines.push('    },')
  }
  lines.push('  },')
}
lines.push('}')
lines.push('')

writeFileSync(outFile, lines.join('\n'), 'utf8')

const counts = years.map((y) => `${y}: 假日 ${Object.keys(table[y].holidays).length} / 调休 ${Object.keys(table[y].workdays).length}`)
console.log(`build-holidays: 写入 ${outFile}`)
for (const line of counts) console.log('  ' + line)
