/**
 * M4 主动闸门、节奏抖动和本地时间纯函数测试。
 *
 * 不打开数据库或网络，只验证确定性规则：安静时段、冷却、忙碌、
 * 未到评估时间、连续未回复放慢和 outbox 状态转换。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import type { InitiativeConfig } from '../../src/core/config/index.ts'
import {
  canTransitionOutbox,
  evaluateProactiveGate,
  nextProactiveIntervalMs,
  isQuietAt,
  localDateKey,
  localDayRange,
  localDateTimeToDate,
  quietEndsAtOrAfter,
} from '../../src/core/initiative/index.ts'
import type { LifeState } from '../../src/core/state/index.ts'
import { createWorkspace } from '../helpers/storage-fixture.ts'

const TIMEZONE = 'Asia/Shanghai'

test('proactive gate denies disabled, quiet, recent chat, busy and not due states', () => {
  const ws = createWorkspace(test)
  const config = ws.loaded.initiative.proactive
  const state = idleState()

  assert.equal(
    denyReason({ config: { ...config, enabled: false }, state }).reason,
    'disabled',
  )

  const quiet = denyReason({
    config,
    state,
    now: new Date('2026-11-05T18:30:00.000Z'),
  })
  assert.equal(quiet.reason, 'quiet_hours')
  assert.equal(quiet.retryAt, '2026-11-05T23:00:00.000Z')

  const recent = evaluateProactiveGate({
    config,
    now: new Date('2026-11-06T01:00:00.000Z'),
    timezone: TIMEZONE,
    quietStart: '00:10',
    quietEnd: '07:00',
    nextProactiveAt: null,
    lastChatMessageAt: '2026-11-06T00:55:00.000Z',
    state,
    circuitOpenedAt: null,
  })
  assert.equal(recent.allowed, false)
  assert.equal(recent.reason, 'recent_chat')
  assert.equal(recent.retryAt, '2026-11-06T01:10:00.000Z')

  const busy = evaluateProactiveGate({
    config,
    now: new Date('2026-11-06T01:00:00.000Z'),
    timezone: TIMEZONE,
    quietStart: '00:10',
    quietEnd: '07:00',
    nextProactiveAt: null,
    lastChatMessageAt: null,
    state: {
      ...state,
      attention: { busyUntil: '2026-11-06T02:00:00.000Z' },
    },
    circuitOpenedAt: null,
  })
  assert.equal(busy.reason, 'busy')
  assert.equal(busy.retryAt, '2026-11-06T02:00:00.000Z')

  const notDue = evaluateProactiveGate({
    config,
    now: new Date('2026-11-06T01:00:00.000Z'),
    timezone: TIMEZONE,
    quietStart: '00:10',
    quietEnd: '07:00',
    nextProactiveAt: '2026-11-06T01:30:00.000Z',
    lastChatMessageAt: null,
    state,
    circuitOpenedAt: null,
  })
  assert.equal(notDue.reason, 'not_due')
  assert.equal(notDue.retryAt, '2026-11-06T01:30:00.000Z')

  const circuit = evaluateProactiveGate({
    config,
    now: new Date('2026-11-06T01:00:00.000Z'),
    timezone: TIMEZONE,
    quietStart: '00:10',
    quietEnd: '07:00',
    nextProactiveAt: null,
    lastChatMessageAt: null,
    state,
    circuitOpenedAt: '2026-11-06T00:55:00.000Z',
  })
  assert.equal(circuit.reason, 'circuit_open')

  const allowed = evaluateProactiveGate({
    config,
    now: new Date('2026-11-06T01:00:00.000Z'),
    timezone: TIMEZONE,
    quietStart: '00:10',
    quietEnd: '07:00',
    nextProactiveAt: null,
    lastChatMessageAt: null,
    state,
    circuitOpenedAt: null,
  })
  assert.deepEqual(allowed, { allowed: true, reason: null, retryAt: null })
})

test('proactive interval respects configured bounds, unanswered slowdown and 24h cap', () => {
  const ws = createWorkspace(test)
  const config = ws.loaded.initiative.proactive

  assert.equal(
    nextProactiveIntervalMs(config, () => 0, 0),
    config.minIntervalMinutes * 60_000,
  )
  const nearMaximum = nextProactiveIntervalMs(config, () => 0.999999, 0)
  assert.ok(nearMaximum <= config.maxIntervalMinutes * 60_000)
  assert.ok(nearMaximum > config.minIntervalMinutes * 60_000)
  assert.ok(
    nextProactiveIntervalMs(config, () => 0, 2) >
      nextProactiveIntervalMs(config, () => 0, 0),
  )
  assert.equal(
    nextProactiveIntervalMs(config, () => 0.999999, 100),
    24 * 60 * 60_000,
  )
  assert.throws(
    () => nextProactiveIntervalMs(config, () => 1, 0),
    /random must return a value in \[0, 1\)/,
  )
})

test('outbox transition table rejects terminal reopen and impossible jumps', () => {
  assert.equal(canTransitionOutbox('pending', 'sending'), true)
  assert.equal(canTransitionOutbox('sending', 'delivered'), true)
  assert.equal(canTransitionOutbox('failed', 'pending'), true)
  assert.equal(canTransitionOutbox('delivered', 'pending'), false)
  assert.equal(canTransitionOutbox('cancelled', 'sending'), false)
  assert.equal(canTransitionOutbox('expired', 'delivered'), false)
  assert.equal(canTransitionOutbox('sending', 'pending'), false)
})

test('local time helpers cross midnight and convert local day boundaries', () => {
  const beforeQuietEnd = new Date('2026-11-05T22:59:00.000Z')
  const atQuietEnd = new Date('2026-11-05T23:00:00.000Z')
  assert.equal(
    isQuietAt(beforeQuietEnd, TIMEZONE, '00:10', '07:00'),
    true,
  )
  assert.equal(isQuietAt(atQuietEnd, TIMEZONE, '00:10', '07:00'), false)
  assert.equal(
    quietEndsAtOrAfter(
      new Date('2026-11-05T18:30:00.000Z'),
      TIMEZONE,
      '00:10',
      '07:00',
    ).toISOString(),
    '2026-11-05T23:00:00.000Z',
  )
  assert.equal(
    localDateKey(new Date('2026-11-05T16:30:00.000Z'), TIMEZONE),
    '2026-11-06',
  )
  const range = localDayRange('2026-11-06', TIMEZONE)
  assert.equal(range.start.toISOString(), '2026-11-05T16:00:00.000Z')
  assert.equal(range.end.toISOString(), '2026-11-06T16:00:00.000Z')
  assert.equal(
    localDateTimeToDate('2026-11-06', 7, 0, TIMEZONE).toISOString(),
    '2026-11-05T23:00:00.000Z',
  )
})

function denyReason(input: {
  config: InitiativeConfig['proactive']
  state: LifeState
  now?: Date
}) {
  return evaluateProactiveGate({
    config: input.config,
    now: input.now ?? new Date('2026-11-06T01:00:00.000Z'),
    timezone: TIMEZONE,
    quietStart: '00:10',
    quietEnd: '07:00',
    nextProactiveAt: null,
    lastChatMessageAt: null,
    state: input.state,
    circuitOpenedAt: null,
  })
}

function idleState(): LifeState {
  return {
    activity: 'idle',
    affect: {
      valence: 0,
      arousal: 0,
    },
    energy: 0.8,
    socialBattery: 0.8,
    attention: {
      busyUntil: null,
    },
    relationship: {
      closeness: 0.5,
      hurt: 0,
      repairNeeded: false,
    },
    commitments: [],
  }
}
