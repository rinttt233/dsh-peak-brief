import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BRIEF_FORMAT_VERSION,
  briefPathFor,
  defaultBriefDir,
  deleteBriefFile,
  readBriefFile,
  safeFileName,
  writeBriefFile,
} from '../lib/brief-store.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'peak-brief-test-'))
}

test('safeFileName 净化路径分隔符与奇怪字符', () => {
  assert.equal(safeFileName('session-abc_1.2'), 'session-abc_1.2.json')
  assert.equal(safeFileName('a/b\\c:d*e'), 'a_b_c_d_e.json')
  assert.equal(safeFileName(''), 'unknown-session.json')
  assert.equal(safeFileName(null), 'unknown-session.json')
  assert.equal(safeFileName('..'), '...json', '不得产生可穿越路径的名字')
})

test('defaultBriefDir 落在 DSH_HOME 下的独立文件夹', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = 'C:/tmp/fake-dsh-home'
  try {
    assert.equal(defaultBriefDir(), join('C:/tmp/fake-dsh-home', 'peak-brief'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('简报写读往返', () => {
  const dir = tempDir()
  try {
    const brief = { objective: '做完 P3', status: 'in_progress', resumable: true }
    const path = writeBriefFile(dir, 'sess-1', { brief, meta: { pausedAt: 'P' } })
    assert.equal(path, briefPathFor(dir, 'sess-1'))

    const read = readBriefFile(dir, 'sess-1')
    assert.equal(read.version, BRIEF_FORMAT_VERSION)
    assert.equal(read.plugin, 'dsh-peak-brief')
    assert.deepEqual(read.brief, brief)
    assert.equal(read.meta.pausedAt, 'P')
    assert.equal(typeof read.writtenAt, 'string')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('目录不存在时自动创建', () => {
  const dir = join(tempDir(), 'nested', 'deeper')
  try {
    mkdirSync(dir, { recursive: true })
    rmSync(dir, { recursive: true, force: true })
    writeBriefFile(dir, 's', { brief: { objective: 'x' } })
    assert.ok(readBriefFile(dir, 's') !== null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('读不到 / 损坏 / 版本不符 一律返回 null，绝不返回半个简报', () => {
  const dir = tempDir()
  try {
    assert.equal(readBriefFile(dir, 'missing'), null)

    writeFileSync(briefPathFor(dir, 'bad-json'), '{ 不是 json', 'utf8')
    assert.equal(readBriefFile(dir, 'bad-json'), null)

    writeFileSync(briefPathFor(dir, 'no-brief'), JSON.stringify({ version: BRIEF_FORMAT_VERSION }), 'utf8')
    assert.equal(readBriefFile(dir, 'no-brief'), null)

    writeFileSync(
      briefPathFor(dir, 'old-version'),
      JSON.stringify({ version: BRIEF_FORMAT_VERSION + 1, brief: { objective: 'x' } }),
      'utf8',
    )
    assert.equal(readBriefFile(dir, 'old-version'), null, '版本不符说明格式已变，不能猜')

    writeFileSync(briefPathFor(dir, 'not-object'), JSON.stringify([1, 2, 3]), 'utf8')
    assert.equal(readBriefFile(dir, 'not-object'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('删除是幂等的，并如实报告是否删掉了东西', () => {
  const dir = tempDir()
  try {
    writeBriefFile(dir, 'sess-x', { brief: { objective: 'x' } })
    assert.equal(readBriefFile(dir, 'sess-x') !== null, true)
    assert.equal(deleteBriefFile(dir, 'sess-x'), true)
    assert.equal(readBriefFile(dir, 'sess-x'), null)
    assert.equal(deleteBriefFile(dir, 'sess-x'), false, '再删一次应当返回 false')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
