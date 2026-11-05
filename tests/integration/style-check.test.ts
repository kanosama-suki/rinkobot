/**
 * 聊天完成后的风格检查与持久化测试。
 *
 * 只保存违规代码，不把回复正文复制进检查表；正文仍只在 bodies。
 */

import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  KanobotChatService,
  type ChatModel,
  type ChatModelRequest,
  type ChatModelStreamEvent,
  type ChatStreamEvent,
} from '../../src/core/chat/index.ts'
import { createWorkspace } from '../helpers/storage-fixture.ts'
import { chatEnvelopeText } from '../helpers/chat-envelope.ts'

test('a banned phrase is recorded as a style violation without copying text', async t => {
  const ws = createWorkspace(t)
  const store = ws.open()
  try {
    const chat = new KanobotChatService(store, new BannedReplyModel())
    const events: ChatStreamEvent[] = []
    for await (const event of chat.streamMessage(
      '这条消息只用于测试风格检查。',
      new AbortController().signal,
    )) {
      events.push(event)
    }
    const done = events.find(event => event.type === 'done')
    assert.ok(done?.type === 'done')
    assert.equal(done.styleCheck.ok, false)
    assert.deepEqual(
      done.styleCheck.violations.map(violation => violation.code),
      ['banned_phrase'],
    )

    const persisted = store.getReplyStyleCheck(done.message.id)
    assert.ok(persisted)
    assert.equal(persisted.ok, false)
    assert.deepEqual(persisted.violationCodes, ['banned_phrase'])

    const db = new DatabaseSync(store.databasePath, { readOnly: true })
    try {
      const row = db.prepare('SELECT * FROM reply_style_checks').get() as
        | Record<string, unknown>
        | undefined
      assert.ok(row)
      assert.equal(JSON.stringify(row).includes('作为AI'), false)
    } finally {
      db.close()
    }
  } finally {
    store.close()
  }
})

class BannedReplyModel implements ChatModel {
  readonly id = 'style-test-model'
  readonly mode = 'mock'
  readonly provider = 'test'

  async *stream(
    _request: ChatModelRequest,
  ): AsyncIterable<ChatModelStreamEvent> {
    yield {
      type: 'text',
      text: chatEnvelopeText('作为AI，你应该早点休息。'),
    }
    yield {
      type: 'result',
      result: {
        attempts: 1,
        usage: null,
        estimatedCost: null,
        pricing: null,
        responseId: null,
      },
    }
  }
}
