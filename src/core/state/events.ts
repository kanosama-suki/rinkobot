/**
 * StateEvent、Appraisal、PolicyDecision、MemoryRecord 和 Tombstone 的严格校验。
 *
 * 这是持久化前和回放时的共同门禁。未知字段、非法枚举、越界数字和非 UTC
 * 时间都必须暴露为 StateValidationError，不能留到 reducer 里靠兜底处理。
 */

import { parseInstant } from './clock.ts'
import { sha256Hex, snapshotCoreJson, snapshotJson } from './canonical.ts'
import {
  APPRAISAL_SCHEMA_VERSION,
  MEMORY_SCHEMA_VERSION,
  POLICY_DECISION_SCHEMA_VERSION,
  STATE_EVENT_SCHEMA_VERSION,
  STATE_SNAPSHOT_SCHEMA_VERSION,
  TOMBSTONE_SCHEMA_VERSION,
} from './types.ts'
import type {
  Activity,
  Appraisal,
  Commitment,
  CommitmentCreatedPayload,
  CommitmentResolvedPayload,
  EventSource,
  LifeState,
  MemoryRecord,
  PolicyDecision,
  RelationshipAdjustedPayload,
  StateEvent,
  StateEventPayload,
  StateSnapshot,
  TickPayload,
  Tombstone,
} from './types.ts'

const EVENT_SOURCES: readonly EventSource[] = [
  'user',
  'rinko',
  'system',
  'owner',
  'tick',
  'browser',
]

const ACTIVITIES: readonly Activity[] = [
  'idle',
  'talking',
  'reading',
  'resting',
  'away',
  'busy',
]

const EVENT_SOURCES_BY_TYPE = {
  tick: ['tick'],
  'activity.changed': ['system', 'rinko'],
  'appraisal.recorded': ['system', 'rinko'],
  'interaction.recorded': ['user', 'owner', 'rinko', 'system'],
  'relationship.adjusted': ['owner', 'system'],
  'commitment.created': ['user', 'owner', 'rinko', 'system'],
  'commitment.resolved': ['user', 'owner', 'rinko', 'system'],
} as const satisfies Record<string, readonly EventSource[]>

const EVENT_TYPES = Object.keys(EVENT_SOURCES_BY_TYPE)

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const REASON_CODE = /^[a-z][a-z0-9_.-]{0,127}$/

export class StateValidationError extends Error {
  readonly field: string

  constructor(field: string, message: string) {
    super(`${field}: ${message}`)
    this.name = 'StateValidationError'
    this.field = field
  }
}

export function validateStateEvent(value: unknown): StateEvent {
  const event = asRecord(value, '$event')
  knownKeys(event, [
    'eventId',
    'schemaVersion',
    'occurredAt',
    'source',
    'type',
    'payload',
    'evidenceRefs',
    'confidence',
  ], '$event')

  const eventId = requireIdentifier(event, 'eventId', '$.eventId')
  requireLiteralInteger(event, 'schemaVersion', '$.schemaVersion', STATE_EVENT_SCHEMA_VERSION)
  const occurredAt = requireInstant(event, 'occurredAt', '$.occurredAt')
  const source = requireEnum(event, 'source', '$.source', EVENT_SOURCES)
  const type = requireString(event, 'type', '$.type', 1, 64)
  if (!EVENT_TYPES.includes(type)) {
    fail('$.type', `unknown state event type "${type}"`)
  }
  const allowedSources = EVENT_SOURCES_BY_TYPE[type as keyof typeof EVENT_SOURCES_BY_TYPE]
  if (!allowedSources.includes(source)) {
    fail('$.source', `source "${source}" is not allowed for event type "${type}"`)
  }
  const payload = validatePayload(type, event.payload)
  const evidenceRefs = requireIdentifierArray(event, 'evidenceRefs', '$.evidenceRefs')
  const confidence = requireNumber(event, 'confidence', '$.confidence', 0, 1)

  return {
    eventId,
    schemaVersion: STATE_EVENT_SCHEMA_VERSION,
    occurredAt,
    source,
    type,
    payload,
    evidenceRefs,
    confidence,
  } as StateEvent
}

