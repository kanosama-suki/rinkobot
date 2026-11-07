/**
 * schema v6 → 当前版本迁移测试。
 *
 * 测试先把数据库降级成只含 chat/memory_extraction purpose 的 v6 表，
 * 再通过正常启动迁移到当前版本，确认历史审计行没有丢失且 vision 调用可写入。
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  StorageError,
  type ModelCallRecord,
} from '../../src/core/storage/index.ts'
import {
  createWorkspace,
  dropCurrentChannelTables,
  dropCurrentInitiativeTables,
  downgradeMemoriesToV9,
} from '../helpers/storage-fixture.ts'

test('a v6 model_calls table migrates to v7 without losing history', () => {
  const ws = createWorkspace(test)
  let store = ws.open()
  let userMessageId: string
  let assistantMessageId: string
  let historicalCall: ModelCallRecord
  try {
    const user = store.appendChatMessage({
      conversationId: 'main',
      role: 'user',
      text: 'v6 中保留的虚构消息',
    })
    const assistant = store.appendChatMessage({
      conversationId: 'main',
      role: 'assistant',
      text: 'v6 中保留的虚构回复',
    })
    userMessageId = user.id
    assistantMessageId = assistant.id
    const started = store.beginModelCall({
      conversationId: 'main',
      userMessageId: user.id,
      purpose: 'chat',
      provider: 'test',
      model: 'old-chat-model',
    })
    historicalCall = store.finishModelCall(started.id, {
      status: 'succeeded',
      assistantMessageId: assistant.id,
      attempts: 1,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 15,
      },
      responseId: 'old-response',
    })
  } finally {
    store.close()
  }

  downgradeToV6(join(ws.root, 'kanobot.sqlite'))

  store = ws.open()
  try {
    const preserved = store.getModelCall(historicalCall.id)
    assert.deepEqual(preserved, historicalCall)

    const vision = store.beginModelCall({
      conversationId: 'main',
      userMessageId,
      purpose: 'vision',
      provider: 'test',
      model: 'vision-model',
    })
    assert.throws(
      () =>
        store.finishModelCall(vision.id, {
          status: 'succeeded',
          assistantMessageId,
          attempts: 1,
        }),
      (error: unknown) =>
        error instanceof StorageError && error.code === 'RECORD_INVALID',
    )
    const finishedVision = store.finishModelCall(vision.id, {
      status: 'succeeded',
      assistantMessageId: null,
      attempts: 1,
      responseId: 'vision-response',
    })
    assert.equal(finishedVision.purpose, 'vision')
    assert.equal(finishedVision.assistantMessageId, null)
    assert.equal(finishedVision.status, 'succeeded')

    const db = new DatabaseSync(store.databasePath, { readOnly: true })
    try {
      const versions = db.prepare(
        'SELECT version FROM schema_migrations ORDER BY version',
      ).all() as Array<Record<string, unknown>>
      assert.deepEqual(
        versions.map(row => Number(row.version)),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      )
      const ddl = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'model_calls'",
      ).get() as { sql: string } | undefined
      assert.match(ddl?.sql ?? '', /'vision'/)
      const oldRow = db.prepare(
        'SELECT purpose, assistant_message_id FROM model_calls WHERE id = ?',
      ).get(historicalCall.id) as Record<string, unknown>
      assert.equal(oldRow.purpose, 'chat')
      assert.equal(oldRow.assistant_message_id, assistantMessageId)
    } finally {
      db.close()
    }
  } finally {
    store.close()
  }
})

function downgradeToV6(databasePath: string): void {
  const db = new DatabaseSync(databasePath)
  try {
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec(`
      CREATE TABLE model_calls_v6 (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        assistant_message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        local_day TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'aborted')),
        attempts INTEGER NOT NULL CHECK (attempts >= 0),
        input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
        output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
        cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
        cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
        reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
        total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
        estimated_cost REAL CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
        pricing_json TEXT,
        response_id TEXT,
        error_code TEXT,
        purpose TEXT NOT NULL DEFAULT 'chat'
          CHECK (purpose IN ('chat', 'memory_extraction'))
      ) STRICT;
      INSERT INTO model_calls_v6
        (id, conversation_id, user_message_id, assistant_message_id,
         provider, model, started_at, completed_at, local_day, status,
         attempts, input_tokens, output_tokens, cache_read_tokens,
         cache_write_tokens, reasoning_tokens, total_tokens, estimated_cost,
         pricing_json, response_id, error_code, purpose)
      SELECT
        id, conversation_id, user_message_id, assistant_message_id,
        provider, model, started_at, completed_at, local_day, status,
        attempts, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, reasoning_tokens, total_tokens, estimated_cost,
        pricing_json, response_id, error_code, purpose
      FROM model_calls;
      DROP TABLE model_calls;
      ALTER TABLE model_calls_v6 RENAME TO model_calls;
      CREATE INDEX model_calls_conversation_started_index
        ON model_calls(conversation_id, started_at);
      CREATE INDEX model_calls_local_day_index ON model_calls(local_day);
      CREATE INDEX model_calls_user_message_index ON model_calls(user_message_id);
      CREATE INDEX model_calls_assistant_message_index ON model_calls(assistant_message_id);
      CREATE INDEX model_calls_purpose_index ON model_calls(purpose);
      DROP TABLE reply_style_checks;
      CREATE TABLE reply_style_checks (
        id TEXT PRIMARY KEY,
        assistant_message_id TEXT NOT NULL UNIQUE
          REFERENCES messages(id) ON DELETE CASCADE,
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
        violation_codes_json TEXT NOT NULL,
        checked_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX reply_style_checks_checked_at_index
        ON reply_style_checks(checked_at);
    `)
    dropCurrentInitiativeTables(db)
    dropCurrentChannelTables(db)
    downgradeMemoriesToV9(db)
    db.exec('DELETE FROM schema_migrations')
    const migration = db.prepare(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
    )
    for (let version = 1; version <= 6; version += 1) {
      migration.run(version, '2026-11-05T00:00:00.000Z')
    }
    db.exec('PRAGMA user_version = 6')
  } finally {
    db.close()
  }
}
