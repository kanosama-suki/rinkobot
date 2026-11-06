/**
 * M4 主动性存储、outbox 和提醒/关心依赖测试。
 *
 * 使用临时 SQLite，验证候选确认、原子投递、幂等、失败释放和关心项
 * 只被使用一次。测试不调用模型或网络。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createWorkspace } from '../helpers/storage-fixture.ts'

test('reminder candidates stay pending until confirmed and deliver exactly once', () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const source = appendUser(store, 'message-reminder-source', '提醒来源')
    const candidate = store.putReminderCandidate({
      id: 'reminder-candidate-test',
      text: '明天上午提醒 kano 带虚构证件。',
      dueAt: '2026-11-06T01:00:00.000Z',
      sourceMessageId: source.id,
      createdAt: '2026-11-05T23:00:00.000Z',
    })
    assert.equal(candidate.status, 'pending')
    assert.equal(store.listReminderCandidates('pending').length, 1)
    assert.equal(store.listReminders().length, 0)

    const confirmed = store.confirmReminderCandidate(
      candidate.id,
      '2026-11-05T23:01:00.000Z',
    )
    assert.equal(confirmed.candidate.status, 'confirmed')
    assert.equal(confirmed.reminder.status, 'confirmed')
    assert.equal(
      confirmed.candidate.confirmedReminderId,
      confirmed.reminder.id,
    )
    assert.throws(
      () => store.confirmReminderCandidate(candidate.id),
      /already confirmed/,
    )

    const outbox = store.queueReminderOutbox(
      confirmed.reminder.id,
      '2026-11-06T01:00:00.000Z',
      3,
    )
    assert.equal(outbox.kind, 'reminder')
    const queued = store.getReminder(confirmed.reminder.id)
    assert.equal(queued?.status, 'queued')

    const claimed = store.claimOutbox(outbox.id, '2026-11-06T01:00:01.000Z')
    assert.equal(claimed.attempts, 1)
    const first = store.deliverOutbox(
      claimed.id,
      '2026-11-06T01:00:02.000Z',
    )
    assert.equal(first.outbox.status, 'delivered')
    assert.equal(first.message.role, 'assistant')
    assert.equal(first.message.text, '明天上午提醒 kano 带虚构证件。')
    assert.equal(
      store.getReminder(confirmed.reminder.id)?.status,
      'delivered',
    )
    assert.equal(store.chatMessageCount(), 2)

    const repeated = store.deliverOutbox(
      claimed.id,
      '2026-11-06T01:00:03.000Z',
    )
    assert.equal(repeated.message.id, first.message.id)
    assert.equal(store.chatMessageCount(), 2)
  } finally {
    store.close()
  }
})

test('proactive outbox marks one care item delivered and releases it on failure', () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const source = appendUser(store, 'message-care-source', '关心来源')
    const care = store.putCareItem({
      id: 'care-item-test',
      text: 'kano 今天身体不舒服，需要在恢复后关心一次。',
      sourceMessageId: source.id,
      dueFrom: '2026-11-05T23:00:00.000Z',
      dueUntil: '2026-11-06T12:00:00.000Z',
      createdAt: '2026-11-05T22:00:00.000Z',
    })
    assert.deepEqual(
      store.listDueCareItems('2026-11-05T23:30:00.000Z').map(item => item.id),
      [care.id],
    )

    const outbox = store.enqueueOutbox({
      id: 'outbox-proactive-care',
      target: 'web:owner',
      kind: 'proactive',
      text: '今天感觉好些了吗？',
      dueAt: '2026-11-05T23:30:00.000Z',
      maxAttempts: 2,
      createdAt: '2026-11-05T23:30:00.000Z',
      careItemIds: [care.id],
    })
    assert.equal(store.getCareItem(care.id)?.status, 'queued')
    assert.equal(store.getCareItem(care.id)?.outboxId, outbox.id)

    const claimed = store.claimOutbox(outbox.id, '2026-11-05T23:30:01.000Z')
    const delivered = store.deliverOutbox(
      claimed.id,
      '2026-11-05T23:30:02.000Z',
    )
    assert.equal(delivered.outbox.status, 'delivered')
    const used = store.getCareItem(care.id)
    assert.equal(used?.status, 'delivered')
    assert.equal(used?.deliveredAt, '2026-11-05T23:30:02.000Z')
    assert.deepEqual(store.listDueCareItems('2026-11-05T23:31:00.000Z'), [])

    const secondCare = store.putCareItem({
      id: 'care-item-release',
      text: '虚拟事项需要失败后释放。',
      sourceMessageId: source.id,
      dueFrom: '2026-11-06T00:00:00.000Z',
      dueUntil: '2026-11-06T08:00:00.000Z',
      createdAt: '2026-11-06T00:00:00.000Z',
    })
    const failing = store.enqueueOutbox({
      id: 'outbox-proactive-failure',
      target: 'web:owner',
      kind: 'proactive',
      text: '这条占位主动消息会投递失败。',
      maxAttempts: 1,
      createdAt: '2026-11-06T00:00:00.000Z',
      careItemIds: [secondCare.id],
    })
    store.claimOutbox(failing.id, '2026-11-06T00:00:01.000Z')
    const failed = store.markOutboxFailure(
      failing.id,
      'delivery_failed',
      '2026-11-06T00:00:02.000Z',
      null,
    )
    assert.equal(failed.status, 'failed')
    assert.equal(store.getCareItem(secondCare.id)?.status, 'pending')
    assert.equal(store.getCareItem(secondCare.id)?.outboxId, null)

    store.expireCareItems('2026-11-06T09:00:00.000Z')
    assert.equal(store.getCareItem(secondCare.id)?.status, 'expired')
  } finally {
    store.close()
  }
})

test('failed reminder delivery releases queued reminder to failed', () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const source = appendUser(store, 'message-reminder-failure', '提醒失败来源')
    const candidate = store.putReminderCandidate({
      text: '虚构失败提醒',
      dueAt: '2026-11-06T02:00:00.000Z',
      sourceMessageId: source.id,
      createdAt: '2026-11-06T01:00:00.000Z',
    })
    const confirmed = store.confirmReminderCandidate(
      candidate.id,
      '2026-11-06T01:01:00.000Z',
    )
    const outbox = store.queueReminderOutbox(
      confirmed.reminder.id,
      '2026-11-06T02:00:00.000Z',
      1,
    )
    store.claimOutbox(outbox.id, '2026-11-06T02:00:01.000Z')
    store.markOutboxFailure(
      outbox.id,
      'delivery_failed',
      '2026-11-06T02:00:02.000Z',
      null,
    )
    assert.equal(store.getReminder(confirmed.reminder.id)?.status, 'failed')
  } finally {
    store.close()
  }
})

function appendUser(
  store: ReturnType<ReturnType<typeof createWorkspace>['open']>,
  id: string,
  text: string,
) {
  return store.appendChatMessage({
    id,
    conversationId: 'main',
    role: 'user',
    text,
    createdAt: '2026-11-05T22:00:00.000Z',
  })
}
