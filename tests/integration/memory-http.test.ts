/**
 * M3.3 所有者记忆面板 HTTP 测试。
 *
 * 用真实 node:http 和临时数据库验证鉴权、增删改、候选转正、回收站和彻底清除。
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'

import { KanobotChatService, MockChatModel } from '../../src/core/chat/index.ts'
import { KanobotMemoryService } from '../../src/core/memory/index.ts'
import { CHAT_BASE_PATH, registerChatSurface } from '../../src/web/index.ts'
import { createWorkspace } from '../helpers/storage-fixture.ts'

test('memory API fails closed without a DSH session', async () => {
  const harness = await createHarness()
  try {
    const response = await fetch(`${harness.baseUrl}/kanobot/api/memories`)
    assert.equal(response.status, 401)
  } finally {
    await harness.close()
  }
})

test('owner can create, search, correct, trash, restore and purge memories', async () => {
  const harness = await createHarness()
  try {
    const empty = await request(harness, '/kanobot/api/memories')
    assert.equal(empty.status, 200)
    const emptyBody = await empty.json() as {
      memories: unknown[]
      counts: { active: number; candidate: number; trash: number }
    }
    assert.deepEqual(emptyBody.memories, [])
    assert.deepEqual(emptyBody.counts, { active: 0, candidate: 0, trash: 0 })

    const createdResponse = await request(harness, '/kanobot/api/memories', {
      method: 'POST',
      body: {
        text: 'kano 喜欢早上喝咖啡。',
        kind: 'preference',
        importance: 'important',
      },
    })
    assert.equal(createdResponse.status, 201)
    const createdBody = await createdResponse.json() as {
      memory: { id: string; status: string; text: string }
    }
    assert.equal(createdBody.memory.status, 'active')
    assert.equal(createdBody.memory.text, 'kano 喜欢早上喝咖啡。')
    const id = createdBody.memory.id

    const search = await request(harness, '/kanobot/api/memories?q=咖啡')
    const searchBody = await search.json() as {
      memories: Array<{ id: string }>
    }
    assert.deepEqual(searchBody.memories.map(memory => memory.id), [id])

    const corrected = await request(harness, `/kanobot/api/memories/${id}`, {
      method: 'PATCH',
      body: {
        text: 'kano 现在喜欢喝不加糖的咖啡。',
        kind: 'preference',
        importance: 'important',
      },
    })
    assert.equal(corrected.status, 200)
    const correctedBody = await corrected.json() as {
      memory: { id: string; status: string }
    }
    assert.notEqual(correctedBody.memory.id, id)
    assert.equal(correctedBody.memory.status, 'active')

    const old = await request(harness, `/kanobot/api/memories/${id}`)
    assert.equal(old.status, 200)
    const oldBody = await old.json() as { memory: { status: string } }
    assert.equal(oldBody.memory.status, 'replaced')

    const trashed = await request(harness, `/kanobot/api/memories/${correctedBody.memory.id}`, {
      method: 'DELETE',
    })
    assert.equal(trashed.status, 200)
    const trashedBody = await trashed.json() as {
      memory: { status: string; purgeAfter: string | null }
    }
    assert.equal(trashedBody.memory.status, 'deleted')
    assert.ok(trashedBody.memory.purgeAfter)

    const trash = await request(harness, '/kanobot/api/memories?status=trash')
    const trashBody = await trash.json() as { counts: { trash: number } }
    assert.equal(trashBody.counts.trash, 1)

    const restored = await request(
      harness,
      `/kanobot/api/memories/${correctedBody.memory.id}/restore`,
      { method: 'POST' },
    )
    assert.equal(restored.status, 200)
    const restoredBody = await restored.json() as {
      memory: { status: string }
    }
    assert.equal(restoredBody.memory.status, 'active')

    const rejectedPurge = await request(
      harness,
      `/kanobot/api/memories/${correctedBody.memory.id}/purge`,
      { method: 'POST', body: {} },
    )
    assert.equal(rejectedPurge.status, 400)

    const purged = await request(
      harness,
      `/kanobot/api/memories/${correctedBody.memory.id}/purge`,
      { method: 'POST', body: { confirm: true } },
    )
    assert.equal(purged.status, 200)
    const gone = await request(
      harness,
      `/kanobot/api/memories/${correctedBody.memory.id}`,
    )
    assert.equal(gone.status, 404)
  } finally {
    await harness.close()
  }
})

test('candidate promotion and owner-confirmed sensitive memory use the panel API', async () => {
  const harness = await createHarness()
  try {
    const candidate = harness.memory.remember({
      text: 'kano 可能喜欢安静的书店。',
      kind: 'preference',
      source: 'rinko_inferred',
      confidence: 0.6,
    })
    const promoted = await request(
      harness,
      `/kanobot/api/memories/${candidate.id}/promote`,
      { method: 'POST' },
    )
    assert.equal(promoted.status, 200)
    const promotedBody = await promoted.json() as {
      memory: { status: string }
      counts: { candidate: number; active: number }
    }
    assert.equal(promotedBody.memory.status, 'active')
    assert.equal(promotedBody.counts.candidate, 0)
    assert.equal(promotedBody.counts.active, 1)

    const sensitive = await request(harness, '/kanobot/api/memories', {
      method: 'POST',
      body: {
        text: 'kano 对测试占位病历只让所有者查看。',
        kind: 'personal_fact',
        sensitivity: 'sensitive',
      },
    })
    assert.equal(sensitive.status, 201)
    const sensitiveBody = await sensitive.json() as {
      memory: { status: string; sensitivity: string }
    }
    assert.equal(sensitiveBody.memory.status, 'active')
    assert.equal(sensitiveBody.memory.sensitivity, 'sensitive')
  } finally {
    await harness.close()
  }
})

test('memory API rejects unknown fields and invalid enumeration values', async () => {
  const harness = await createHarness()
  try {
    const unknown = await request(harness, '/kanobot/api/memories', {
      method: 'POST',
      body: {
        text: '占位',
        kind: 'note',
        systemPrompt: '不该接受',
      },
    })
    assert.equal(unknown.status, 400)

    const invalidStatus = await request(
      harness,
      '/kanobot/api/memories?status=everything',
    )
    assert.equal(invalidStatus.status, 400)

    const invalidSensitivity = await request(harness, '/kanobot/api/memories', {
      method: 'POST',
      body: {
        text: '占位',
        kind: 'note',
        sensitivity: 'public',
      },
    })
    assert.equal(invalidSensitivity.status, 400)
  } finally {
    await harness.close()
  }
})

async function request(
  harness: Awaited<ReturnType<typeof createHarness>>,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'x-test-auth': 'kanobot',
    accept: 'application/json',
  }
  const init: RequestInit = { method: options.method ?? 'GET', headers }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  return fetch(`${harness.baseUrl}${path}`, init)
}

async function createHarness(): Promise<{
  baseUrl: string
  memory: KanobotMemoryService
  close(): Promise<void>
}> {
  const ws = createWorkspace(test)
  const store = ws.open()
  const memory = new KanobotMemoryService(store, ws.clock)
  const chat = new KanobotChatService(store, new MockChatModel())
  let handler: ((request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void | Promise<void>) | undefined
  const dispose = registerChatSurface({
    webServer: {
      register(route): () => void {
        assert.equal(route.kind, 'prefix')
        assert.equal(route.path, CHAT_BASE_PATH)
        handler = route.handler
        return () => {
          handler = undefined
        }
      },
    },
    connection: {
      admit(request): { peer: object } | { rejection: 401 } {
        return request.headers['x-test-auth'] === 'kanobot'
          ? { peer: {} }
          : { rejection: 401 }
      },
    },
    chat,
    memory,
    logger: {
      info(): void {},
    },
  })
  const server = createServer((request, response) => {
    assert.ok(handler)
    void handler(request, response)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    memory,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()))
      })
      dispose()
      store.close()
    },
  }
}
