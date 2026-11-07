/**
 * OneBot 正向 WebSocket 客户端测试。
 *
 * 本机临时 WebSocket 服务模拟 NapCat：验证 Bearer 鉴权、动作响应、
 * 有效 message_id 判定，以及响应缺少 message_id 时按“结果未知”失败。
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'

import { WebSocketServer, type WebSocket } from 'ws'

import {
  OneBotActionError,
  OneBotClient,
  QqConnectionTestError,
  testOneBotConnection,
  type QqGatewayState,
} from '../../src/channels/index.ts'

test('authenticates, sends with message_id, and reports unknown on a missing id', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  let authorization: string | undefined
  server.on('connection', (socket: WebSocket, request) => {
    authorization = request.headers.authorization
    socket.on('message', raw => {
      const action = JSON.parse(raw.toString()) as {
        action: string
        params: Record<string, unknown>
        echo: string
      }
      if (action.action === 'get_login_info') {
        socket.send(JSON.stringify({
          status: 'ok',
          retcode: 0,
          data: { user_id: 12345 },
          echo: action.echo,
        }))
        return
      }
      if (action.action === 'send_private_msg') {
        const message = Array.isArray(action.params.message)
          ? action.params.message as Array<{ data?: { text?: string } }>
          : []
        const text = message[0]?.data?.text
        socket.send(JSON.stringify({
          status: 'ok',
          retcode: 0,
          data: text === 'missing-id' ? {} : { message_id: 777 },
          echo: action.echo,
        }))
        return
      }
      socket.send(JSON.stringify({
        status: 'failed',
        retcode: 1400,
        data: {},
        echo: action.echo,
      }))
    })
  })

  const port = (server.address() as AddressInfo).port
  const client = new OneBotClient({
    url: `ws://127.0.0.1:${port}`,
    token: 'test-token',
    connectTimeoutMs: 2_000,
    actionTimeoutMs: 2_000,
    reconnectMinMs: 500,
    reconnectMaxMs: 1_000,
    pingIntervalMs: 0,
    logger: { info(): void {}, error(): void {} },
  })
  try {
    const states: QqGatewayState[] = []
    client.setHandlers({
      onEvent(): void {},
      onState(state): void {
        states.push(state)
      },
    })
    client.start()
    await waitUntil(
      () => client.connected() && client.currentSelfId() === '12345',
    )

    assert.equal(authorization, 'Bearer test-token')
    assert.equal(
      await client.sendText(
        { kind: 'private', id: '10001' },
        'hello',
        new AbortController().signal,
      ),
      '777',
    )
    await assert.rejects(
      client.sendText(
        { kind: 'private', id: '10001' },
        'missing-id',
        new AbortController().signal,
      ),
      (error: unknown) =>
        error instanceof OneBotActionError &&
        error.code === 'missing_message_id' &&
        error.mayHaveSent,
    )
    assert.ok(states.some(state => state.event === 'opened'))
  } finally {
    await client.close()
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('the one-shot connection test verifies token and login info without sending messages', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const actions: string[] = []
  let authorization: string | undefined
  server.on('connection', (socket: WebSocket, request) => {
    authorization = request.headers.authorization
    socket.on('message', raw => {
      const action = JSON.parse(raw.toString()) as {
        action: string
        echo: string
      }
      actions.push(action.action)
      socket.send(JSON.stringify({
        status: 'ok',
        retcode: 0,
        data: { user_id: 12345 },
        echo: action.echo,
      }))
    })
  })

  try {
    const port = (server.address() as AddressInfo).port
    const result = await testOneBotConnection({
      url: `ws://127.0.0.1:${port}`,
      token: 'test-token',
      connectTimeoutMs: 1_000,
      actionTimeoutMs: 1_000,
    })
    assert.equal(result.selfId, '12345')
    assert.equal(result.durationMs >= 0, true)
    assert.equal(authorization, 'Bearer test-token')
    assert.deepEqual(actions, ['get_login_info'])
  } finally {
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('the connection test maps WebSocket 401 to a stable auth error', async () => {
  const httpServer = createServer()
  httpServer.on('upgrade', (_request, socket) => {
    socket.write(
      'HTTP/1.1 401 Unauthorized\r\n' +
        'Connection: close\r\n' +
        'Content-Length: 0\r\n\r\n',
    )
    socket.end()
  })
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', resolve)
  })
  try {
    const port = (httpServer.address() as AddressInfo).port
    await assert.rejects(
      testOneBotConnection({
        url: `ws://127.0.0.1:${port}`,
        token: 'wrong-token-must-not-leak',
        connectTimeoutMs: 1_000,
        actionTimeoutMs: 1_000,
      }),
      (error: unknown) =>
        error instanceof QqConnectionTestError &&
        error.code === 'qq_test_auth_failed' &&
        !error.message.includes('wrong-token-must-not-leak'),
    )
  } finally {
    await new Promise<void>(resolve => httpServer.close(() => resolve()))
  }
})

test('the connection test times out when NapCat never answers login info', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  server.on('connection', () => {
    // 保持连接但故意不返回 get_login_info 响应。
  })

  try {
    const port = (server.address() as AddressInfo).port
    await assert.rejects(
      testOneBotConnection({
        url: `ws://127.0.0.1:${port}`,
        token: null,
        connectTimeoutMs: 20,
        actionTimeoutMs: 20,
      }),
      (error: unknown) =>
        error instanceof QqConnectionTestError &&
        error.code === 'qq_test_timeout',
    )
  } finally {
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('the connection test rejects an invalid URL without opening a socket', async () => {
  await assert.rejects(
    testOneBotConnection({
      url: 'not-a-websocket-url',
      token: null,
      connectTimeoutMs: 100,
      actionTimeoutMs: 100,
    }),
    (error: unknown) =>
      error instanceof QqConnectionTestError &&
      error.code === 'qq_test_invalid_url',
  )
})

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('timed out waiting for OneBot client')
}
