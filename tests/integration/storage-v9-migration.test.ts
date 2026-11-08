/**
 * schema v8 → v9 迁移测试。
 *
 * 验证 M3 的聊天与模型调用历史保留，旧 outbox 被标记为 legacy 且不再
 * 伪装成新的主动消息；M4 的新表、状态和内部模型调用契约可用。
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  createWorkspace,
  dropCurrentChannelTables,
  dropCurrentInitiativeTables,
  downgradeMemoriesToV9,
} from '../helpers/storage-fixture.ts'

test('a v8 database migrates to v9 without losing chat, model calls or legacy outbox', () => {
  const ws = createWorkspace(test)
  let store = ws.open()
  let modelCallId = ''
  try {
    const user = store.appendChatMessage({
      id: 'message-v8-user',
      conversationId: 'main',
      role: 'user',
      text: 'v8 迁移前保留的虚构用户消息。',
      createdAt: '2026-11-05T00:00:00.000Z',
    })
    const assistant = store.appendChatMessage({
      id: 'message-v8-assistant',
      conversationId: 'main',
      role: 'assistant',
      text: 'v8 迁移前保留的虚构回复。',
      createdAt: '2026-11-05T00:00:01.000Z',
    })
    const call = store.beginModelCall({
      id: 'model-call-v8',
      conversationId: 'main',
      userMessageId: user.id,
      provider: 'test-provider',
      model: 'test-model',
      startedAt: '2026-11-05T00:00:02.000Z',
    })
    modelCallId = call.id
    store.finishModelCall(call.id, {
      status: 'succeeded',
      completedAt: '2026-11-05T00:00:03.000Z',
      assistantMessageId: assistant.id,
      attempts: 1,
    })
    store.putBody({
      id: 'body-v8-legacy-outbox',
      kind: 'outbox_system',
      content: 'v8 遗留的虚构待投递内容。',
      createdAt: '2026-11-05T00:00:04.000Z',
    })
    store.putOutbox({
      id: 'outbox-v8-legacy',
      target: 'web:owner',
      payloadRef: 'body-v8-legacy-outbox',
      kind: 'system',
      status: 'pending',
      dueAt: null,
      createdAt: '2026-11-05T00:00:05.000Z',
      updatedAt: '2026-11-05T00:00:09.000Z',
      attempts: 2,
      maxAttempts: 5,
      lastErrorCode: 'old_error',
      deliveredMessageId: null,
    })
  } finally {
    store.close()
  }

  downgradeToV8(join(ws.root, 'kanobot.sqlite'))
  store = ws.open()
  try {
    const legacy = store.getOutbox('outbox-v8-legacy')
    assert.ok(legacy)
    assert.equal(legacy.kind, 'legacy')
    assert.equal(legacy.updatedAt, '2026-11-05T00:00:05.000Z')
    assert.equal(legacy.maxAttempts, 5)
    assert.equal(legacy.attempts, 2)
    assert.equal(legacy.lastErrorCode, 'old_error')
    assert.equal(legacy.deliveredMessageId, null)

    const call = store.getModelCall(modelCallId)
    assert.ok(call)
    assert.equal(call.status, 'succeeded')
    assert.equal(call.purpose, 'chat')
    assert.equal(call.userMessageId, 'message-v8-user')
    assert.equal(
      store.getChatMessage('message-v8-assistant')?.text,
      'v8 迁移前保留的虚构回复。',
    )

    const state = store.getInitiativeState()
    assert.equal(state.consecutiveUnanswered, 0)
    assert.equal(state.circuitOpenedAt, null)
    assert.equal(state.lastDailyPlanDay, null)

    const internalCall = store.beginModelCall({
      conversationId: 'main',
      purpose: 'initiative',
      provider: 'test-provider',
      model: 'test-model',
      startedAt: '2026-11-05T01:00:00.000Z',
    })
    assert.equal(internalCall.userMessageId, null)
    store.finishModelCall(internalCall.id, {
      status: 'failed',
      completedAt: '2026-11-05T01:00:01.000Z',
      attempts: 1,
      errorCode: 'test_failure',
    })

    const newOutbox = store.enqueueOutbox({
      id: 'outbox-v9-new',
      target: 'web:owner',
      kind: 'system',
      text: 'v9 新 outbox。',
      maxAttempts: 3,
      createdAt: '2026-11-05T01:00:00.000Z',
    })
    assert.equal(newOutbox.kind, 'system')

    const db = new DatabaseSync(store.databasePath, { readOnly: true })
    try {
      const versions = db.prepare(
        'SELECT version FROM schema_migrations ORDER BY version',
      ).all() as Array<Record<string, unknown>>
      assert.deepEqual(
        versions.map(row => Number(row.version)),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      )
      const tables = db.prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'initiative_state', 'life_plan_items', 'reminders',
           'reminder_candidates', 'care_items', 'daily_summaries',
           'initiative_runs'
         )
         ORDER BY name`,
      ).all() as Array<Record<string, unknown>>
      assert.equal(tables.length, 7)
    } finally {
      db.close()
    }
  } finally {
    store.close()
  }
})

function downgradeToV8(databasePath: string): void {
  const db = new DatabaseSync(databasePath)
  try {
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec(`
      CREATE TABLE outbox_v8 (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        payload_ref TEXT NOT NULL,
        status TEXT NOT NULL,
        due_at TEXT,
        created_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error_code TEXT
      ) STRICT;
      INSERT INTO outbox_v8
        (id, target, payload_ref, status, due_at, created_at, attempts,
         last_error_code)
      SELECT id, target, payload_ref, status, due_at, created_at, attempts,
             last_error_code
      FROM outbox;
      DROP TABLE outbox;
      ALTER TABLE outbox_v8 RENAME TO outbox;
      CREATE INDEX outbox_payload_ref_index ON outbox(payload_ref);
      CREATE INDEX outbox_status_index ON outbox(status);
    `)
    assert.deepEqual(
      migrationVersions(db),
      [12],
    )
    db.exec(`
      CREATE TABLE model_calls_v8 (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL
          REFERENCES conversations(id) ON DELETE CASCADE,
        user_message_id TEXT NOT NULL
          REFERENCES messages(id) ON DELETE CASCADE,
        assistant_message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL DEFAULT 'chat'
          CHECK (purpose IN ('chat', 'memory_extraction', 'vision')),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        local_day TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('running', 'succeeded', 'failed', 'aborted')),
        attempts INTEGER NOT NULL CHECK (attempts >= 0),
        input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
        output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
        cache_read_tokens INTEGER
          CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
        cache_write_tokens INTEGER
          CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
        reasoning_tokens INTEGER
          CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
        total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
        estimated_cost REAL
          CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
        pricing_json TEXT,
        response_id TEXT,
        error_code TEXT
      ) STRICT;
      INSERT INTO model_calls_v8
        (id, conversation_id, user_message_id, assistant_message_id, purpose,
         provider, model, started_at, completed_at, local_day, status,
         attempts, input_tokens, output_tokens, cache_read_tokens,
         cache_write_tokens, reasoning_tokens, total_tokens, estimated_cost,
         pricing_json, response_id, error_code)
      SELECT id, conversation_id, user_message_id, assistant_message_id,
             purpose, provider, model, started_at, completed_at, local_day,
             status, attempts, input_tokens, output_tokens, cache_read_tokens,
             cache_write_tokens, reasoning_tokens, total_tokens,
             estimated_cost, pricing_json, response_id, error_code
      FROM model_calls
      WHERE user_message_id IS NOT NULL;
      DROP TABLE model_calls;
      ALTER TABLE model_calls_v8 RENAME TO model_calls;
      CREATE INDEX model_calls_conversation_started_index
        ON model_calls(conversation_id, started_at);
      CREATE INDEX model_calls_local_day_index ON model_calls(local_day);
      CREATE INDEX model_calls_user_message_index
        ON model_calls(user_message_id);
      CREATE INDEX model_calls_assistant_message_index
        ON model_calls(assistant_message_id);
      CREATE INDEX model_calls_purpose_index ON model_calls(purpose);
    `)
    assert.deepEqual(
      migrationVersions(db),
      [12],
    )
    dropCurrentInitiativeTables(db)
    dropCurrentChannelTables(db)
    downgradeMemoriesToV9(db)
    db.exec('DELETE FROM schema_migrations')
    const migration = db.prepare(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
    )
    for (let version = 1; version <= 8; version += 1) {
      migration.run(version, '2026-11-05T00:00:00.000Z')
    }
    db.exec('PRAGMA user_version = 8')
    assert.deepEqual(
      migrationVersions(db),
      [1, 2, 3, 4, 5, 6, 7, 8],
    )
  } finally {
    db.close()
  }
}

function migrationVersions(db: DatabaseSync): number[] {
  const versions = db.prepare(
    'SELECT version FROM schema_migrations ORDER BY version',
  ).all() as Array<Record<string, unknown>>
  return versions.map(row => Number(row.version))
}