export function validateLifeState(value: unknown): LifeState {
  const state = asRecord(value, '$.state')
  knownKeys(state, [
    'activity',
    'affect',
    'energy',
    'socialBattery',
    'relationship',
    'attention',
    'commitments',
  ], '$.state')
  const activity = requireEnum(state, 'activity', '$.state.activity', ACTIVITIES)
  const affect = asRecord(state.affect, '$.state.affect')
  knownKeys(affect, ['valence', 'arousal'], '$.state.affect')
  const relationship = asRecord(state.relationship, '$.state.relationship')
  knownKeys(
    relationship,
    ['closeness', 'hurt', 'repairNeeded'],
    '$.state.relationship',
  )
  const attention = asRecord(state.attention, '$.state.attention')
  knownKeys(attention, ['busyUntil'], '$.state.attention')
  if (!Array.isArray(state.commitments)) {
    fail('$.state.commitments', 'expected an array')
  }
  const commitments = state.commitments.map((item, index) =>
    validateCommitment(item, `$.state.commitments[${index}]`),
  )
  const ids = new Set(commitments.map(item => item.id))
  if (ids.size !== commitments.length) {
    fail('$.state.commitments', 'duplicate commitment IDs are not allowed')
  }

  return {
    activity,
    affect: {
      valence: requireNumber(affect, 'valence', '$.state.affect.valence', -1, 1),
      arousal: requireNumber(affect, 'arousal', '$.state.affect.arousal', 0, 1),
    },
    energy: requireNumber(state, 'energy', '$.state.energy', 0, 1),
    socialBattery: requireNumber(
      state,
      'socialBattery',
      '$.state.socialBattery',
      0,
      1,
    ),
    relationship: {
      closeness: requireNumber(
        relationship,
        'closeness',
        '$.state.relationship.closeness',
        0,
        1,
      ),
      hurt: requireNumber(relationship, 'hurt', '$.state.relationship.hurt', 0, 1),
      repairNeeded: requireBoolean(
        relationship,
        'repairNeeded',
        '$.state.relationship.repairNeeded',
      ),
    },
    attention: {
      busyUntil: requireNullableInstant(
        attention,
        'busyUntil',
        '$.state.attention.busyUntil',
      ),
    },
    commitments,
  }
}

export function validateStateSnapshot(
  value: unknown,
  serialized?: string,
): StateSnapshot {
  const snapshot = asRecord(value, '$.snapshot')
  knownKeys(
    snapshot,
    [
      'schemaVersion',
      'state',
      'lastSequence',
      'lastEventId',
      'generatedAt',
      'stateHash',
    ],
    '$.snapshot',
  )
  requireLiteralInteger(
    snapshot,
    'schemaVersion',
    '$.snapshot.schemaVersion',
    STATE_SNAPSHOT_SCHEMA_VERSION,
  )
  const state = validateLifeState(snapshot.state)
  const lastSequence = requireInteger(
    snapshot,
    'lastSequence',
    '$.snapshot.lastSequence',
    0,
    Number.MAX_SAFE_INTEGER,
  )
  const lastEventId = requireNullableIdentifier(
    snapshot,
    'lastEventId',
    '$.snapshot.lastEventId',
  )
  if ((lastSequence === 0) !== (lastEventId === null)) {
    fail(
      '$.snapshot.lastEventId',
      'lastEventId must be null exactly when lastSequence is zero',
    )
  }
  const generatedAt = requireInstant(
    snapshot,
    'generatedAt',
    '$.snapshot.generatedAt',
  )
  const stateHash = requireString(
    snapshot,
    'stateHash',
    '$.snapshot.stateHash',
    64,
    64,
  )
  if (!/^[0-9a-f]{64}$/.test(stateHash)) {
    fail('$.snapshot.stateHash', 'expected a lowercase SHA-256 hex digest')
  }

  const result: StateSnapshot = {
    schemaVersion: STATE_SNAPSHOT_SCHEMA_VERSION,
    state,
    lastSequence,
    lastEventId,
    generatedAt,
    stateHash,
  }
  const expectedHash = sha256Hex(
    snapshotCoreJson({
      schemaVersion: result.schemaVersion,
      state: result.state,
      lastSequence: result.lastSequence,
      lastEventId: result.lastEventId,
      generatedAt: result.generatedAt,
    }),
  )
  if (stateHash !== expectedHash) {
    fail('$.snapshot.stateHash', 'snapshot state hash does not match its content')
  }
  // 数据库里保存的是规范 JSON；如果字节不是规范形式，说明文件被外部改动或损坏。
  const canonical = snapshotJson(result)
  if (serialized !== undefined && serialized !== canonical) {
    fail('$.snapshot', 'stored snapshot JSON is not canonical')
  }
  return result
}

