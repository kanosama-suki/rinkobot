/**
 * 正式独立程序的回环 HTTP 集成测试。
 *
 * 使用临时配置和数据目录验证：显式目录要求、一次性登录、Cookie 鉴权、
 * 聊天持久化、模型设置视图、端口释放和存储 schema 版本。
 * 不读取正式数据、人格、凭据或聊天正文。
 */

import assert from 'node:assert/strict'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createAppServer } from '../../src/app/index.ts'
import type { ChatStreamEvent } from '../../src/core/chat/index.ts'
import { loadConfigFromDirectory } from '../../src/core/config/index.ts'
import {
  KanobotStorage,
  STORAGE_SCHEMA_VERSION,
} from '../../src/core/storage/index.ts'
import { systemClock } from '../../src/core/state/index.ts'
import type { ModelSettingsView } from '../../src/settings/index.ts'

const examplesDir = fileURLToPath(
  new URL('../../config/examples', import.meta.url),
)

interface TestLayout {
  root: string
  configDir: string
  dataDir: string
}
test('the standalone app authenticates, persists, and releases its port', async t => {
  const layout = createLayout(t)
  configureChatModel(layout.configDir)

  const first = await createAppServer({
    configDir: layout.configDir,
    dataDir: layout.dataDir,
    port: 0,
    logger: { info(): void {}, error(): void {} },
  })
  const cookie = await login(first.bootstrapUrl)
  try {
    assert.equal(first.baseUrl.startsWith('http://127.0.0.1:'), true)

    const unauthenticatedPage = await fetch(`${first.baseUrl}/kanobot/`)
    assert.equal(unauthenticatedPage.status, 401)
    const unauthenticatedApi = await fetch(
      `${first.baseUrl}/kanobot/api/settings/models`,
    )
    assert.equal(unauthenticatedApi.status, 401)

    const rootRedirect = await fetch(`${first.baseUrl}/`, {
      redirect: 'manual',
    })
    assert.equal(rootRedirect.status, 303)
    assert.equal(rootRedirect.headers.get('location'), '/kanobot/')

    const page = await fetch(`${first.baseUrl}/kanobot/`, {
      headers: { cookie },
    })
    assert.equal(page.status, 200)
    const pageText = await page.text()
    assert.match(pageText, /id="settings-open"/)
    assert.match(pageText, /id="settings-dialog"/)
    assert.equal(pageText.includes('id="tab-button-settings"'), false)
    assert.match(pageText, /id="settings-test"[^>]*disabled/)
    assert.match(pageText, /id="settings-save"[^>]*disabled/)
    assert.match(pageText, /id="channel-settings-form"/)
    assert.match(pageText, /id="chat-view-owner"/)
    assert.match(pageText, /id="chat-view-archive"/)
    assert.match(pageText, /id="archive-conversation"/)
    assert.match(pageText, /id="archive-rename-input"/)
    assert.match(pageText, /id="owner-qq-warning"/)
    assert.match(pageText, /id="history-more"/)
    assert.match(pageText, /id="channel-owner-qq"/)

    const settings = await fetch(
      `${first.baseUrl}/kanobot/api/settings/models`,
      { headers: { cookie } },
    )
    assert.equal(settings.status, 200)
    const view = await settings.json() as ModelSettingsView
    assert.equal(view.chat.provider, 'mock')
    const channels = await fetch(
      `${first.baseUrl}/kanobot/api/settings/channels`,
      { headers: { cookie } },
    )
    assert.equal(channels.status, 200)
    const channelView = await channels.json() as {
      qq: { credential: { configured: boolean } }
    }
    assert.equal(channelView.qq.credential.configured, true)
    assert.equal(JSON.stringify(channelView).includes('accessToken'), false)

    const badOrigin = await fetch(`${first.baseUrl}/kanobot/api/chat`, {
      method: 'POST',
      headers: {
        cookie,
        origin: 'http://malicious.invalid',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: '跨源请求不应写入' }),
    })
    assert.equal(badOrigin.status, 403)

    const chat = await fetch(`${first.baseUrl}/kanobot/api/chat`, {
      method: 'POST',
      headers: {
        cookie,
        origin: first.baseUrl,
        accept: 'text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: '独立程序持久化测试消息' }),
    })
    assert.equal(chat.status, 200)
    const events = parseSse(await chat.text())
    const done = events.find(event => event.type === 'done')
    assert.ok(done?.type === 'done')
    assert.equal(done.modelCall.status, 'succeeded')

    const conversation = await fetch(
      `${first.baseUrl}/kanobot/api/conversation`,
      { headers: { cookie } },
    )
    assert.equal(conversation.status, 200)
    const body = await conversation.json() as {
      messages: Array<{ role: string }>
    }
    assert.equal(body.messages.length, 2)
    assert.equal(body.messages[0]?.role, 'user')
    assert.equal(body.messages[1]?.role, 'assistant')

    const reusedLogin = await fetch(first.bootstrapUrl, {
      redirect: 'manual',
    })
    assert.equal(reusedLogin.status, 401)
  } finally {
    await first.close()
  }

  await assert.rejects(
    () => fetch(`${first.baseUrl}/kanobot/`, { headers: { cookie } }),
  )
  await assertPortCanBeReused(first.port)

  const databasePath = join(layout.dataDir, 'kanobot.sqlite')
  assert.equal(existsSync(databasePath), true)
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const row = database.prepare('PRAGMA user_version').get() as {
      user_version: number
    }
    assert.equal(row.user_version, STORAGE_SCHEMA_VERSION)
  } finally {
    database.close()
  }

  const second = await createAppServer({
    configDir: layout.configDir,
    dataDir: layout.dataDir,
    port: 0,
    logger: { info(): void {}, error(): void {} },
  })
  try {
    const secondCookie = await login(second.bootstrapUrl)
    const conversation = await fetch(
      `${second.baseUrl}/kanobot/api/conversation`,
      { headers: { cookie: secondCookie } },
    )
    assert.equal(conversation.status, 200)
    const body = await conversation.json() as {
      messages: Array<{ role: string }>
    }
    assert.equal(body.messages.length, 2)
  } finally {
    await second.close()
  }
})

