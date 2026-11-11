/**
 * 独立核心验收。
 *
 * 使用 mock 聊天/主动性 provider、本机 mock OneBot、临时配置和临时主库，
 * 验证网页聊天、QQ、记忆、提醒、主动消息和 scheduler 都能由同一进程
 * 的独立程序中工作。
 * 不连接真实 QQ、NapCat、模型或正式数据。
 */

import assert from 'node:assert/strict'
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { WebSocketServer, type WebSocket } from 'ws'

import { createAppServer } from '../../src/app/index.ts'
import { loadConfigFromDirectory } from '../../src/core/config/index.ts'
import {
  KanobotStorage,
} from '../../src/core/storage/index.ts'
import {
  createManualClock,
} from '../../src/core/state/index.ts'

const examplesDir = fileURLToPath(
  new URL('../../config/examples', import.meta.url),
)

test('standalone core chats, remembers, reminds, runs proactive, and handles mock QQ', async t => {
  const layout = createLayout(t)
  configureMockModel(layout.configDir)
  setTickSeconds(layout.configDir, 10)
  const qq = await startMockOneBot(t)
  configureMockQq(layout.configDir, qq.url)
  const clock = createManualClock('2026-11-11T02:00:00.000Z')
  const reminderText = '独立程序需要送达的虚构提醒。'
  const qqUserText = '通过 mock QQ 发送的虚构消息。'
  const loaded = loadConfigFromDirectory(layout.configDir)

  const store = KanobotStorage.openFromConfig(loaded, layout.dataDir, clock)
  try {
    const reminderSource = store.appendChatMessage({
      conversationId: 'main',
      role: 'user',
      text: '这是提醒来源的虚构用户消息。',
      createdAt: '2026-11-11T01:00:00.000Z',
    })
    const careSource = store.appendChatMessage({
      conversationId: 'main',
      role: 'user',
      text: '虚构的后续关心来源消息。',
      createdAt: '2026-11-11T01:01:00.000Z',
    })
    const candidate = store.putReminderCandidate({
      text: reminderText,
      dueAt: '2026-11-11T01:59:00.000Z',
      sourceMessageId: reminderSource.id,
      createdAt: '2026-11-11T01:00:00.000Z',
    })
    store.confirmReminderCandidate(candidate.id, '2026-11-11T01:01:00.000Z')
    store.putCareItem({
      text: '虚构的后续关心事项。',
      sourceMessageId: careSource.id,
      dueFrom: '2026-11-11T01:30:00.000Z',
      dueUntil: '2026-11-11T04:00:00.000Z',
      createdAt: '2026-11-11T01:01:00.000Z',
    })
  } finally {
    store.close()
  }

  const app = await createAppServer({
    configDir: layout.configDir,
    dataDir: layout.dataDir,
    port: 0,
    clock,
    logger: { info(): void {}, error(): void {} },
  })
  try {
    const health = await fetch(`${app.baseUrl}/kanobot/api/health`)
    assert.equal(health.status, 200)
    const healthBody = await health.json() as {
      scheduler: string
      qq: string
    }
    assert.equal(healthBody.scheduler, 'running')
    assert.equal(healthBody.qq, 'enabled')

    const cookie = await login(app.bootstrapUrl)
    const assistantMessages = await waitForMessages(
      app.baseUrl,
      cookie,
      messages =>
        messages.some(message => message.text === reminderText) &&
        messages.some(message => message.text.includes('之前那件事')),
    )
    assert.equal(
      assistantMessages.some(message => message.text === reminderText),
      true,
    )
    assert.equal(
      assistantMessages.some(message => message.text.includes('之前那件事')),
      true,
    )

    const chat = await fetch(`${app.baseUrl}/kanobot/api/chat`, {
      method: 'POST',
      headers: {
        cookie,
        origin: app.baseUrl,
        accept: 'text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: '独立核心聊天使用的虚构消息。' }),
    })
    assert.equal(chat.status, 200)
    const events = parseSse(await chat.text())
    assert.equal(events.some(event => event.type === 'done'), true)

    const memory = await fetch(`${app.baseUrl}/kanobot/api/memories`, {
      method: 'POST',
      headers: {
        cookie,
        origin: app.baseUrl,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text: '独立程序保存的虚构记忆。',
        kind: 'preference',
        importance: 'normal',
      }),
    })
    assert.equal(memory.status, 201)

    await qq.waitForConnection()
    qq.emitPrivateText(qqUserText)
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
    clock.advanceByMs(300)
    await waitUntil(() => qq.sentTexts.length > 0)
    const conversation = await fetch(
      `${app.baseUrl}/kanobot/api/conversation`,
      { headers: { cookie } },
    )
    assert.equal(conversation.status, 200)
    const conversationBody = await conversation.json() as {
      messages: ConversationMessage[]
    }
    assert.equal(
      conversationBody.messages.some(
        message => message.role === 'user' && message.text === qqUserText,
      ),
      true,
    )
  } finally {
    await app.close()
  }
})

function createLayout(t: TestContext): {
  root: string
  configDir: string
  dataDir: string
} {
  const root = mkdtempSync(join(tmpdir(), 'kanobot-standalone-'))
  const configDir = join(root, 'config')
  cpSync(examplesDir, configDir, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, configDir, dataDir: join(root, 'data') }
}