export function validateAppraisal(value: unknown): Appraisal {
  const appraisal = asRecord(value, '$.appraisal')
  knownKeys(
    appraisal,
    ['schemaVersion', 'valence', 'arousal', 'confidence', 'summaryRef', 'evidenceRefs'],
    '$.appraisal',
  )
  requireLiteralInteger(
    appraisal,
    'schemaVersion',
    '$.appraisal.schemaVersion',
    APPRAISAL_SCHEMA_VERSION,
  )
  const valence = requireNumber(appraisal, 'valence', '$.appraisal.valence', -1, 1)
  const arousal = requireNumber(appraisal, 'arousal', '$.appraisal.arousal', 0, 1)
  const confidence = requireNumber(
    appraisal,
    'confidence',
    '$.appraisal.confidence',
    0,
    1,
  )
  const evidenceRefs = requireIdentifierArray(
    appraisal,
    'evidenceRefs',
    '$.appraisal.evidenceRefs',
  )
  const summaryRef = optionalIdentifier(appraisal, 'summaryRef', '$.appraisal.summaryRef')

  return {
    schemaVersion: APPRAISAL_SCHEMA_VERSION,
    valence,
    arousal,
    confidence,
    evidenceRefs,
    ...(summaryRef === undefined ? {} : { summaryRef }),
  }
}

export function validatePolicyDecision(value: unknown): PolicyDecision {
  const decision = asRecord(value, '$.decision')
  knownKeys(
    decision,
    ['schemaVersion', 'allowed', 'reasonCode', 'constraints', 'decidedAt'],
    '$.decision',
  )
  requireLiteralInteger(
    decision,
    'schemaVersion',
    '$.decision.schemaVersion',
    POLICY_DECISION_SCHEMA_VERSION,
  )
  const allowed = requireBoolean(decision, 'allowed', '$.decision.allowed')
  const reasonCode = requireString(
    decision,
    'reasonCode',
    '$.decision.reasonCode',
    1,
    128,
  )
  if (!REASON_CODE.test(reasonCode)) {
    fail('$.decision.reasonCode', 'expected a lowercase reason code')
  }
  const constraints = asRecord(decision.constraints, '$.decision.constraints')
  knownKeys(constraints, ['maxReplyChars', 'deferUntil'], '$.decision.constraints')
  const maxReplyChars =
    constraints.maxReplyChars === undefined
      ? undefined
      : requireInteger(
          constraints,
          'maxReplyChars',
          '$.decision.constraints.maxReplyChars',
          1,
          10_000,
        )
  const deferUntil =
    constraints.deferUntil === undefined
      ? undefined
      : requireInstant(constraints, 'deferUntil', '$.decision.constraints.deferUntil')
  const decidedAt = requireInstant(decision, 'decidedAt', '$.decision.decidedAt')

  return {
    schemaVersion: POLICY_DECISION_SCHEMA_VERSION,
    allowed,
    reasonCode,
    constraints: {
      ...(maxReplyChars === undefined ? {} : { maxReplyChars }),
      ...(deferUntil === undefined ? {} : { deferUntil }),
    },
    decidedAt,
  }
}