test('the standalone app rejects missing and shared directories', async t => {
  const layout = createLayout(t)
  configureChatModel(layout.configDir)

  await assert.rejects(
    () =>
      createAppServer({
        configDir: '',
        dataDir: layout.dataDir,
        port: 0,
      }),
    /configDir must be provided explicitly/,
  )
  await assert.rejects(
    () =>
      createAppServer({
        configDir: layout.configDir,
        dataDir: '',
        port: 0,
      }),
    /dataDir must be provided explicitly/,
  )
  await assert.rejects(
    () =>
      createAppServer({
        configDir: layout.configDir,
        dataDir: layout.configDir,
        port: 0,
      }),
    /must be different directories/,
  )

})

test('the standalone app merges pre-existing owner QQ history on startup', async t => {
  const layout = createLayout(t)
  configureChatModel(layout.configDir)
  disableInitiative(layout.configDir)

  const beforeOwner = loadConfigFromDirectory(layout.configDir)
  const store = KanobotStorage.openFromConfig(
    beforeOwner,
    layout.dataDir,
    systemClock,
  )
  try {
    store.appendChatMessage({
      conversationId: 'main',
      role: 'user',
      text: '网页主会话的虚构消息。',
      id: 'startup-main',
      createdAt: '2026-11-08T01:00:00.000Z',
    })
    store.appendChatMessage({
      conversationId: 'qq-private-10001',
      role: 'user',
      text: '配置所有者之前的私聊虚构消息。',
      id: 'startup-owner-private',
      createdAt: '2026-11-08T02:00:00.000Z',
    })
  } finally {
    store.close()
  }
  configureOwnerQq(layout.configDir, '10001')

  const app = await createAppServer({
    configDir: layout.configDir,
    dataDir: layout.dataDir,
    port: 0,
    logger: { info(): void {}, error(): void {} },
  })
  try {
    const cookie = await login(app.bootstrapUrl)
    const conversation = await fetch(
      `${app.baseUrl}/kanobot/api/conversation`,
      { headers: { cookie } },
    )
    assert.equal(conversation.status, 200)
    const body = await conversation.json() as {
      messages: Array<{ id: string; conversationId: string }>
    }
    assert.deepEqual(
      body.messages.map(message => message.id),
      ['startup-main', 'startup-owner-private'],
    )
    assert.ok(
      body.messages.every(message => message.conversationId === 'main'),
    )

    const directory = await fetch(
      `${app.baseUrl}/kanobot/api/conversations`,
      { headers: { cookie } },
    )
    const directoryBody = await directory.json() as {
      conversations: Array<{ conversationId: string; messageCount: number }>
    }
    assert.equal(
      directoryBody.conversations.some(
        item => item.conversationId === 'qq-private-10001',
      ),
      false,
    )
    assert.equal(
      directoryBody.conversations.find(item => item.conversationId === 'main')
        ?.messageCount,
      2,
    )
  } finally {
    await app.close()
  }
})

