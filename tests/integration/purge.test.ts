/**
 * 彻底清除的文件级验收。
 *
 * 测试在独立临时目录中直接把正文写入 bodies，再调用永久清除；关闭数据库
 * 后扫描主库、墓碑库和所有 SQLite sidecar，确认原始 UTF-8 字节不再出现。
 * 备份文件按规划保留到过期，因此本用例不创建备份。
 */

import assert from 'node:assert/strict'
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  createWorkspace,
  memoryFor,
  outboxFor,
  testEvent,
} from '../helpers/storage-fixture.ts'

test('purging a body cascades references and leaves no plaintext in database files', () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  const secret = '待彻底清除的唯一正文-KB-PURGE-7f62c1'

  try {
    store.putBody({
      id: 'body-purge-1',
      kind: 'chat',
      content: secret,
    })
    store.putMemory(memoryFor('memory-purge-1', 'body-purge-1'))
    store.putOutbox(outboxFor('outbox-purge-1', 'body-purge-1'))
    store.appendEvent(
      testEvent(
        'event-purge-1',
        'commitment.created',
        {
          commitmentId: 'commitment-purge-1',
          descriptionRef: 'body-purge-1',
          dueAt: null,
        },
      ),
    )
    store.appendEvent(
      testEvent(
        'event-purge-2',
        'commitment.resolved',
        {
          commitmentId: 'commitment-purge-1',
          status: 'completed',
        },
        '2026-11-05T00:01:00.000Z',
      ),
    )
    store.createSnapshot()
    assert.equal(store.currentState().commitments.length, 1)
    assert.equal(store.currentState().commitments[0].status, 'completed')

    const result = store.purge({
      targetType: 'body',
      targetId: 'body-purge-1',
    })
    assert.equal(result.deletedBodies, 1)
    assert.equal(result.deletedMemories, 1)
    assert.equal(result.deletedOutbox, 1)
    assert.deepEqual(store.currentState().commitments, [])
    assert.equal(store.getBody('body-purge-1'), null)
    assert.equal(store.getMemory('memory-purge-1'), null)
    assert.equal(store.getOutbox('outbox-purge-1'), null)
    assert.equal(store.lastSequence, 2)
    assert.deepEqual(
      new Set(store.listTombstones().map(item => item.targetType)),
      new Set(['body', 'memory', 'outbox']),
    )
  } finally {
    store.close()
  }

  assertDatabaseFilesDoNotContain(ws.root, secret)
})

function assertDatabaseFilesDoNotContain(root: string, text: string): void {
  const needle = Buffer.from(text, 'utf8')
  const files = listFiles(root)
  assert.ok(files.some(path => path.endsWith('kanobot.sqlite')))
  assert.ok(files.some(path => path.endsWith('tombstones.sqlite')))
  for (const file of files) {
    const bytes = readFileSync(file)
    assert.equal(
      bytes.includes(needle),
      false,
      `plaintext remained in ${file}`,
    )
  }
  for (const sidecar of [
    join(root, 'kanobot.sqlite-wal'),
    join(root, 'kanobot.sqlite-shm'),
  ]) {
    if (existsSync(sidecar)) {
      rmSync(sidecar, { force: true })
    }
  }
}

function listFiles(root: string): string[] {
  const result: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      result.push(...listFiles(path))
    } else if (entry.isFile()) {
      result.push(path)
    }
  }
  return result
}