export function validateMemoryRecord(value: unknown): MemoryRecord {
  const memory = asRecord(value, '$.memory')
  knownKeys(
    memory,
    [
      'schemaVersion',
      'id',
      'kind',
      'contentRef',
      'quoteRef',
      'source',
      'createdAt',
      'confidence',
      'sensitivity',
      'importance',
      'explicitlyRequested',
      'lastRecalledAt',
      'status',
      'replacedBy',
      'deletedAt',
      'purgeAfter',
    ],
    '$.memory',
  )
  requireLiteralInteger(
    memory,
    'schemaVersion',
    '$.memory.schemaVersion',
    MEMORY_SCHEMA_VERSION,
  )
  const id = requireIdentifier(memory, 'id', '$.memory.id')
  const kind = requireString(memory, 'kind', '$.memory.kind', 1, 64)
  if (!/^[a-z][a-z0-9_.-]*$/.test(kind)) {
    fail('$.memory.kind', 'expected a lowercase memory kind')
  }
  const contentRef = requireIdentifier(memory, 'contentRef', '$.memory.contentRef')
  const quoteRef = requireNullableIdentifier(memory, 'quoteRef', '$.memory.quoteRef')
  const source = requireEnum(memory, 'source', '$.memory.source', [
    'user_stated',
    'rinko_inferred',
    'external',
  ])
  const createdAt = requireInstant(memory, 'createdAt', '$.memory.createdAt')
  const confidence = requireNumber(memory, 'confidence', '$.memory.confidence', 0, 1)
  const sensitivity = requireEnum(memory, 'sensitivity', '$.memory.sensitivity', [
    'normal',
    'sensitive',
    'third_party',
  ])
  const importance = requireEnum(memory, 'importance', '$.memory.importance', [
    'normal',
    'important',
    'permanent',
  ])
  const explicitlyRequested = requireBoolean(
    memory,
    'explicitlyRequested',
    '$.memory.explicitlyRequested',
  )
  const lastRecalledAt = requireNullableInstant(
    memory,
    'lastRecalledAt',
    '$.memory.lastRecalledAt',
  )
  const status = requireEnum(memory, 'status', '$.memory.status', [
    'candidate',
    'active',
    'archived',
    'replaced',
    'deleted',
  ])
  const replacedBy = requireNullableIdentifier(
    memory,
    'replacedBy',
    '$.memory.replacedBy',
  )
  const deletedAt = requireNullableInstant(memory, 'deletedAt', '$.memory.deletedAt')
  const purgeAfter = requireNullableInstant(memory, 'purgeAfter', '$.memory.purgeAfter')

  if (status === 'deleted' && (deletedAt === null || purgeAfter === null)) {
    fail('$.memory.deletedAt', 'deleted memories require deletedAt and purgeAfter')
  }
  if (status !== 'deleted' && (deletedAt !== null || purgeAfter !== null)) {
    fail('$.memory.deletedAt', 'non-deleted memories must not carry trash timestamps')
  }
  if (status === 'replaced' && replacedBy === null) {
    fail('$.memory.replacedBy', 'replaced memories require a replacement ID')
  }
  if (deletedAt !== null && purgeAfter !== null && Date.parse(purgeAfter) <= Date.parse(deletedAt)) {
    fail('$.memory.purgeAfter', 'purgeAfter must be later than deletedAt')
  }

  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    id,
    kind,
    contentRef,
    quoteRef,
    source,
    createdAt,
    confidence,
    sensitivity,
    importance,
    explicitlyRequested,
    lastRecalledAt,
    status,
    replacedBy,
    deletedAt,
    purgeAfter,
  }
}

export function validateTombstone(value: unknown): Tombstone {
  const tombstone = asRecord(value, '$.tombstone')
  knownKeys(
    tombstone,
    ['schemaVersion', 'targetType', 'targetId', 'purgedAt'],
    '$.tombstone',
  )
  requireLiteralInteger(
    tombstone,
    'schemaVersion',
    '$.tombstone.schemaVersion',
    TOMBSTONE_SCHEMA_VERSION,
  )
  const targetType = requireEnum(tombstone, 'targetType', '$.tombstone.targetType', [
    'body',
    'memory',
    'outbox',
    'event',
  ])
  const targetId = requireIdentifier(tombstone, 'targetId', '$.tombstone.targetId')
  const purgedAt = requireInstant(tombstone, 'purgedAt', '$.tombstone.purgedAt')
  return {
    schemaVersion: TOMBSTONE_SCHEMA_VERSION,
    targetType,
    targetId,
    purgedAt,
  }
}