test('switching chat provider preserves identity, conversation, memory, and state', async t => {
  const layout = createLayout(t)
  configureChatModel(layout.configDir)
  disableInitiative(layout.configDir)
  const identityPath = join(layout.configDir, 'identity.toml')
  const identityBefore = readFileSync(identityPath, 'utf8')

  const first = await createAppServer({
    configDir: layout.configDir,
    dataDir: layout.dataDir,
    port: 0,
    logger: { info(): void {}, error(): void {} },
  })
  let baselineState: unknown
  let baselineMemory: unknown
  try {
    const cookie = await login(first.bootstrapUrl)
    const chat = await fetch(`${first.baseUrl}/kanobot/api/chat`, {
      method: 'POST',
      headers: {
        cookie,
        origin: first.baseUrl,
        accept: 'text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: '用于 provider 切换测试的虚构消息' }),
    })
    assert.equal(chat.status, 200)
    await chat.text()

    const memory = await fetch(`${first.baseUrl}/kanobot/api/memories`, {
      method: 'POST',
      headers: {
        cookie,
        origin: first.baseUrl,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text: 'provider 切换测试使用虚构记忆。',
        kind: 'preference',
        importance: 'normal',
      }),
    })
    assert.equal(memory.status, 201)

    const conversation = await fetch(
      `${first.baseUrl}/kanobot/api/conversation`,
      { headers: { cookie } },
    )
    baselineState = (
      await conversation.json() as { state: unknown }
    ).state
    const memories = await fetch(
      `${first.baseUrl}/kanobot/api/memories?status=active`,
      { headers: { cookie } },
    )
    baselineMemory = (
      await memories.json() as { memories: unknown }
    ).memories
  } finally {
    await first.close()
  }

  const modelServer = await startModelServer()
  try {
    configureOpenAiCompatible(layout.configDir, modelServer.baseUrl)
    const second = await createAppServer({
      configDir: layout.configDir,
      dataDir: layout.dataDir,
      port: 0,
      logger: { info(): void {}, error(): void {} },
    })
    try {
      const cookie = await login(second.bootstrapUrl)
      const conversation = await fetch(
        `${second.baseUrl}/kanobot/api/conversation`,
        { headers: { cookie } },
      )
      assert.equal(conversation.status, 200)
      const body = await conversation.json() as {
        model: { provider: string }
        messages: Array<{ role: string }>
        state: unknown
      }
      assert.equal(body.model.provider, 'openai-compatible')
      assert.equal(body.messages.length, 2)
      assert.deepEqual(body.state, baselineState)

      const memories = await fetch(
        `${second.baseUrl}/kanobot/api/memories?status=active`,
        { headers: { cookie } },
      )
      const memoryBody = await memories.json() as { memories: unknown }
      assert.deepEqual(memoryBody.memories, baselineMemory)
    } finally {
      await second.close()
    }
  } finally {
    await modelServer.close()
  }

  assert.equal(readFileSync(identityPath, 'utf8'), identityBefore)
})

function createLayout(t: TestContext): TestLayout {
  const root = mkdtempSync(join(tmpdir(), 'kanobot-app-'))
  const configDir = join(root, 'config')
  cpSync(examplesDir, configDir, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return {
    root,
    configDir,
    dataDir: join(root, 'data'),
  }
}

function configureChatModel(configDir: string): void {
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

function configureOpenAiCompatible(
  configDir: string,
  baseUrl: string,
): void {
  const path = join(configDir, 'system.toml')
  const source = readFileSync(path, 'utf8')
  const start = source.indexOf('[model]')
  const end = source.indexOf('[vision]')
  assert.ok(start >= 0 && end > start)
  const section = [
    '[model]',
    'provider = "openai-compatible"',
    'name = "acme/chat-test"',
    `base_url = "${baseUrl}"`,
    'allow_private_network = true',
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

function configureOwnerQq(configDir: string, ownerQqId: string): void {
  const path = join(configDir, 'channels.toml')
  const source = readFileSync(path, 'utf8')
  const updated = source
    .replace('private_allow = []', `private_allow = ["${ownerQqId}"]`)
    .replace(
      '# owner_qq = "123456789"',
      `owner_qq = "${ownerQqId}"`,
    )
  assert.notEqual(updated, source)
  writeFileSync(path, updated, 'utf8')
}

function disableInitiative(configDir: string): void {
  const path = join(configDir, 'initiative.toml')
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replaceAll('enabled = true', 'enabled = false'),
    'utf8',
  )
}

interface ModelServer {
  baseUrl: string
  close(): Promise<void>
}

async function startModelServer(): Promise<ModelServer> {
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      if (request.url === '/v1/models') {
        writeJson(response, 200, {
          data: [{ id: 'acme/chat-test', max_output_tokens: 4096 }],
        })
        return
      }
      writeJson(response, 404, { error: { message: 'not found' } })
    },
  )
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as { port: number }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
    },
  }
}

function writeJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.byteLength),
  })
  response.end(body)
}

async function login(bootstrapUrl: string): Promise<string> {
  const response = await fetch(bootstrapUrl, { redirect: 'manual' })
  assert.equal(response.status, 303)
  assert.equal(response.headers.get('location'), '/kanobot/')
  const setCookie = response.headers.get('set-cookie') ?? ''
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Strict/)
  assert.match(setCookie, /Path=\/kanobot/)
  const cookie = setCookie.split(';', 1)[0] ?? ''
  assert.match(cookie, /^kanobot_app_session=/)
  return cookie
}

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

async function assertPortCanBeReused(port: number): Promise<void> {
  const server = createServer((_request, response) => {
    response.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()))
  })
}
