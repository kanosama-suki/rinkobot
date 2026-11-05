/**
 * 状态系统的确定性序列化与哈希。
 *
 * 快照逐字节比较依赖这里的规则，因此不使用可能随环境变化的格式化方式，
 * 也不把系统时间或随机数混进快照字节。调用方必须先构造完整对象。
 */

import { createHash } from 'node:crypto'

import type { StateSnapshot } from './types.ts'

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue }

export function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonicalValue(value))
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function snapshotCoreJson(snapshot: Omit<StateSnapshot, 'stateHash'>): string {
  return canonicalJson({
    schemaVersion: snapshot.schemaVersion,
    state: snapshot.state,
    lastSequence: snapshot.lastSequence,
    lastEventId: snapshot.lastEventId,
    generatedAt: snapshot.generatedAt,
  })
}

export function snapshotJson(snapshot: StateSnapshot): string {
  return canonicalJson(snapshot)
}

function toCanonicalValue(value: unknown): CanonicalValue {
  if (value === null) return null
  if (typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonical JSON does not support non-finite numbers')
    }
    // 统一负零，避免 -0 与 0 生成不同字节。
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) {
    return value.map(toCanonicalValue)
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const result: { [key: string]: CanonicalValue } = {}
    for (const key of Object.keys(record).sort()) {
      const item = record[key]
      if (item === undefined) {
        throw new TypeError(`canonical JSON does not support undefined at key "${key}"`)
      }
      result[key] = toCanonicalValue(item)
    }
    return result
  }
  throw new TypeError(`canonical JSON does not support ${typeof value}`)
}