function validatePayload(type: string, value: unknown): StateEventPayload {
  const payload = asRecord(value, `$.payload(${type})`)
  switch (type) {
    case 'tick': {
      knownKeys(payload, ['elapsedMinutes', 'awake'], '$.payload')
      const elapsedMinutes = requireNumber(
        payload,
        'elapsedMinutes',
        '$.payload.elapsedMinutes',
        1,
        525_600,
      )
      const awake = requireBoolean(payload, 'awake', '$.payload.awake')
      return { elapsedMinutes, awake } satisfies TickPayload
    }
    case 'activity.changed': {
      knownKeys(payload, ['activity', 'busyUntil'], '$.payload')
      const activity = requireEnum(payload, 'activity', '$.payload.activity', ACTIVITIES)
      const busyUntil = requireNullableInstant(
        payload,
        'busyUntil',
        '$.payload.busyUntil',
      )
      if (activity === 'busy' && busyUntil === null) {
        fail('$.payload.busyUntil', 'busy activity requires busyUntil')
      }
      return { activity, busyUntil }
    }
    case 'appraisal.recorded': {
      knownKeys(payload, ['appraisal'], '$.payload')
      return { appraisal: validateAppraisal(payload.appraisal) }
    }
    case 'interaction.recorded': {
      knownKeys(payload, ['kind', 'intensity'], '$.payload')
      const kind = requireEnum(payload, 'kind', '$.payload.kind', [
        'conversation',
        'conflict',
        'apology',
        'shared_experience',
      ])
      const intensity = requireNumber(payload, 'intensity', '$.payload.intensity', 0, 1)
      return { kind, intensity }
    }
    case 'relationship.adjusted': {
      knownKeys(payload, ['closenessDelta', 'hurtDelta'], '$.payload')
      const closenessDelta = requireNumber(
        payload,
        'closenessDelta',
        '$.payload.closenessDelta',
        -0.25,
        0.25,
      )
      const hurtDelta = requireNumber(
        payload,
        'hurtDelta',
        '$.payload.hurtDelta',
        -0.25,
        0.25,
      )
      return { closenessDelta, hurtDelta } satisfies RelationshipAdjustedPayload
    }
    case 'commitment.created': {
      knownKeys(payload, ['commitmentId', 'descriptionRef', 'dueAt'], '$.payload')
      const commitmentId = requireIdentifier(
        payload,
        'commitmentId',
        '$.payload.commitmentId',
      )
      const descriptionRef = requireIdentifier(
        payload,
        'descriptionRef',
        '$.payload.descriptionRef',
      )
      const dueAt = requireNullableInstant(payload, 'dueAt', '$.payload.dueAt')
      return { commitmentId, descriptionRef, dueAt } satisfies CommitmentCreatedPayload
    }
    case 'commitment.resolved': {
      knownKeys(payload, ['commitmentId', 'status'], '$.payload')
      const commitmentId = requireIdentifier(
        payload,
        'commitmentId',
        '$.payload.commitmentId',
      )
      const status = requireEnum(payload, 'status', '$.payload.status', [
        'completed',
        'cancelled',
      ])
      return { commitmentId, status } satisfies CommitmentResolvedPayload
    }
    default:
      return fail('$.type', `unknown state event type "${type}"`)
  }
}

