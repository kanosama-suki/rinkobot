/**
 * QQ 渠道设置 HTTP 适配测试。
 *
 * 使用临时配置、内存聊天服务和注入的连接测试函数，验证设置接口复用
 * 所有者鉴权、只读保护、请求体限制和敏感值不回显。测试不连接真实
 * NapCat，也不读取真实 QQ 凭据。
 */

import assert from 'node:assert/strict'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  KanobotChatService,
  MockChatModel,
} from '../../src/core/chat/index.ts'
import { loadConfigFromDirectory } from '../../src/core/config/index.ts'
import { LocalSecretStore } from '../../src/model-providers/index.ts'
import {
  ChannelSettingsService,
  type ChannelSettingsDraft,
  type ChannelSettingsView,
} from '../../src/settings/index.ts'
import {
  CHAT_BASE_PATH,
  registerChatSurface,
} from '../../src/web/index.ts'
import { createWorkspace } from '../helpers/storage-fixture.ts'

const examplesDir = fileURLToPath(
  new URL('../../config/examples', import.meta.url),
)

test('channel settings HTTP authenticates and never echoes secrets', async () => {
  const configDir = copyExampleConfig()
  const ws = createWorkspace(test)
  const store = ws.open()
  const token = 'napcat-http-token-must-not-leak'
  let testedToken: string | null = null
  const service = new ChannelSettingsService({
    configDir,
    loaded: loadConfigFromDirectory(configDir),
    secretStore: new LocalSecretStore(configDir),
    testConnection: async input => {
      testedToken = input.token
      return { selfId: '10001', durationMs: 7 }
    },
  })
  const server = await startSurfaceServer(service, store)

  try {
    for (const [path, method, body] of [
      ['/kanobot/api/settings/channels', 'GET', undefined],
      ['/kanobot/api/settings/channels/status', 'GET', undefined],
      ['/kanobot/api/settings/channels/test', 'POST', '{}'],
      ['/kanobot/api/settings/channels', 'PUT', '{}'],
    ] as const) {
      const response = await fetch(`${server.baseUrl}${path}`, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { 'content-type': 'application/json' },
              body,
            }),
      })
      assert.equal(response.status, 401)
    }

    const viewResponse = await fetch(
      `${server.baseUrl}/kanobot/api/settings/channels`,
      { headers: authHeaders() },
    )
    assert.equal(viewResponse.status, 200)
    const viewText = await viewResponse.text()
    const view = JSON.parse(viewText) as ChannelSettingsView
    assert.equal(view.qq.credential.configured, true)
    assert.equal(viewText.includes('NAPCAT_ACCESS_TOKEN'), true)
    assert.equal(viewText.includes('accessTokenSecret'), false)

    const draft = draftFromView(view)
    draft.qq.credential = { mode: 'new', value: token }
    const testResponse = await fetch(
      `${server.baseUrl}/kanobot/api/settings/channels/test`,
      {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify(draft),
      },
    )
    assert.equal(testResponse.status, 200)
    const testResult = await testResponse.json() as {
      ok: boolean
      selfId: string
      durationMs: number
    }
    assert.equal(testResult.ok, true)
    assert.equal(testResult.selfId, '10001')
    assert.equal(testedToken, token)
    assert.equal(
      existsSync(join(configDir, 'channel-settings.json')),
      false,
    )

    const saveResponse = await fetch(
      `${server.baseUrl}/kanobot/api/settings/channels`,
      {
        method: 'PUT',
        headers: {
          ...authHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify(draft),
      },
    )
    assert.equal(saveResponse.status, 200)
    const saveText = await saveResponse.text()
    assert.equal(saveText.includes(token), false)
    assert.equal(saveText.includes('secret_'), false)
    assert.equal(
      readFileSync(
        join(configDir, 'channel-settings.json'),
        'utf8',
      ).includes(token),
      false,
    )
    assert.equal(
      readFileSync(
        join(configDir, 'secrets', 'model-secrets.json'),
        'utf8',
      ).includes(token),
      false,
    )

    const statusResponse = await fetch(
      `${server.baseUrl}/kanobot/api/settings/channels/status`,
      { headers: authHeaders() },
    )
    assert.equal(statusResponse.status, 200)
    const statusText = await statusResponse.text()
    assert.equal(statusText.includes(token), false)
    assert.equal(statusText.includes('secret_'), false)
    const status = JSON.parse(statusText) as {
      qq: { state: string; configured: boolean }
    }
    assert.equal(status.qq.state, 'disabled')
    assert.equal(status.qq.configured, true)

    const unknownField = await fetch(
      `${server.baseUrl}/kanobot/api/settings/channels`,
      {
        method: 'PUT',
        headers: {
          ...authHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...draft,
          qq: { ...draft.qq, unexpected: token },
        }),
      },
    )
    assert.equal(unknownField.status, 400)
    const unknownText = await unknownField.text()
    assert.equal(unknownText.includes(token), false)
    assert.match(unknownText, /invalid_channel_settings/)

    const malformedNested = await fetch(
      `${server.baseUrl}/kanobot/api/settings/channels`,
      {
        method: 'PUT',
        headers: {
          ...authHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...draft,
          qq: { ...draft.qq, coalesce: null },
        }),
      },
    )
    assert.equal(malformedNested.status, 400)
    assert.match(await malformedNested.text(), /invalid_channel_settings/)

    const oversized = await fetch(
      `${server.baseUrl}/kanobot/api/settings/channels`,
      {
        method: 'PUT',
        headers: {
          ...authHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ padding: 'x'.repeat(300 * 1024) }),
      },
    )
    assert.equal(oversized.status, 413)
  } finally {
    await server.close()
    store.close()
    rmSync(join(configDir, '..'), { recursive: true, force: true })
  }
})

