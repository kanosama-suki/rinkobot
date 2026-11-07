/**
 * OneBot 正向 WebSocket 客户端测试。
 *
 * 本机临时 WebSocket 服务模拟 NapCat：验证 Bearer 鉴权、动作响应、
 * 有效 message_id 判定，以及响应缺少 message_id 时按“结果未知”失败。
 */

import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import test from 'node:test'

import { WebSocketServer, type WebSocket } from 'ws'

import {
  OneBotActionError,
  OneBotClient,
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
