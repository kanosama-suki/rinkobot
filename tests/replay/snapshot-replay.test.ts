/**
 * 事件回放确定性验收。
 *
 * 同一组 130 个事件写入两个独立数据库；自动快照和最终强制快照的 JSON
 * 必须逐字节相同，重启后也必须复用同一份快照。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { canonicalJson } from '../../src/core/state/index.ts'
import type { StateEvent } from '../../src/core/state/index.ts'
import {
  createWorkspace,
  testEvent,
} from '../helpers/storage-fixture.ts'

test('identical event streams produce byte-identical snapshots', () => {
  const events = buildEvents(130)
  // 拉长小时窗口，单独验证按事件数触发的自动快照；小时节奏由 storage.test.ts 覆盖。
  const options = { snapshotEveryEvents: 100, snapshotIntervalHours: 24 }
  const first = createWorkspace(test, options)
  const second = createWorkspace(test, options)
  const firstStore = first.open()
  const secondStore = second.open()
  let firstJson: string
  let firstState: string

  try {
    let automaticSnapshotSequence: number | null = null
    for (const [index, event] of events.entries()) {
      const appended = firstStore.appendEvent(event)
      secondStore.appendEvent(event)
      if (appended.snapshot !== null) {
        automaticSnapshotSequence = appended.snapshot.snapshot.lastSequence
        assert.equal(automaticSnapshotSequence, 100)
        assert.equal(index, 99)
      }
    }
    assert.equal(automaticSnapshotSequence, 100)

    const firstSnapshot = firstStore.createSnapshot()
    const secondSnapshot = secondStore.createSnapshot()
    assert.equal(firstSnapshot.snapshot.lastSequence, 130)
    assert.equal(firstSnapshot.snapshot.stateHash, secondSnapshot.snapshot.stateHash)
    assert.equal(
      Buffer.from(firstSnapshot.json, 'utf8').equals(
        Buffer.from(secondSnapshot.json, 'utf8'),
      ),
      true,
    )
    assert.equal(canonicalJson(firstStore.currentState()), canonicalJson(secondStore.currentState()))
    firstJson = firstSnapshot.json
    firstState = canonicalJson(firstStore.currentState())
  } finally {
    firstStore.close()
    secondStore.close()
  }

  const firstReopened = first.open()
  const secondReopened = second.open()
  try {
    assert.equal(firstReopened.latestSnapshotJson(), firstJson)
    assert.equal(secondReopened.latestSnapshotJson(), firstJson)
    assert.equal(canonicalJson(firstReopened.currentState()), firstState)
    assert.equal(canonicalJson(secondReopened.currentState()), firstState)
  } finally {
    firstReopened.close()
    secondReopened.close()
  }
})

function buildEvents(count: number): StateEvent[] {
  const base = Date.parse('2026-11-05T00:00:00.000Z')
  const events: StateEvent[] = []
  for (let index = 0; index < count; index += 1) {
    const at = new Date(base + index * 60_000).toISOString()
    const id = `event-${String(index).padStart(3, '0')}`
    const slot = index % 10
    if (slot === 0) {
      events.push(
        testEvent(
          id,
          'commitment.created',
          {
            commitmentId: `commitment-${index}`,
            descriptionRef: `body-commitment-${index}`,
            dueAt: null,
          },
          at,
        ),
      )
    } else if (slot === 5) {
      events.push(
        testEvent(
          id,
          'commitment.resolved',
          {
            commitmentId: `commitment-${index - 5}`,
            status: 'completed',
          },
          at,
        ),
      )
    } else if (slot === 1) {
      events.push(
        testEvent(
          id,
          'appraisal.recorded',
          {
            appraisal: {
              schemaVersion: 1,
              valence: index % 2 === 0 ? 0.45 : -0.2,
              arousal: (index % 10) / 10,
              confidence: 0.75,
              evidenceRefs: [],
            },
          },
          at,
        ),
      )
    } else if (slot === 2) {
      events.push(
        testEvent(
          id,
          'interaction.recorded',
          { kind: 'conversation', intensity: 0.8 },
          at,
        ),
      )
    } else if (slot === 3) {
      events.push(
        testEvent(
          id,
          'relationship.adjusted',
          { closenessDelta: 0.001, hurtDelta: 0 },
          at,
          'owner',
        ),
      )
    } else if (slot === 4) {
      events.push(
        testEvent(
          id,
          'tick',
          { elapsedMinutes: 7, awake: true },
          at,
        ),
      )
    } else if (slot === 6) {
      events.push(
        testEvent(
          id,
          'activity.changed',
          { activity: 'reading', busyUntil: null },
          at,
          'rinko',
        ),
      )
    } else {
      events.push(
        testEvent(
          id,
          'interaction.recorded',
          { kind: 'shared_experience', intensity: 0.5 },
          at,
        ),
      )
    }
  }
  return events
}