function validateCommitment(value: unknown, field: string): Commitment {
  const commitment = asRecord(value, field)
  knownKeys(commitment, ['id', 'descriptionRef', 'dueAt', 'status'], field)
  return {
    id: requireIdentifier(commitment, 'id', `${field}.id`),
    descriptionRef: requireIdentifier(
      commitment,
      'descriptionRef',
      `${field}.descriptionRef`,
    ),
    dueAt: requireNullableInstant(commitment, 'dueAt', `${field}.dueAt`),
    status: requireEnum(commitment, 'status', `${field}.status`, [
      'open',
      'completed',
      'cancelled',
    ]),
  }
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(field, 'expected an object')
  }
  return value as Record<string, unknown>
}

function knownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      fail(`${field}.${key}`, 'unknown field')
    }
  }
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  field: string,
  minLength: number,
  maxLength: number,
): string {
  const value = record[key]
  if (typeof value !== 'string') {
    fail(field, 'expected a string')
  }
  if (value.length < minLength || value.length > maxLength) {
    fail(field, `expected length ${minLength}..${maxLength}, got ${value.length}`)
  }
  return value
}

function requireIdentifier(
  record: Record<string, unknown>,
  key: string,
  field: string,
): string {
  const value = requireString(record, key, field, 1, 128)
  if (!IDENTIFIER.test(value)) {
    fail(field, 'expected a safe identifier')
  }
  return value
}

function optionalIdentifier(
  record: Record<string, unknown>,
  key: string,
  field: string,
): string | undefined {
  if (!(key in record)) return undefined
  return requireIdentifier(record, key, field)
}

function requireNullableIdentifier(
  record: Record<string, unknown>,
  key: string,
  field: string,
): string | null {
  const value = record[key]
  if (value === null) return null
  return requireIdentifier(record, key, field)
}

function requireIdentifierArray(
  record: Record<string, unknown>,
  key: string,
  field: string,
): string[] {
  const value = record[key]
  if (!Array.isArray(value)) {
    fail(field, 'expected an array of identifiers')
  }
  const result = value.map((item, index) => {
    if (typeof item !== 'string' || !IDENTIFIER.test(item)) {
      fail(`${field}[${index}]`, 'expected a safe identifier')
    }
    return item
  })
  if (new Set(result).size !== result.length) {
    fail(field, 'duplicate identifiers are not allowed')
  }
  return result
}

function requireNumber(
  record: Record<string, unknown>,
  key: string,
  field: string,
  min: number,
  max: number,
): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(field, 'expected a finite number')
  }
  if (value < min || value > max) {
    fail(field, `expected ${min}..${max}, got ${value}`)
  }
  return value
}

function requireInteger(
  record: Record<string, unknown>,
  key: string,
  field: string,
  min: number,
  max: number,
): number {
  const value = requireNumber(record, key, field, min, max)
  if (!Number.isInteger(value)) {
    fail(field, 'expected an integer')
  }
  return value
}

function requireLiteralInteger(
  record: Record<string, unknown>,
  key: string,
  field: string,
  expected: number,
): void {
  const value = requireInteger(record, key, field, expected, expected)
  if (value !== expected) {
    fail(field, `unsupported schema version ${value}; expected ${expected}`)
  }
}

function requireBoolean(
  record: Record<string, unknown>,
  key: string,
  field: string,
): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') {
    fail(field, 'expected a boolean')
  }
  return value
}

function requireInstant(
  record: Record<string, unknown>,
  key: string,
  field: string,
): string {
  const value = requireString(record, key, field, 20, 24)
  try {
    parseInstant(value, field)
  } catch (error) {
    fail(field, error instanceof Error ? error.message : String(error))
  }
  return value
}

function requireNullableInstant(
  record: Record<string, unknown>,
  key: string,
  field: string,
): string | null {
  if (record[key] === null) return null
  return requireInstant(record, key, field)
}

function requireEnum<const T extends string>(
  record: Record<string, unknown>,
  key: string,
  field: string,
  allowed: readonly T[],
): T {
  const value = requireString(record, key, field, 1, 64)
  if (!allowed.includes(value as T)) {
    fail(field, `expected one of ${allowed.join(', ')}, got "${value}"`)
  }
  return value as T
}

function fail(field: string, message: string): never {
  throw new StateValidationError(field, message)
}
