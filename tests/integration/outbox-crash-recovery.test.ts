/**
 * 强杀后的 outbox 恢复边界。
 *
 * 陈旧的 `sending` 记录代表“无法证明是否已发出”。本地网页目标可以
 * 安全重试；外部渠道必须进入 unknown 终态，重启后不能被 scheduler
 * 再次认领，否则会产生重复消息。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createWorkspace } from '../helpers/storage-fixture.ts'

test('a stale external send is not retried after a crash', () => {
  const ws = createWorkspace(test, {
    now: '2026-11-11T02:00:00.000Z',
  })
  let store = ws.open()
  try {
    const source = store.appendChatMessage({
      conversationId: 'main',
      role: 'user',
      text: 'outbox 强杀恢复的虚构来源消息。',
      createdAt: '2026-11-11T01:55:00.000Z',
    })
    assert.ok(source.id.length > 0)
    const external = store.enqueueOutbox({
      id: 'outbox-external-crash',
      target: 'private:10001',
      kind: 'system',
      text: '这条外部消息在强杀前已经进入 sending。',
      maxAttempts: 5,
      createdAt: '2026-11-11T02:00:00.000Z',
    })
    const local = store.enqueueOutbox({
      id: 'outbox-local-crash',
      target: 'web:owner',
      kind: 'system',
      text: '这条网页消息可以安全重试。',
      maxAttempts: 5,
      createdAt: '2026-11-11T02:00:01.000Z',
    })
    store.claimOutbox(external.id, '2026-11-11T02:00:02.000Z')
    store.claimOutbox(local.id, '2026-11-11T02:00:03.000Z')
  } finally {
    store.close()
  }

  ws.clock.advanceByMs(30 * 60_000)
  store = ws.open()
  try {
    const recovered = store.recoverStaleOutbox(
      '2026-11-11T02:10:00.000Z',
      '2026-11-11T02:30:00.000Z',
    )
    assert.equal(recovered, 2)
    assert.equal(store.getOutbox('outbox-external-crash')?.status, 'unknown')
    assert.equal(store.getOutbox('outbox-external-crash')?.dueAt, null)
    assert.equal(store.getOutbox('outbox-local-crash')?.status, 'failed')
    assert.notEqual(store.getOutbox('outbox-local-crash')?.dueAt, null)

    const claimable = store.listDueOutbox('2026-11-11T02:30:00.000Z', 10)
    assert.deepEqual(
      claimable.map(item => item.id),
      ['outbox-local-crash'],
    )
    assert.throws(
      () => store.claimOutbox('outbox-external-crash', '2026-11-11T02:30:01.000Z'),
      /not claimable/,
    )
  } finally {
    store.close()
  }
})
