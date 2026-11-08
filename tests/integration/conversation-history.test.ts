/**
 * 所有者 QQ 历史回填测试。
 *
 * 只验证 conversation_id 归属迁移：消息正文、seq、消息 ID 和模型调用
 * 审计不被复制或重排。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { mergeOwnerConversationHistory } from '../../src/core/chat/index.ts'
import { createWorkspace } from '../helpers/storage-fixture.ts'

test('owner QQ history moves into main without copying or reordering messages', () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const earlier = store.appendChatMessage({
      conversationId: 'main',
      role: 'user',
      text: '主会话里的早期虚构消息。',
      id: 'main-earlier',
      createdAt: '2026-11-08T01:00:00.000Z',
    })
    const ownerPrivate = store.appendChatMessage({
      conversationId: 'qq-private-10001',
      role: 'user',
      text: '所有者私聊里的虚构消息。',
      id: 'owner-private-later',
      createdAt: '2026-11-08T02:00:00.000Z',
    })
    const call = store.beginModelCall({
      conversationId: 'qq-private-10001',
      userMessageId: ownerPrivate.id,
      provider: 'test',
      model: 'test-model',
      startedAt: '2026-11-08T02:00:01.000Z',
    })

    const merged = mergeOwnerConversationHistory(store, '10001')
    assert.deepEqual(merged, {
      movedMessages: 1,
      movedModelCalls: 1,
      removedConversation: true,
    })
    const messages = store.listChatMessages('main', 10)
    assert.deepEqual(
      messages.map(message => message.id),
      [earlier.id, ownerPrivate.id],
    )
    assert.deepEqual(
      messages.map(message => message.text),
      ['主会话里的早期虚构消息。', '所有者私聊里的虚构消息。'],
    )
    assert.equal(store.getConversation('qq-private-10001'), null)
    assert.equal(store.getModelCall(call.id)?.conversationId, 'main')

    // 再次启动可以安全重复调用；源会话已不存在时不产生伪造的移动计数。
    assert.deepEqual(mergeOwnerConversationHistory(store, '10001'), {
      movedMessages: 0,
      movedModelCalls: 0,
      removedConversation: false,
    })
    assert.equal(store.chatMessageCount('main'), 2)
  } finally {
    store.close()
  }
})