test('read-only channel settings allow viewing and testing but reject saves', async () => {
  const configDir = copyExampleConfig()
  const ws = createWorkspace(test)
  const store = ws.open()
  let tested = false
  const service = new ChannelSettingsService({
    configDir,
    loaded: loadConfigFromDirectory(configDir),
    readOnly: true,
    testConnection: async () => {
      tested = true
      return { selfId: '10001', durationMs: 1 }
    },
  })
  const server = await startSurfaceServer(service, store)

  try {
    const viewResponse = await fetch(
      `${server.baseUrl}/kanobot/api/settings/channels`,
      { headers: authHeaders() },
    )
    assert.equal(viewResponse.status, 200)
    const view = await viewResponse.json() as ChannelSettingsView
    assert.equal(view.readOnly, true)

    const draft = draftFromView(view)
    draft.qq.credential = { mode: 'none' }
    const testResponse = await fetch(
      `${server.baseUrl}/kanobot/api/settings/channels/test`,
      {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify(draft),
      },
    )
    assert.equal(testResponse.status, 200)
    assert.equal(tested, true)

    const saveResponse = await fetch(
      `${server.baseUrl}/kanobot/api/settings/channels`,
      {
        method: 'PUT',
        headers: {
          ...authHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify(draft),
      },
    )
    assert.equal(saveResponse.status, 409)
    const error = await saveResponse.json() as {
      error: { code: string }
    }
    assert.equal(error.error.code, 'settings_read_only')
    assert.equal(
      existsSync(join(configDir, 'channel-settings.json')),
      false,
    )
  } finally {
    await server.close()
    store.close()
    rmSync(join(configDir, '..'), { recursive: true, force: true })
  }
})

function copyExampleConfig(): string {
  const root = mkdtempSync(join(tmpdir(), 'kanobot-channel-http-'))
  const configDir = join(root, 'config')
  cpSync(examplesDir, configDir, { recursive: true })
  return configDir
}

function draftFromView(view: ChannelSettingsView): ChannelSettingsDraft {
  const qq = view.qq
  return {
    qq: {
      enabled: qq.enabled,
      wsUrl: qq.wsUrl,
      allowRemote: qq.allowRemote,
      credential: { mode: 'keep' },
      ownerQqId: qq.ownerQqId,
      privateAllow: [...qq.privateAllow],
      groupAllow: [...qq.groupAllow],
      groupRequireMention: qq.groupRequireMention,
      autonomousTarget: qq.autonomousTarget,
      connectTimeoutMs: qq.connectTimeoutMs,
      actionTimeoutMs: qq.actionTimeoutMs,
      turnTimeoutMs: qq.turnTimeoutMs,
      reconnectMinMs: qq.reconnectMinMs,
      reconnectMaxMs: qq.reconnectMaxMs,
      pingIntervalMs: qq.pingIntervalMs,
      dedupeRetentionHours: qq.dedupeRetentionHours,
      coalesce: { ...qq.coalesce },
      images: { ...qq.images },
      outbound: { ...qq.outbound },
      limits: { ...qq.limits },
    },
  }
}

function authHeaders(): Record<string, string> {
  return { 'x-test-auth': 'kanobot' }
}

async function startSurfaceServer(
  channels: ChannelSettingsService,
  store: ReturnType<ReturnType<typeof createWorkspace>['open']>,
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  let handler:
    | ((
        request: import('node:http').IncomingMessage,
        response: import('node:http').ServerResponse,
      ) => void | Promise<void>)
    | undefined
  const dispose = registerChatSurface({
    webServer: {
      register(route): () => void {
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
    chat: new KanobotChatService(store, new MockChatModel()),
    channels,
    logger: { info(): void {} },
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
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
      dispose()
    },
  }
}
