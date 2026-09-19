/**
 * 打包体检 —— 证明"发出去的那个 tarball 是自包含的"。
 *
 * 为什么需要它：`files` 漏目录这种事，本地测试全绿也发现不了 —— 因为本地测试读的是
 * **工作区**，而用户装的是 **tarball**。这个脚本把 npm 真正会发出的东西打出来、
 * 解到临时目录，然后在那个目录里跑完整的测试与验收：数据文件、节假日生成器、
 * 客户端 bundle 一个都不能少。
 *
 * 用法：npm run verify:package
 * 退出码：0 全部通过；1 有一步失败（会指出是哪一步）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const JSON_MODE = process.argv.includes('--json')

const results = []
function step(name, ok, detail) {
  results.push({ name, ok, detail })
  if (JSON_MODE !== true) {
    const mark = ok ? 'PASS' : 'FAIL'
    console.log(`  [${mark}] ${name}${detail === undefined ? '' : `\n         · ${detail}`}`)
  }
}

/** 跑一条命令；返回 { ok, code, out, err }。 */
function run(command, { cwd = ROOT } = {}) {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    ok: result.status === 0,
    code: result.status,
    out: String(result.stdout ?? ''),
    err: String(result.stderr ?? ''),
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'dsh-peak-brief-verify-'))
let failed = 0

try {
  console.log('打包体检：pack -> 解包 -> 在解出来的副本里跑测试与验收')
  console.log(`  临时目录 ${tmp}`)

  // ---- 1) npm pack：拿到 tarball，再用 tar 列出真实条目（以归档为准，不信 npm 的 JSON） ----
  const pack = run(`npm pack --pack-destination "${tmp}"`)
  const tarballName = pack.out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.tgz'))
    .pop()
  if (pack.ok !== true || tarballName === undefined) {
    step('npm pack 成功', false, (pack.err || pack.out).trim().split('\n').slice(-6).join(' | '))
    throw new Error('pack failed')
  }
  const tarball = join(tmp, tarballName)
  const listing = run(`tar -tzf "${tarball}"`)
  if (listing.ok !== true) {
    step('npm pack 成功（归档可读）', false, (listing.err || '').trim().split('\n').slice(-4).join(' | '))
    throw new Error('tar listing failed')
  }
  const packed = listing.out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && line.endsWith('/') !== true)
    .map((line) => line.replace(/^package\//, ''))
    .sort()
  step('npm pack 成功', true, `${tarballName} · ${packed.length} 个文件 · ${statSync(tarball).size} 字节`)

  // ---- 2) 清单里必须有运行期与脚本期真正需要的东西 ----
  const must = [
    'package.json',
    'README.md',
    'LICENSE',
    'cordis.patch.yml',
    'lib/index.js',
    'lib/client.js',
    'lib/holidays.js',
    'scripts/acceptance.mjs',
    'scripts/build-holidays.mjs',
    'data/2025.json',
    'data/2026.json',
  ]
  const missing = must.filter((f) => packed.includes(f) !== true)
  step(
    'tarball 含全部必需文件',
    missing.length === 0,
    missing.length === 0 ? `${packed.length} 个文件，含 scripts/ 与 data/` : `缺少：${missing.join(', ')}`,
  )

  // ---- 3) 解包 ----
  const extract = join(tmp, 'extract')
  const untar = run(`mkdir "${extract}" && tar -xzf "${tarball}" -C "${extract}"`)
  if (untar.ok !== true) {
    step('解包成功', false, (untar.err || untar.out).trim().split('\n').slice(-4).join(' | '))
    throw new Error('untar failed')
  }
  const copy = join(extract, 'package')
  step('解包成功', existsSync(join(copy, 'lib', 'index.js')), `副本在 ${copy}`)

  // ---- 4) lib/ 里不许出现 npm 裸导入（零依赖是硬约束） ----
  const libFiles = ['index.js', 'client.js', 'brief.js', 'brief-store.js', 'calendar.js', 'gate.js', 'holidays.js', 'resume.js', 'settings.js', 'tz.js', 'windows.js']
  const bare = []
  for (const file of libFiles) {
    const text = readFileSync(join(copy, 'lib', file), 'utf8')
    for (const match of text.matchAll(/(?:^|\n)\s*import\s[^\n]*?from\s+'([^']+)'/g)) {
      const spec = match[1]
      if (spec.startsWith('.') !== true && spec.startsWith('node:') !== true) bare.push(`${file} -> ${spec}`)
    }
  }
  step(
    'lib/ 只 import 相对路径与 node: 内置模块',
    bare.length === 0,
    bare.length === 0 ? `${libFiles.length} 个文件检查完毕，无 npm 依赖` : bare.join(', '),
  )

  // ---- 5) 在副本里跑完整测试 ----
  const tests = run('node --test', { cwd: copy })
  const summary = (tests.out.match(/^ℹ (tests|pass|fail) \d+$/gm) ?? []).join(' ')
  step('副本里 node --test 全通过', tests.ok === true, summary === '' ? (tests.err || '').trim().split('\n').slice(-4).join(' | ') : summary)

  // ---- 6) 在副本里跑验收 ----
  const accept = run('node scripts/acceptance.mjs', { cwd: copy })
  const lastLine = accept.out.trim().split('\n').slice(-2).join(' / ')
  step('副本里 npm run accept 通过', accept.ok === true, lastLine)

  // ---- 7) 节假日生成器能重跑，且产出与盘上一致（data/ 真的进包了） ----
  const before = readFileSync(join(copy, 'lib', 'holidays.js'), 'utf8')
  const build = run('node scripts/build-holidays.mjs', { cwd: copy })
  const after = readFileSync(join(copy, 'lib', 'holidays.js'), 'utf8')
  step(
    'scripts/build-holidays.mjs 可重跑且产出稳定',
    build.ok === true && before === after,
    build.ok !== true
      ? (build.err || build.out).trim().split('\n').slice(-4).join(' | ')
      : before === after ? '重跑后 lib/holidays.js 字节不变' : '重跑后 lib/holidays.js 变了（内置表与 data/ 不一致）',
  )

  for (const r of results) if (r.ok !== true) failed += 1
} catch (error) {
  failed += 1
  if (JSON_MODE !== true) console.log(`  [FAIL] 体检中断：${error?.message ?? error}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

if (JSON_MODE === true) console.log(JSON.stringify({ ok: failed === 0, results }, null, 2))
else console.log(failed === 0 ? '\n打包体检：全部通过（tarball 自包含）。' : `\n打包体检：${failed} 项失败。`)

process.exit(failed === 0 ? 0 : 1)