function configureMockModel(configDir: string): void {
  const path = join(configDir, 'system.toml')
  const source = readFileSync(path, 'utf8')
  const start = source.indexOf('[model]')
  const end = source.indexOf('[vision]')
  assert.ok(start >= 0 && end > start)
  const section = [
    '[model]',
    'provider = "mock"',
    'name = "kanobot-mock-v1"',
    'timeout_ms = 5000',
    'max_retries = 0',
    'max_output_tokens = 4096',
    '',
  ].join('\n')
  writeFileSync(
    path,
    `${source.slice(0, start)}${section}\n${source.slice(end)}`,
    'utf8',
  )
}

function setTickSeconds(configDir: string, seconds: number): void {
  const path = join(configDir, 'initiative.toml')
  const source = readFileSync(path, 'utf8')
  const updated = source.replace(
    /tick_seconds = \d+/,
    `tick_seconds = ${seconds}`,
  )
  assert.notEqual(updated, source)
  writeFileSync(path, updated, 'utf8')
}

function configureMockQq(configDir: string, url: string): void {
  const path = join(configDir, 'channels.toml')
  let source = readFileSync(path, 'utf8')
  const replacements: Array<[string, string]> = [
    ['enabled = false', 'enabled = true'],
    ['ws_url = "ws://127.0.0.1:3001"', `ws_url = "${url}"`],
    [
      'access_token_env = "NAPCAT_ACCESS_TOKEN"',
      '# access_token_env omitted for the local no-auth mock',
    ],
    [
      'allow_remote = false',
      'allow_remote = false\nowner_qq = "10001"',
    ],
    ['private_allow = []', 'private_allow = ["10001"]'],
    ['quiet_ms = 2500', 'quiet_ms = 200'],
    ['max_wait_ms = 10000', 'max_wait_ms = 1000'],
    ['min_interval_ms = 350', 'min_interval_ms = 0'],
    ['max_inbound_turns_per_minute = 20', 'max_inbound_turns_per_minute = 60'],
    ['max_outbound_parts_per_minute = 40', 'max_outbound_parts_per_minute = 120'],
  ]
  for (const [from, to] of replacements) {
    assert.equal(source.includes(from), true, `channels.toml missing ${from}`)
    source = source.replace(from, to)
  }
  writeFileSync(path, source, 'utf8')
}

interface MockOneBot {
  url: string
  sentTexts: string[]
  waitForConnection(): Promise<void>
  emitPrivateText(text: string): void
}

async function startMockOneBot(t: TestContext): Promise<MockOneBot> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('listening', resolveListen)
    server.once('error', rejectListen)
  })
  t.after(async () => {
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
  })

  const sockets = new Set<WebSocket>()
  const sentTexts: string[] = []
  let nextMessageId = 90_000

  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
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
          data: { user_id: 99999, nickname: 'mock-napcat' },
          echo: action.echo,
        }))
        return
      }
      if (action.action === 'send_private_msg') {
        const message = Array.isArray(action.params.message)
          ? action.params.message as Array<{
              type?: string
              data?: { text?: string }
            }>
          : []
        const text = message
          .filter(item => item.type === 'text')
          .map(item => item.data?.text ?? '')
          .join('')
        sentTexts.push(text)
        socket.send(JSON.stringify({
          status: 'ok',
          retcode: 0,
          data: { message_id: nextMessageId++ },
          echo: action.echo,
        }))
        return
      }
      socket.send(JSON.stringify({
        status: 'failed',
        retcode: 1404,
        data: {},
        echo: action.echo,
      }))
    })
  })

  const address = server.address() as AddressInfo
  return {
    url: `ws://127.0.0.1:${address.port}`,
    sentTexts,
    async waitForConnection(): Promise<void> {
      await waitUntil(() => sockets.size > 0)
    },
    emitPrivateText(text: string): void {
      const socket = sockets.values().next().value as WebSocket | undefined
      if (socket === undefined) throw new Error('mock OneBot is not connected')
      socket.send(JSON.stringify({
        post_type: 'message',
        message_type: 'private',
        self_id: 99999,
        user_id: 10001,
        message_id: 80_001,
        time: 1_791_000_000,
        message: [{ type: 'text', data: { text } }],
      }))
    },
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
  }
  throw new Error('timed out waiting for mock QQ delivery')
}

async function login(bootstrapUrl: string): Promise<string> {
  const response = await fetch(bootstrapUrl, { redirect: 'manual' })
  assert.equal(response.status, 303)
  const cookie = (response.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? ''
  assert.match(cookie, /^kanobot_app_session=/)
  return cookie
}

interface ConversationMessage {
  role: string
  text: string
}

async function waitForMessages(
  baseUrl: string,
  cookie: string,
  predicate: (messages: ConversationMessage[]) => boolean,
): Promise<ConversationMessage[]> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/kanobot/api/conversation`, {
      headers: { cookie },
    })
    assert.equal(response.status, 200)
    const body = await response.json() as {
      messages: ConversationMessage[]
    }
    const assistant = body.messages.filter(message => message.role === 'assistant')
    if (predicate(assistant)) return assistant
    await new Promise(resolveWait => setTimeout(resolveWait, 250))
  }
  throw new Error('timed out waiting for the scheduler to deliver reminder/proactive messages')
}

interface StreamEvent {
  type: string
}

function parseSse(text: string): StreamEvent[] {
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
    .map(data => JSON.parse(data) as StreamEvent)
}
