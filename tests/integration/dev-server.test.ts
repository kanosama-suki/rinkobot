/**
 * 不经过 DSH 的本地开发入口测试。
 *
 * 使用真实回环 HTTP、默认 mock 模型和临时数据目录；验证一次性 token、
 * Cookie 鉴权、过期、Origin 拒绝、页面/API fail-closed 和聊天闭环。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createDevServer } from '../../src/dev/index.ts'
import type { ChatStreamEvent } from '../../src/core/chat/index.ts'
import { createWorkspace } from '../helpers/storage-fixture.ts'

test('the local dev entry authenticates the whole surface with a one-time token', async t => {
  const ws = createWorkspace(t)
  const logs: string[] = []
  const server = await createDevServer({
    dataDir: ws.root,
    port: 0,
    clock: ws.clock,
    sessionTtlMs: 60_000,
    logger: {
      info(message): void {
        logs.push(message)
      },
    },
  })
  try {
    assert.match(server.bootstrapUrl, /[?&]token=/)
    assert.ok(logs.some(line => line.includes('one-time login')))

    const unauthenticatedPage = await fetch(`${server.baseUrl}/kanobot/`)
    assert.equal(unauthenticatedPage.status, 401)
    const unauthenticatedApi = await fetch(
      `${server.baseUrl}/kanobot/api/conversation`,
    )
    assert.equal(unauthenticatedApi.status, 401)

    const exchange = await fetch(server.bootstrapUrl, { redirect: 'manual' })
    assert.equal(exchange.status, 303)
    assert.equal(exchange.headers.get('location'), '/kanobot/')
    assert.equal(exchange.headers.get('location')?.includes('token'), false)
    const setCookie = exchange.headers.get('set-cookie') ?? ''
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /SameSite=Strict/)
    const cookie = setCookie.split(';', 1)[0] ?? ''
    assert.match(cookie, /^kanobot_dev_session=/)

    const reused = await fetch(server.bootstrapUrl, { redirect: 'manual' })
    assert.equal(reused.status, 401)

    const page = await fetch(`${server.baseUrl}/kanobot/`, {
      headers: { cookie },
    })
    assert.equal(page.status, 200)
    assert.match(await page.text(), /M4\.5 聊天、主动性与陪伴/)

    const badOrigin = await fetch(`${server.baseUrl}/kanobot/api/chat`, {
      method: 'POST',
      headers: {
        cookie,
        origin: 'http://malicious.invalid',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: '不应写入的虚构跨源消息' }),
    })
    assert.equal(badOrigin.status, 403)

    const chat = await fetch(`${server.baseUrl}/kanobot/api/chat`, {
      method: 'POST',
      headers: {
        cookie,
        origin: server.baseUrl,
        accept: 'text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: '本地开发入口的虚构消息' }),
    })
    assert.equal(chat.status, 200)
    const events = parseSse(await chat.text())
    const done = events.find(event => event.type === 'done')
    assert.ok(done?.type === 'done')
    assert.equal(done.modelCall.status, 'succeeded')

    const audit = await fetch(
      `${server.baseUrl}/kanobot/api/audit?source=chat&limit=20`,
      { headers: { cookie } },
    )
    assert.equal(audit.status, 200)
    const auditBody = await audit.json() as {
      timeline: Array<{ source: string }>
    }
    assert.ok(auditBody.timeline.every(entry => entry.source === 'chat'))
    assert.ok(auditBody.timeline.length >= 1)

    ws.clock.advanceByMs(60_001)
    const expired = await fetch(`${server.baseUrl}/kanobot/`, {
      headers: { cookie },
    })
    assert.equal(expired.status, 401)
  } finally {
    await server.close()
  }
})

function parseSse(text: string): ChatStreamEvent[] {
  return text
    .split('\n\n')
    .map(frame =>
      frame
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n'),
    )
    .filter(Boolean)
    .map(data => JSON.parse(data) as ChatStreamEvent)
}
