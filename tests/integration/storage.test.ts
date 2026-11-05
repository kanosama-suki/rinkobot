/**
 * 存储主链路集成测试。
 *
 * 覆盖快照触发、重启恢复、回收站和备份保留；每个用例使用独立临时目录，
 * 不接触 DSH 正式实例。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  memoryFor,
  createWorkspace,
  testEvent,
  tickEvent,
} from '../helpers/storage-fixture.ts'

test('events and the latest snapshot survive a clean reopen byte-for-byte', () => {
  const ws = createWorkspace(test, { snapshotEveryEvents: 2 })
  const store = ws.open()
  let snapshotJson: string
  let stateBefore: ReturnType<typeof store.currentState>
  let sequenceBefore: number

  try {
    const first = store.appendEvent(tickEvent('event-1'))
    assert.equal(first.snapshot, null)
    const second = store.appendEvent(
      testEvent('event-2', 'appraisal.recorded', {
        appraisal: {
          schemaVersion: 1,
          valence: 0.6,
          arousal: 0.8,
          confidence: 0.5,
          evidenceRefs: [],
        },
      }),
    )
    assert.equal(second.snapshot?.snapshot.lastSequence, 2)
    stateBefore = store.currentState()
    sequenceBefore = store.lastSequence
    snapshotJson = store.latestSnapshotJson() ?? ''
    assert.notEqual(snapshotJson, '')
  } finally {
    store.close()
  }

  const reopened = ws.open()
  try {
    assert.deepEqual(reopened.currentState(), stateBefore)
    assert.equal(reopened.lastSequence, sequenceBefore)
    assert.equal(reopened.latestSnapshotJson(), snapshotJson)
    assert.equal(reopened.eventCount(), 2)
  } finally {
    reopened.close()
  }
})

test('snapshot cadence uses event count and injected clock hour', () => {
  const ws = createWorkspace(test, {
    snapshotEveryEvents: 100,
    snapshotIntervalHours: 1,
  })
  let store = ws.open()
  try {
    assert.equal(
      store.appendEvent(
        tickEvent('hour-event-1', '2026-11-05T00:10:00.000Z'),
      ).snapshot,
      null,
    )
  } finally {
    store.close()
  }

  // 重启后小时窗口锚点来自事件日志，而不是本次进程启动时间。
  ws.clock.advanceByMs(3_600_000)
  store = ws.open()
  try {
    const hourly = store.appendEvent(
      tickEvent('hour-event-2', '2026-11-05T01:10:00.000Z'),
    )
    assert.equal(hourly.snapshot?.snapshot.lastSequence, 2)
    assert.equal(
      hourly.snapshot?.snapshot.generatedAt,
      '2026-11-05T01:10:00.000Z',
    )
  } finally {
    store.close()
  }

  const counted = createWorkspace(test, { snapshotEveryEvents: 2 })
  const countedStore = counted.open()
  try {
    assert.equal(
      countedStore.appendEvent(tickEvent('count-event-1')).snapshot,
      null,
    )
    assert.equal(
      countedStore.appendEvent(
        tickEvent('count-event-2', '2026-11-05T00:01:00.000Z'),
      ).snapshot?.snapshot.lastSequence,
      2,
    )
  } finally {
    countedStore.close()
  }
})

test('memory trash is hidden, restorable before expiry, then purgeable', () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    store.putBody({
      id: 'body-memory-1',
      kind: 'note',
      content: '占位测试正文，不包含真实个人资料',
    })
    store.putMemory(memoryFor('memory-1', 'body-memory-1'))
    assert.equal(store.listTombstones().length, 0)

    const deleted = store.trashMemory('memory-1', '2026-11-05T10:00:00.000Z')
    assert.equal(deleted.status, 'deleted')
    assert.equal(deleted.purgeAfter, '2026-12-05T10:00:00.000Z')
    assert.deepEqual(store.listMemories(), [])
    assert.equal(store.listMemories({ onlyDeleted: true }).length, 1)

    const restored = store.restoreMemory('memory-1', '2026-11-20T00:00:00.000Z')
    assert.equal(restored.status, 'active')
    assert.equal(restored.deletedAt, null)

    store.trashMemory('memory-1', '2026-12-01T00:00:00.000Z')
    assert.throws(
      () => store.restoreMemory('memory-1', '2027-01-15T00:00:00.000Z'),
      /retention has expired/,
    )
    assert.equal(store.purgeExpiredTrash('2027-01-15T00:00:00.000Z'), 1)
    assert.equal(store.getMemory('memory-1'), null)
    assert.equal(store.getBody('body-memory-1'), null)
  } finally {
    store.close()
  }
})

test('restoring a deleted candidate memory keeps its pre-trash status', () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    store.putBody({
      id: 'body-candidate-1',
      kind: 'note',
      content: '候选记忆的占位正文',
    })
    store.putMemory({
      ...memoryFor('memory-candidate-1', 'body-candidate-1'),
      status: 'candidate',
    })
    store.trashMemory('memory-candidate-1', '2026-11-05T10:00:00.000Z')
    const restored = store.restoreMemory(
      'memory-candidate-1',
      '2026-11-06T10:00:00.000Z',
    )
    assert.equal(restored.status, 'candidate')
  } finally {
    store.close()
  }
})

test('backup retention keeps only the configured newest files', () => {
  const ws = createWorkspace(test, { backupRetention: 7 })
  const store = ws.open()
  try {
    for (let day = 1; day <= 9; day += 1) {
      const date = `2026-11-${String(day).padStart(2, '0')}T00:00:00.000Z`
      store.createBackup(new Date(date))
    }
    const backups = store.listBackups()
    assert.equal(backups.length, 7)
    assert.equal(backups[0].createdAt.startsWith('2026-11-09'), true)
    assert.equal(backups.at(-1)?.createdAt.startsWith('2026-11-03'), true)
  } finally {
    store.close()
  }
})

test('event IDs are unique and event time cannot move backwards', () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    store.appendEvent(tickEvent('event-a', '2026-11-05T02:00:00.000Z'))
    assert.throws(
      () => store.appendEvent(tickEvent('event-a', '2026-11-05T03:00:00.000Z')),
      /already exists/,
    )
    assert.throws(
      () => store.appendEvent(tickEvent('event-b', '2026-11-05T01:00:00.000Z')),
      /is older than the latest event/,
    )
  } finally {
    store.close()
  }
})
