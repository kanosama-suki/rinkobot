/**
 * 备份、每日留存和墓碑恢复验收。
 *
 * 旧主库备份允许暂时保留旧正文，但恢复后必须由独立墓碑库立即清理；
 * 本用例验证数据和快照都回到“已删除”语义，而不是只删正文表。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  restoreBackupToDatabase,
} from '../../src/core/storage/index.ts'
import {
  createWorkspace,
  memoryFor,
  outboxFor,
  testEvent,
} from '../helpers/storage-fixture.ts'

test('restoring an old backup does not resurrect purged content', () => {
  const ws = createWorkspace(test)
  const secret = '旧备份中不应复活的正文-KB-RESTORE-91ad'
  let backupPath: string
  let store = ws.open()

  try {
    store.putBody({
      id: 'body-backup-1',
      kind: 'chat',
      content: secret,
    })
    store.putMemory(memoryFor('memory-backup-1', 'body-backup-1'))
    store.putOutbox(outboxFor('outbox-backup-1', 'body-backup-1'))
    store.appendEvent(
      testEvent(
        'event-backup-1',
        'commitment.created',
        {
          commitmentId: 'commitment-backup-1',
          descriptionRef: 'body-backup-1',
          dueAt: null,
        },
      ),
    )
    store.createSnapshot()
    backupPath = store.createBackup(
      new Date('2026-11-05T00:00:00.000Z'),
    ).path
    store.purge({ targetType: 'body', targetId: 'body-backup-1' })
  } finally {
    store.close()
  }

  restoreBackupToDatabase(backupPath, store.databasePath)
  store = ws.open()
  try {
    assert.equal(store.getBody('body-backup-1'), null)
    assert.equal(store.getMemory('memory-backup-1'), null)
    assert.equal(store.getOutbox('outbox-backup-1'), null)
    assert.deepEqual(store.currentState().commitments, [])
    assert.equal(store.latestSnapshot()?.snapshot.lastSequence, 1)
    assert.equal(store.latestSnapshot()?.snapshot.state.commitments.length, 0)
  } finally {
    store.close()
  }

  assert.equal(
    readFileSync(store.databasePath).includes(Buffer.from(secret, 'utf8')),
    false,
  )
})

test('daily backup is created once per local calendar day', () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const first = store.maybeCreateDailyBackup(
      new Date('2026-11-05T01:00:00.000Z'),
    )
    assert.ok(first !== null)
    const duplicate = store.maybeCreateDailyBackup(
      new Date('2026-11-05T10:00:00.000Z'),
    )
    assert.equal(duplicate, null)
    const nextDay = store.maybeCreateDailyBackup(
      new Date('2026-11-06T01:00:00.000Z'),
    )
    assert.ok(nextDay !== null)
    assert.equal(store.listBackups().length, 2)
  } finally {
    store.close()
  }
})
