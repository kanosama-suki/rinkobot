/**
 * 快照构造、持久化与严格读取。
 *
 * 快照 id 是规范 JSON 的 SHA-256；stateHash 只覆盖状态与位置元数据。
 * 读取时同时校验 hash、规范字节和数据库冗余列，任何不一致都视为损坏，
 * 不回退到更旧快照。
 */

import type { DatabaseSync } from 'node:sqlite'

import {
  canonicalJson,
  sha256Hex,
  snapshotCoreJson,
  snapshotJson,
  validateLifeState,
  validateStateSnapshot,
} from '../state/index.ts'
import type { LifeState, StateSnapshot } from '../state/index.ts'
import { StorageIntegrityError } from './errors.ts'
import type { SnapshotResult } from './types.ts'

export const INITIAL_SNAPSHOT_TIME = '1970-01-01T00:00:00.000Z'

export function buildSnapshot(
  state: LifeState,
  lastSequence: number,
  lastEventId: string | null,
  generatedAt: string | null,
): SnapshotResult {
  const validState = validateLifeState(state)
  if (!Number.isInteger(lastSequence) || lastSequence < 0) {
    throw new RangeError('snapshot sequence must be a non-negative integer')
  }
  if ((lastSequence === 0) !== (lastEventId === null)) {
    throw new RangeError('snapshot event ID must be null exactly at sequence zero')
  }
  let at = INITIAL_SNAPSHOT_TIME
  if (lastSequence > 0) {
    if (generatedAt === null) {
      throw new RangeError('non-empty snapshot requires an event timestamp')
    }
    at = generatedAt
  }

  const core: Omit<StateSnapshot, 'stateHash'> = {
    schemaVersion: 1,
    state: validState,
    lastSequence,
    lastEventId,
    generatedAt: at,
  }
  const snapshot: StateSnapshot = {
    ...core,
    stateHash: sha256Hex(snapshotCoreJson(core)),
  }
  const json = snapshotJson(snapshot)
  validateStateSnapshot(snapshot, json)
  return { snapshot, json }
}

export function writeSnapshot(db: DatabaseSync, result: SnapshotResult): void {
  const { snapshot, json } = result
  db.prepare(
    `INSERT INTO snapshots
      (id, schema_version, last_sequence, last_event_id, generated_at, state_hash, snapshot_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sha256Hex(json),
    snapshot.schemaVersion,
    snapshot.lastSequence,
    snapshot.lastEventId,
    snapshot.generatedAt,
    snapshot.stateHash,
    json,
  )
}

export function readLatestSnapshot(db: DatabaseSync): SnapshotResult | null {
  const row = db.prepare(
    `SELECT id, schema_version, last_sequence, last_event_id, generated_at,
            state_hash, snapshot_json
     FROM snapshots
     ORDER BY last_sequence DESC
     LIMIT 1`,
  ).get() as Record<string, unknown> | undefined
  if (row === undefined) return null
  return parseSnapshotRow(row)
}

export function deleteAllSnapshots(db: DatabaseSync): number {
  const result = db.prepare('DELETE FROM snapshots').run()
  return Number(result.changes)
}

export function countSnapshots(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM snapshots').get() as Record<
    string,
    unknown
  >
  return Number(row.count)
}

function parseSnapshotRow(row: Record<string, unknown>): SnapshotResult {
  const json = row.snapshot_json
  if (typeof json !== 'string') {
    throw new StorageIntegrityError('snapshot_json is not text', ':snapshots:')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    throw new StorageIntegrityError(
      'snapshot_json is not valid JSON',
      ':snapshots:',
      error,
    )
  }

  let snapshot: StateSnapshot
  try {
    snapshot = validateStateSnapshot(parsed, json)
  } catch (error) {
    throw new StorageIntegrityError(
      `snapshot validation failed: ${error instanceof Error ? error.message : String(error)}`,
      ':snapshots:',
      error,
    )
  }
  const id = sha256Hex(json)
  const rowMatches =
    row.id === id &&
    Number(row.schema_version) === snapshot.schemaVersion &&
    Number(row.last_sequence) === snapshot.lastSequence &&
    row.last_event_id === snapshot.lastEventId &&
    row.generated_at === snapshot.generatedAt &&
    row.state_hash === snapshot.stateHash &&
    canonicalJson(parsed) === json
  if (!rowMatches) {
    throw new StorageIntegrityError(
      'snapshot columns or canonical bytes do not match its content',
      ':snapshots:',
    )
  }
  return { snapshot, json }
}
