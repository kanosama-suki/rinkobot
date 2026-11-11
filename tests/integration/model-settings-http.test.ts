/**
 * 模型设置 HTTP 适配测试。
 *
 * 验证设置接口与聊天页面共用所有者鉴权、GET 不回显密钥、PUT 能写运行时
 * 覆盖，同时保持普通聊天数据库不受影响。
 */

import assert from 'node:assert/strict'
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
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
import {
  loadConfigFromDirectory,
  RUNTIME_MODEL_SETTINGS_FILENAME,
} from '../../src/core/config/index.ts'
import { LocalSecretStore } from '../../src/model-providers/index.ts'
import {
  ModelSettingsService,
  type ModelSettingsDraft,
  type ModelSettingsView,
} from '../../src/settings/index.ts'
import {
  CHAT_BASE_PATH,
  registerChatSurface,
} from '../../src/web/index.ts'
import { createWorkspace } from '../helpers/storage-fixture.ts'

const examplesDir = fileURLToPath(
  new URL('../../config/examples', import.meta.url),
)

function copyExampleConfig(): string {
  const root = mkdtempSync(join(tmpdir(), 'kanobot-settings-http-'))
  const configDir = join(root, 'config')
  cpSync(examplesDir, configDir, { recursive: true })
  return configDir
}

function draftFromView(view: ModelSettingsView): ModelSettingsDraft {
  return {
    chat: {
      provider: view.chat.provider,
      name: view.chat.name,
      baseUrl: view.chat.baseUrl,
      timeoutMs: view.chat.timeoutMs,
      maxRetries: view.chat.maxRetries,
      maxOutputTokens: view.chat.maxOutputTokens,
      reasoningEffort: view.chat.reasoningEffort,
      allowPrivateNetwork: view.chat.allowPrivateNetwork,
      credential: { mode: 'none' },
    },
    vision: {
      enabled: view.vision.enabled,
      provider: view.vision.provider,
      name: view.vision.name,
      baseUrl: view.vision.baseUrl,
      timeoutMs: view.vision.timeoutMs,
      maxRetries: view.vision.maxRetries,
      maxOutputTokens: view.vision.maxOutputTokens,
      allowPrivateNetwork: view.vision.allowPrivateNetwork,
      maxImageBytes: view.vision.maxImageBytes,
      maxDescriptionChars: view.vision.maxDescriptionChars,
      credential: { mode: 'none' },
    },
  }
}

test('settings HTTP requires owner auth and never returns the credential value', async () => {
  const configDir = copyExampleConfig()
  const root = join(configDir, '..')
  const ws = createWorkspace(test)
  const store = ws.open()
  const plaintext = 'sk-http-settings-must-not-leak'
  const secretStore = new LocalSecretStore(configDir)
  const reference = secretStore.put(plaintext, 'http test credential')
  const systemPath = join(configDir, 'system.toml')
  writeFileSync(
    systemPath,
    readFileSync(systemPath, 'utf8').replace(
      '[model]\n',
      `[model]\napi_key_secret = "${reference}"\n`,
    ),
    'utf8',
  )

  let handler:
    | ((
        request: import('node:http').IncomingMessage,
        response: import('node:http').ServerResponse,
      ) => void | Promise<void>)
    | undefined
  const loaded = loadConfigFromDirectory(configDir)
  const models = new ModelSettingsService({
    configDir,
    loaded,
    secretStore,
  })
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
    models,
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
  const baseUrl = `http://127.0.0.1:${address.port}`

  try {
    const unauthenticated = await fetch(
      `${baseUrl}/kanobot/api/settings/models`,
    )
    assert.equal(unauthenticated.status, 401)

    const viewResponse = await fetch(
      `${baseUrl}/kanobot/api/settings/models`,
      { headers: authHeaders() },
    )
    assert.equal(viewResponse.status, 200)
    const viewText = await viewResponse.text()
    assert.equal(viewText.includes(plaintext), false)
    assert.equal(viewText.includes(reference), false)
    const view = JSON.parse(viewText) as ModelSettingsView
    assert.equal(view.chat.credential.mode, 'local-secret')
    assert.equal(view.chat.credential.configured, true)

    const unauthenticatedDiscovery = await fetch(
      `${baseUrl}/kanobot/api/settings/models/discover`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    )
    assert.equal(unauthenticatedDiscovery.status, 401)

    const discovery = await fetch(
      `${baseUrl}/kanobot/api/settings/models/discover`,
      {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          chat: {
            provider: 'mock',
            baseUrl: null,
            timeoutMs: 5_000,
            allowPrivateNetwork: false,
            credential: { mode: 'none' },
          },
          vision: {
            enabled: false,
            provider: null,
            baseUrl: null,
            timeoutMs: 5_000,
            allowPrivateNetwork: false,
            credential: { mode: 'none' },
          },
        }),
      },
    )
    assert.equal(discovery.status, 200)
    const discoveryBody = await discovery.json() as {
      chat: { models: unknown[] }
      vision: { enabled: boolean; supported: unknown[]; unknown: unknown[] }
    }
    assert.deepEqual(discoveryBody.chat.models, [])
    assert.equal(discoveryBody.vision.enabled, false)
    assert.deepEqual(discoveryBody.vision.supported, [])
    assert.deepEqual(discoveryBody.vision.unknown, [])

    const draft = draftFromView(view)
    draft.chat = {
      provider: 'mock',
      name: 'kanobot-mock-v1',
      baseUrl: null,
      timeoutMs: 5_000,
      maxRetries: 0,
      maxOutputTokens: null,
      reasoningEffort: null,
      allowPrivateNetwork: false,
      credential: { mode: 'none' },
    }
    const save = await fetch(
      `${baseUrl}/kanobot/api/settings/models`,
      {
        method: 'PUT',
        headers: {
          ...authHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify(draft),
      },
    )
    assert.equal(save.status, 200)
    const saved = await save.json() as ModelSettingsView
    assert.equal(saved.chat.provider, 'mock')
    assert.equal(saved.chat.baseUrl, null)
    assert.equal(
      loadConfigFromDirectory(configDir).system.model.provider,
      'mock',
    )
    const overlay = readFileSync(
      join(configDir, RUNTIME_MODEL_SETTINGS_FILENAME),
      'utf8',
    )
    assert.equal(overlay.includes(plaintext), false)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    })
    dispose()
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

function authHeaders(): Record<string, string> {
  return { 'x-test-auth': 'kanobot' }
}
