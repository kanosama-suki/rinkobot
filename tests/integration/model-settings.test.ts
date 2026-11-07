/**
 * 运行时模型设置服务集成测试。
 *
 * 临时复制示例配置后验证：密钥不回显、失败不落盘、null 覆盖能清除旧端点、
 * provider 变更拒绝复用旧密钥、只读示例目录不能保存，以及新密钥加密落盘。
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
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  loadConfigFromDirectory,
  RUNTIME_MODEL_SETTINGS_FILENAME,
} from '../../src/core/config/index.ts'
import {
  LocalSecretStore,
  type DshLlmBridge,
} from '../../src/model-providers/index.ts'
import {
  ModelSettingsError,
  ModelSettingsService,
  type ModelSettingsDraft,
  type ModelSettingsView,
} from '../../src/settings/index.ts'

const examplesDir = fileURLToPath(
  new URL('../../config/examples', import.meta.url),
)

function copyExampleConfig(): string {
  const root = mkdtempSync(join(tmpdir(), 'kanobot-settings-'))
  const configDir = join(root, 'config')
  cpSync(examplesDir, configDir, { recursive: true })
  return configDir
}

function draftFromView(view: ModelSettingsView): ModelSettingsDraft {
  return {
    chat: {
      provider: view.chat.provider,
      route: view.chat.route,
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

test('settings view exposes credential status but never the value or reference', () => {
  const configDir = copyExampleConfig()
  try {
    const plaintext = 'sk-view-must-not-leak'
    const store = new LocalSecretStore(configDir)
    const reference = store.put(plaintext, 'local test credential')
    const systemPath = join(configDir, 'system.toml')
    const system = readFileSync(systemPath, 'utf8').replace(
      '[model]\n',
      `[model]\napi_key_secret = "${reference}"\n`,
    )
    writeFileSync(systemPath, system, 'utf8')

    const loaded = loadConfigFromDirectory(configDir)
    const service = new ModelSettingsService({ configDir, loaded })
    const view = service.view()
    const serialized = JSON.stringify(view)
    assert.equal(serialized.includes(plaintext), false)
    assert.equal(serialized.includes(reference), false)
    assert.deepEqual(view.chat.credential, {
      mode: 'local-secret',
      environmentName: null,
      label: 'local test credential',
      configured: true,
    })
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('settings view reports whether the host exposes ctx.llm', () => {
  const configDir = copyExampleConfig()
  try {
    const loaded = loadConfigFromDirectory(configDir)
    const standalone = new ModelSettingsService({ configDir, loaded })
    assert.deepEqual(standalone.view().hostCapabilities.dshChat, {
      available: false,
      reason:
        '当前宿主没有提供 ctx.llm；DSH 路由只在具备该服务的 DSH 插件中使用。',
    })

    const plugin = new ModelSettingsService({
      configDir,
      loaded,
      llm: {} as DshLlmBridge,
    })
    assert.deepEqual(plugin.view().hostCapabilities.dshChat, {
      available: true,
      reason: null,
    })
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('saving mock explicitly clears inherited endpoint and reasoning fields', async () => {
  const configDir = copyExampleConfig()
  try {
    const service = new ModelSettingsService({
      configDir,
      loaded: loadConfigFromDirectory(configDir),
    })
    const draft = draftFromView(service.view())
    draft.chat = {
      provider: 'mock',
      route: null,
      name: 'kanobot-mock-v1',
      baseUrl: null,
      timeoutMs: 5_000,
      maxRetries: 0,
      maxOutputTokens: null,
      reasoningEffort: null,
      allowPrivateNetwork: false,
      credential: { mode: 'none' },
    }
    draft.vision.enabled = false
    draft.vision.provider = null
    draft.vision.name = null
    draft.vision.baseUrl = null
    draft.vision.maxOutputTokens = null

    const saved = await service.save(draft)
    assert.equal(saved.chat.provider, 'mock')
    assert.equal(saved.chat.baseUrl, null)
    assert.equal(saved.restartRequiredOnSave, true)

    const overlayPath = join(configDir, RUNTIME_MODEL_SETTINGS_FILENAME)
    const overlay = JSON.parse(readFileSync(overlayPath, 'utf8')) as {
      model: Record<string, unknown>
    }
    assert.equal(overlay.model.base_url, null)
    assert.equal(overlay.model.reasoning_effort, null)
    assert.equal(overlay.model.max_output_tokens, null)

    // 重新加载必须得到 mock，而不是残留旧 Magpie 端点导致配置失败。
    const reloaded = loadConfigFromDirectory(configDir)
    assert.equal(reloaded.system.model.provider, 'mock')
    assert.equal(reloaded.system.model.baseUrl, null)
    assert.equal(reloaded.system.model.reasoningEffort, null)
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('a failed connection test does not write runtime settings', async () => {
  const configDir = copyExampleConfig()
  try {
    const service = new ModelSettingsService({
      configDir,
      loaded: loadConfigFromDirectory(configDir),
    })
    const draft = draftFromView(service.view())
    draft.chat = {
      provider: 'openai-compatible',
      route: null,
      name: 'acme/chat',
      baseUrl: 'http://127.0.0.1:1/v1',
      timeoutMs: 1_000,
      maxRetries: 0,
      maxOutputTokens: 128,
      reasoningEffort: null,
      allowPrivateNetwork: true,
      credential: {
        mode: 'environment',
        environmentName: 'KANOBOT_TEST_MISSING_SETTINGS_KEY',
      },
    }
    await assert.rejects(
      () => service.test(draft),
      (error: unknown) =>
        error instanceof ModelSettingsError &&
        error.code === 'chat_model_test_failed',
    )
    assert.equal(
      existsSync(join(configDir, RUNTIME_MODEL_SETTINGS_FILENAME)),
      false,
    )
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('changing endpoint refuses to silently reuse an old credential', async () => {
  const configDir = copyExampleConfig()
  const previous = process.env.KANOBOT_TEST_PRESENT_KEY
  process.env.KANOBOT_TEST_PRESENT_KEY = 'sk-present-for-reuse-test'
  try {
    const systemPath = join(configDir, 'system.toml')
    const system = readFileSync(systemPath, 'utf8').replace(
      '[model]\n',
      '[model]\napi_key_env = "KANOBOT_TEST_PRESENT_KEY"\n',
    )
    writeFileSync(systemPath, system, 'utf8')
    const service = new ModelSettingsService({
      configDir,
      loaded: loadConfigFromDirectory(configDir),
    })
    const draft = draftFromView(service.view())
    draft.chat.baseUrl = 'http://127.0.0.1:9999/v1'
    draft.chat.credential = { mode: 'keep' }

    await assert.rejects(
      () => service.test(draft),
      (error: unknown) =>
        error instanceof ModelSettingsError &&
        error.code === 'credential_reuse_refused',
    )
    assert.equal(
      existsSync(join(configDir, RUNTIME_MODEL_SETTINGS_FILENAME)),
      false,
    )
  } finally {
    if (previous === undefined) delete process.env.KANOBOT_TEST_PRESENT_KEY
    else process.env.KANOBOT_TEST_PRESENT_KEY = previous
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('saving a new credential encrypts it and exposes only a local label', async () => {
  const configDir = copyExampleConfig()
  const server = createServer((request, response) => {
    if (request.url === '/v1/models') {
      const body = Buffer.from(
        JSON.stringify({
          data: [{ id: 'acme/chat', max_output_tokens: 1024 }],
        }),
        'utf8',
      )
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(body.byteLength),
      })
      response.end(body)
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  const plaintext = 'sk-settings-new-secret'

  try {
    const service = new ModelSettingsService({
      configDir,
      loaded: loadConfigFromDirectory(configDir),
    })
    const draft = draftFromView(service.view())
    draft.chat = {
      provider: 'openai-compatible',
      route: null,
      name: 'acme/chat',
      baseUrl,
      timeoutMs: 2_000,
      maxRetries: 0,
      maxOutputTokens: 256,
      reasoningEffort: null,
      allowPrivateNetwork: true,
      credential: { mode: 'new', value: plaintext },
    }
    draft.vision.enabled = false
    draft.vision.credential = { mode: 'none' }

    const saved = await service.save(draft)
    assert.equal(saved.chat.credential.mode, 'local-secret')
    assert.equal(saved.chat.credential.configured, true)
    assert.equal(saved.chat.credential.label, 'kanobot-chat')

    const overlay = readFileSync(
      join(configDir, RUNTIME_MODEL_SETTINGS_FILENAME),
      'utf8',
    )
    assert.match(overlay, /"api_key_secret": "secret_/)
    assert.equal(overlay.includes(plaintext), false)
    assert.equal(
      readFileSync(
        join(configDir, 'secrets', 'model-secrets.json'),
      ).includes(Buffer.from(plaintext, 'utf8')),
      false,
    )
    assert.equal(
      readFileSync(
        join(configDir, 'secrets', 'model-secrets.key'),
      ).includes(Buffer.from(plaintext, 'utf8')),
      false,
    )
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    })
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('the bundled example directory is read-only for settings', async () => {
  const service = new ModelSettingsService({
    configDir: examplesDir,
    loaded: loadConfigFromDirectory(examplesDir),
    readOnly: true,
  })
  await assert.rejects(
    () => service.save(draftFromView(service.view())),
    (error: unknown) =>
      error instanceof ModelSettingsError &&
      error.code === 'settings_read_only',
  )
})
