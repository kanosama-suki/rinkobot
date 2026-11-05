/**
 * 纯 reducer 和数据契约的单元测试。
 *
 * 边界：只用固定事件和固定配置，不启动宿主、不写数据库；重点验证确定性、
 * 数值边界、非法事件拒绝和关系修复语义。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadConfigFromDirectory } from '../../src/core/config/index.ts'
import {
  canonicalJson,
  createInitialState,
  reduceState,
  StateValidationError,
  validateMemoryRecord,
  validatePolicyDecision,
  validateTombstone,
} from '../../src/core/state/index.ts'
import type {
  LifeState,
  StateEvent,
} from '../../src/core/state/index.ts'

const examplesDir = fileURLToPath(new URL('../../config/examples', import.meta.url))
const loaded = loadConfigFromDirectory(examplesDir)
const config = loaded.lifeState

let eventCounter = 0

function event<Type extends StateEvent['type']>(
  type: Type,
  payload: Extract<StateEvent, { type: Type }>['payload'],
  overrides: Partial<Extract<StateEvent, { type: Type }>> = {},
): Extract<StateEvent, { type: Type }> {
  eventCounter += 1
  return {
    eventId: `event-${eventCounter}`,
    schemaVersion: 1,
    occurredAt: '2026-11-05T00:00:00.000Z',
    source: sourceFor(type),
    type,
    payload,
    evidenceRefs: [],
    confidence: 1,
    ...overrides,
  } as Extract<StateEvent, { type: Type }>
}

function sourceFor(type: StateEvent['type']): StateEvent['source'] {
  switch (type) {
    case 'tick':
      return 'tick'
    case 'appraisal.recorded':
    case 'activity.changed':
      return 'rinko'
    case 'relationship.adjusted':
      return 'owner'
    default:
      return 'user'
  }
}

test('the same fixed event stream always yields the same canonical state', () => {
  const events: StateEvent[] = [
    event('tick', { elapsedMinutes: 120, awake: true }),
    event('appraisal.recorded', {
      appraisal: {
        schemaVersion: 1,
        valence: -0.4,
        arousal: 0.65,
        confidence: 0.8,
        evidenceRefs: ['body-1'],
      },
    }),
    event('interaction.recorded', {
      kind: 'shared_experience',
      intensity: 0.7,
    }),
    event('commitment.created', {
      commitmentId: 'commitment-1',
      descriptionRef: 'body-2',
      dueAt: '2026-11-06T00:00:00.000Z',
    }),
  ]

  const first = replay(events)
  const second = replay(events)
  assert.equal(canonicalJson(first), canonicalJson(second))
  assert.equal(first.commitments[0].descriptionRef, 'body-2')
})

test('reducer does not mutate the input state', () => {
  const initial = createInitialState(config)
  const before = structuredClone(initial)
  const next = reduceState(
    initial,
    event('interaction.recorded', {
      kind: 'conversation',
      intensity: 1,
    }),
    config,
  )
  assert.deepEqual(initial, before)
  assert.notDeepEqual(next, initial)
})

test('tick decays affect, drains or restores reserves, and expires attention', () => {
  const initial = createInitialState(config)
  initial.affect.valence = 0.8
  initial.energy = 0.5
  initial.socialBattery = 0.5
  initial.attention.busyUntil = '2026-11-05T01:00:00.000Z'

  const awake = reduceState(
    initial,
    event('tick', { elapsedMinutes: 60, awake: true }),
    config,
  )
  assert.equal(awake.energy, 0.48)
  assert.equal(awake.socialBattery, 0.47)
  assert.equal(awake.affect.valence, 0.72)
  assert.equal(awake.attention.busyUntil, null)

  const asleep = reduceState(
    initial,
    event('tick', { elapsedMinutes: 60, awake: false }),
    config,
  )
  assert.equal(asleep.energy, 0.58)
  assert.equal(asleep.socialBattery, 0.55)
})

test('appraisal weight follows confidence instead of replacing state outright', () => {
  const initial = createInitialState(config)
  initial.affect.valence = 0.5
  const next = reduceState(
    initial,
    event('appraisal.recorded', {
      appraisal: {
        schemaVersion: 1,
        valence: -0.5,
        arousal: 0.8,
        confidence: 0.25,
        evidenceRefs: [],
      },
    }),
    config,
  )
  assert.equal(next.affect.valence, 0.25)
})

test('a single event cannot move closeness beyond the configured cap', () => {
  const initial = createInitialState(config)
  const cap = config.limits.maxRelationshipDeltaPerEvent
  const adjusted = reduceState(
    initial,
    event('relationship.adjusted', {
      closenessDelta: cap,
      hurtDelta: 0,
    }),
    config,
  )
  assert.equal(
    adjusted.relationship.closeness,
    Math.round((initial.relationship.closeness + cap) * 1e6) / 1e6,
  )

  assert.throws(
    () =>
      reduceState(
        initial,
        event('relationship.adjusted', {
          closenessDelta: cap + 0.001,
          hurtDelta: 0,
        }),
        config,
      ),
    /relationship delta exceeds configured cap/,
  )
})

test('an apology reduces hurt but cannot clear it in one event', () => {
  const initial = createInitialState(config)
  const conflicted = reduceState(
    initial,
    event('interaction.recorded', { kind: 'conflict', intensity: 1 }),
    config,
  )
  assert.equal(conflicted.relationship.hurt, 0.12)
  assert.equal(conflicted.relationship.repairNeeded, true)

  const firstApology = reduceState(
    conflicted,
    event('interaction.recorded', { kind: 'apology', intensity: 1 }),
    config,
  )
  assert.equal(firstApology.relationship.hurt, 0.06)
  assert.equal(firstApology.relationship.repairNeeded, true)

  const repaired = reduceState(
    firstApology,
    event('interaction.recorded', { kind: 'apology', intensity: 1 }),
    config,
  )
  assert.equal(repaired.relationship.hurt, 0.03)
  assert.equal(repaired.relationship.repairNeeded, false)
})

test('commitments enforce uniqueness and the configured maximum', () => {
  const initial = createInitialState(config)
  const first = reduceState(
    initial,
    event('commitment.created', {
      commitmentId: 'commitment-1',
      descriptionRef: 'body-1',
      dueAt: null,
    }),
    config,
  )
  assert.equal(first.commitments.length, 1)

  assert.throws(
    () =>
      reduceState(
        first,
        event('commitment.created', {
          commitmentId: 'commitment-1',
          descriptionRef: 'body-2',
          dueAt: null,
        }),
        config,
      ),
    /already exists/,
  )

  const resolved = reduceState(
    first,
    event('commitment.resolved', {
      commitmentId: 'commitment-1',
      status: 'completed',
    }),
    config,
  )
  assert.equal(resolved.commitments[0].status, 'completed')
})

test('unknown fields, wrong sources and invalid numbers are rejected', () => {
  const initial = createInitialState(config)
  const valid = event('tick', { elapsedMinutes: 1, awake: true })

  assert.throws(
    () =>
      reduceState(
        initial,
        { ...valid, extra: true } as StateEvent,
        config,
      ),
    StateValidationError,
  )
  assert.throws(
    () =>
      reduceState(
        initial,
        { ...valid, source: 'owner' } as StateEvent,
        config,
      ),
    /not allowed/,
  )
  assert.throws(
    () =>
      reduceState(
        initial,
        event('tick', { elapsedMinutes: 0, awake: true }),
        config,
      ),
    /expected 1\.\.525600/,
  )
})

test('memory, policy decision and tombstone contracts reject content-bearing extras', () => {
  const memory = {
    schemaVersion: 1,
    id: 'memory-1',
    kind: 'preference',
    contentRef: 'body-1',
    quoteRef: null,
    source: 'user_stated',
    createdAt: '2026-11-05T00:00:00.000Z',
    confidence: 1,
    sensitivity: 'normal',
    importance: 'important',
    lastRecalledAt: null,
    status: 'active',
    replacedBy: null,
    deletedAt: null,
    purgeAfter: null,
  } as const
  assert.equal(validateMemoryRecord(memory).id, 'memory-1')
  assert.throws(
    () => validateMemoryRecord({ ...memory, originalText: 'should stay in bodies' }),
    StateValidationError,
  )

  const decision = {
    schemaVersion: 1,
    allowed: true,
    reasonCode: 'quiet_hours_end',
    constraints: { maxReplyChars: 400 },
    decidedAt: '2026-11-05T07:00:00.000Z',
  } as const
  assert.equal(validatePolicyDecision(decision).allowed, true)

  const tombstone = {
    schemaVersion: 1,
    targetType: 'body',
    targetId: 'body-1',
    purgedAt: '2026-11-05T00:00:00.000Z',
  } as const
  assert.equal(validateTombstone(tombstone).targetId, 'body-1')
})

function replay(events: readonly StateEvent[]): LifeState {
  let state = createInitialState(config)
  for (const item of events) {
    state = reduceState(state, item, config)
  }
  return state
}
