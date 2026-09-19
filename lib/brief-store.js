/**
 * 简报文件存储 —— 简报"用完即弃"的物理载体。
 *
 * 默认落在 `~/.dsh/peak-brief/`：一个**独立文件夹**，不污染任何项目仓库，
 * 也不依赖 DSH 的工作区推断。用完（闲时恢复成功）就删掉。
 *
 * 注意边界：这里删掉的只是**文件**。注入到会话里的那条 `user/message` 受
 * dsh-llm 的 `model-visible ⟺ logged` 约束，无法从会话记录里抹除。
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const BRIEF_FORMAT_VERSION = 1

/** 默认目录：~/.dsh/peak-brief */
export function defaultBriefDir() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'peak-brief')
}

/** 会话 id 可能含路径分隔符或奇怪字符，落盘前必须净化。 */
export function safeFileName(sessionId) {
  const raw = typeof sessionId === 'string' && sessionId !== '' ? sessionId : 'unknown-session'
  return `${raw.replace(/[^A-Za-z0-9._-]/g, '_')}.json`
}

export function briefPathFor(dir, sessionId) {
  return join(dir ?? defaultBriefDir(), safeFileName(sessionId))
}

/** 写简报；返回写入路径。目录不存在时自动创建。 */
export function writeBriefFile(dir, sessionId, payload) {
  const target = briefPathFor(dir, sessionId)
  mkdirSync(dir ?? defaultBriefDir(), { recursive: true })
  const record = {
    version: BRIEF_FORMAT_VERSION,
    plugin: 'dsh-peak-brief',
    writtenAt: new Date().toISOString(),
    ...payload,
  }
  writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return target
}

/** 读简报；不存在或损坏一律返回 null（宁可当作没有，也不要半个简报）。 */
export function readBriefFile(dir, sessionId) {
  const target = briefPathFor(dir, sessionId)
  try {
    if (existsSync(target) !== true) return null
    const parsed = JSON.parse(readFileSync(target, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    if (parsed.version !== BRIEF_FORMAT_VERSION) return null
    if (parsed.brief === null || typeof parsed.brief !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

/** 删简报；返回是否真的删掉了东西。 */
export function deleteBriefFile(dir, sessionId) {
  const target = briefPathFor(dir, sessionId)
  try {
    if (existsSync(target) !== true) return false
    rmSync(target, { force: true })
    return true
  } catch {
    return false
  }
}
