/**
 * QQ 渠道设置服务测试。
 *
 * 只使用临时配置目录、示例配置副本和注入的测试连接函数；不连接真实
 * NapCat，不读取或写入任何真实凭据。
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
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  QqCredentialError,
  resolveQqAccessToken,
} from '../../src/channels/index.ts'
import { loadConfigFromDirectory } from '../../src/core/config/index.ts'
import { LocalSecretStore } from '../../src/model-providers/index.ts'
import {
  ChannelSettingsError,
  ChannelSettingsService,
  type ChannelSettingsDraft,
  type ChannelSettingsView,
  type QqRuntimeSnapshot,
} from '../../src/settings/index.ts'

const examplesDir = fileURLToPath(
  new URL('../../config/examples', import.meta.url),
)

test('channel settings save a local secret without echoing it', async () => {
  const root = createRoot()
  try {
    const configDir = join(root, 'config')
    const loaded = loadConfigFromDirectory(configDir)
    const store = new LocalSecretStore(configDir)
    const service = new ChannelSettingsService({
      configDir,
      loaded,
      secretStore: store,
      runtimeStatus: () => ({ enabled: false, connection: null }),
    })
    const token = 'napcat-test-token-must-not-leak'
    const draft = draftFromView(service.view())
    draft.qq.credential = { mode: 'new', value: token }

    const saved = await service.save(draft)
    assert.equal(saved.qq.credential.mode, 'local-secret')
    assert.equal(saved.qq.credential.configured, true)
    assert.equal(JSON.stringify(saved).includes(token), false)
    assert.equal(JSON.stringify(saved).includes('secret_'), false)

    const overlay = readFileSync(
      join(configDir, 'channel-settings.json'),
      'utf8',
    )
    assert.equal(overlay.includes(token), false)
    assert.equal(
      readFileSync(
        join(configDir, 'secrets', 'model-secrets.json'),
        'utf8',
      ).includes(token),
      false,
    )

    const reloaded = loadConfigFromDirectory(configDir)
    assert.notEqual(reloaded.channels.qq.accessTokenSecret, null)
    assert.equal(
      store.get(reloaded.channels.qq.accessTokenSecret ?? ''),
      token,
    )

    const status = service.status()
    assert.equal(status.state, 'disabled')
    assert.equal(status.label, 'QQ 未启用')
    assert.equal(status.configured, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('owner QQ must be explicit, whitelisted, and removable', async () => {
  const root = createRoot()
  try {
    const configDir = join(root, 'config')
    const service = new ChannelSettingsService({
      configDir,
      loaded: loadConfigFromDirectory(configDir),
    })
    assert.equal(service.view().qq.ownerQqId, null)

    const draft = draftFromView(service.view())
    draft.qq.ownerQqId = '10001'
    await assert.rejects(
      () => service.save(draft),
      (error: unknown) =>
        error instanceof ChannelSettingsError &&
        error.code === 'invalid_channel_settings',
    )

    draft.qq.privateAllow = ['10001']
    const saved = await service.save(draft)
    assert.equal(saved.qq.ownerQqId, '10001')
    assert.equal(
      loadConfigFromDirectory(configDir).channels.qq.ownerQqId,
      '10001',
    )

    const cleared = draftFromView(saved)
    cleared.qq.ownerQqId = null
    const restored = await service.save(cleared)
    assert.equal(restored.qq.ownerQqId, null)
    assert.equal(
      loadConfigFromDirectory(configDir).channels.qq.ownerQqId,
      null,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failed save preserves the overlay and the previous local secret', async () => {
  const root = createRoot()
  try {
    const configDir = join(root, 'config')
    const loaded = loadConfigFromDirectory(configDir)
    const store = new LocalSecretStore(configDir)
    const service = new ChannelSettingsService({
      configDir,
      loaded,
      secretStore: store,
    })
    const token = 'napcat-test-token-preserved'
    const valid = draftFromView(service.view())
    valid.qq.credential = { mode: 'new', value: token }
    await service.save(valid)

    const overlayPath = join(configDir, 'channel-settings.json')
    const before = readFileSync(overlayPath, 'utf8')
    const secretRef = service.view()
    assert.equal(secretRef.qq.credential.configured, true)

    const invalid = draftFromView(secretRef)
    invalid.qq.wsUrl = 'ws://example.invalid:3001'
    invalid.qq.allowRemote = true
    invalid.qq.credential = { mode: 'keep' }
    await assert.rejects(
      () => service.save(invalid),
      (error: unknown) =>
        error instanceof ChannelSettingsError &&
        error.code === 'invalid_channel_settings',
    )

    assert.equal(readFileSync(overlayPath, 'utf8'), before)
    const after = loadConfigFromDirectory(configDir)
    assert.equal(
      store.get(after.channels.qq.accessTokenSecret ?? ''),
      token,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('connection tests use the draft without saving it', async () => {
  const root = createRoot()
  try {
    const configDir = join(root, 'config')
    const loaded = loadConfigFromDirectory(configDir)
    const store = new LocalSecretStore(configDir)
    let captured: {
      url: string
      token: string | null
      connectTimeoutMs: number
      actionTimeoutMs: number
    } | null = null
    const service = new ChannelSettingsService({
      configDir,
      loaded,
      secretStore: store,
      testConnection: async input => {
        captured = input
        return { selfId: '10001', durationMs: 12 }
      },
    })
    const draft = draftFromView(service.view())
    draft.qq.credential = { mode: 'new', value: 'draft-only-token' }

    const result = await service.test(draft)
    assert.equal(result.selfId, '10001')
    assert.equal(captured?.token, 'draft-only-token')
    assert.equal(existsSync(join(configDir, 'channel-settings.json')), false)
    assert.equal(existsSync(join(configDir, 'secrets')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('read-only examples can be viewed and tested but never saved', async () => {
  let tested = false
  const loaded = loadConfigFromDirectory(examplesDir)
  const service = new ChannelSettingsService({
    configDir: examplesDir,
    loaded,
    readOnly: true,
    testConnection: async () => {
      tested = true
      return { selfId: '10001', durationMs: 1 }
    },
  })
  const view = service.view()
  assert.equal(view.readOnly, true)
  const draft = draftFromView(view)
  draft.qq.credential = { mode: 'none' }
  await service.test(draft)
  assert.equal(tested, true)
  await assert.rejects(
    () => service.save(draft),
    (error: unknown) =>
      error instanceof ChannelSettingsError &&
      error.code === 'settings_read_only',
  )
})

test('rejects remote ws URLs and autonomous targets outside the whitelist', async () => {
  const root = createRoot()
  try {
    const configDir = join(root, 'config')
    const loaded = loadConfigFromDirectory(configDir)
    const service = new ChannelSettingsService({ configDir, loaded })

    const remote = draftFromView(service.view())
    remote.qq.wsUrl = 'ws://example.invalid:3001'
    remote.qq.allowRemote = true
    remote.qq.credential = { mode: 'none' }
    await assert.rejects(
      () => service.save(remote),
      /wss:\/\/|remote WebSocket endpoints must use wss/,
    )

    const target = draftFromView(service.view())
    target.qq.privateAllow = ['10001']
    target.qq.groupAllow = []
    target.qq.autonomousTarget = 'private:10002'
    await assert.rejects(
      () => service.save(target),
      /target must be present in the matching whitelist/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('status maps every runtime state without pretending a save reconnects', () => {
  const root = createRoot()
  try {
    const configDir = join(root, 'config')
    let runtime: QqRuntimeSnapshot = { enabled: false, connection: null }
    const service = new ChannelSettingsService({
      configDir,
      loaded: loadConfigFromDirectory(configDir),
      runtimeStatus: () => runtime,
    })

    assert.equal(service.status().state, 'disabled')
    runtime = { enabled: true, connection: null }
    assert.equal(service.status().state, 'connecting')
    runtime = {
      enabled: true,
      connection: {
        connected: true,
        selfId: '10001',
        event: 'opened',
      },
    }
    assert.equal(service.status().state, 'connected')
    assert.equal(service.status().selfId, '10001')
    runtime = {
      enabled: true,
      connection: {
        connected: false,
        selfId: '10001',
        event: 'reconnecting',
        detailCode: 'socket_closed',
      },
    }
    assert.equal(service.status().state, 'reconnecting')
    runtime = {
      enabled: true,
      connection: {
        connected: false,
        selfId: null,
        event: 'closed',
        detailCode: 'channel_closed',
      },
    }
    assert.equal(service.status().state, 'stopped')
    runtime = {
      enabled: true,
      connection: {
        connected: false,
        selfId: null,
        event: 'closed',
        detailCode: 'socket_closed',
      },
    }
    assert.equal(service.status().state, 'error')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the runtime overlay wins over channels.toml and can stand alone', async () => {
  const root = createRoot()
  try {
    const configDir = join(root, 'config')
    const service = new ChannelSettingsService({
      configDir,
      loaded: loadConfigFromDirectory(configDir),
    })
    const draft = draftFromView(service.view())
    draft.qq.enabled = true
    draft.qq.wsUrl = 'ws://127.0.0.1:4101'
    draft.qq.privateAllow = ['10001']
    await service.save(draft)

    const channelsPath = join(configDir, 'channels.toml')
    writeFileSync(
      channelsPath,
      readFileSync(channelsPath, 'utf8').replace(
        'ws_url = "ws://127.0.0.1:3001"',
        'ws_url = "ws://127.0.0.1:4999"',
      ),
      'utf8',
    )
    const loaded = loadConfigFromDirectory(configDir)
    assert.equal(loaded.channels.qq.wsUrl, 'ws://127.0.0.1:4101')
    assert.equal(loaded.channels.qq.enabled, true)

    const overlayOnlyRoot = mkdtempSync(
      join(tmpdir(), 'kanobot-overlay-only-'),
    )
    try {
      const overlayOnlyConfig = join(overlayOnlyRoot, 'config')
      cpSync(examplesDir, overlayOnlyConfig, { recursive: true })
      rmSync(join(overlayOnlyConfig, 'channels.toml'))
      const base = loadConfigFromDirectory(overlayOnlyConfig)
      assert.equal(base.channels.qq.enabled, false)
      const overlayOnly = new ChannelSettingsService({
        configDir: overlayOnlyConfig,
        loaded: base,
      })
      const standalone = draftFromView(overlayOnly.view())
      standalone.qq.enabled = true
      standalone.qq.privateAllow = ['10001']
      await overlayOnly.save(standalone)
      const reloaded = loadConfigFromDirectory(overlayOnlyConfig)
      assert.equal(reloaded.channels.qq.enabled, true)
      assert.deepEqual(reloaded.channels.qq.privateAllow, ['10001'])
    } finally {
      rmSync(overlayOnlyRoot, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a broken overlay fails closed instead of falling back to channels.toml', async () => {
  const root = createRoot()
  try {
    const configDir = join(root, 'config')
    writeFileSync(
      join(configDir, 'channel-settings.json'),
      '{"schema_version":1,"qq":{"enabled":true}}\n',
      'utf8',
    )
    assert.throws(
      () => loadConfigFromDirectory(configDir),
      /channel-settings\.json/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('environment and local secret sources are mutually exclusive', async () => {
  const root = createRoot()
  try {
    const configDir = join(root, 'config')
    const service = new ChannelSettingsService({
      configDir,
      loaded: loadConfigFromDirectory(configDir),
    })
    const draft = draftFromView(service.view())
    draft.qq.credential = { mode: 'new', value: 'napcat-conflict-token' }
    await service.save(draft)

    const overlayPath = join(configDir, 'channel-settings.json')
    const overlay = JSON.parse(
      readFileSync(overlayPath, 'utf8'),
    ) as { qq: Record<string, unknown> }
    overlay.qq.access_token_env = 'NAPCAT_ACCESS_TOKEN'
    writeFileSync(overlayPath, JSON.stringify(overlay), 'utf8')

    assert.throws(
      () => loadConfigFromDirectory(configDir),
      /mutually exclusive/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a missing local secret makes an enabled QQ channel fail closed', async () => {
  const root = createRoot()
  try {
    const configDir = join(root, 'config')
    const store = new LocalSecretStore(configDir)
    const service = new ChannelSettingsService({
      configDir,
      loaded: loadConfigFromDirectory(configDir),
      secretStore: store,
    })
    const draft = draftFromView(service.view())
    draft.qq.credential = { mode: 'new', value: 'napcat-missing-token' }
    await service.save(draft)
    const loaded = loadConfigFromDirectory(configDir)
    const reference = loaded.channels.qq.accessTokenSecret
    assert.ok(reference)
    assert.equal(store.delete(reference), true)
    assert.equal(store.delete(reference), false)
    assert.throws(
      () => resolveQqAccessToken(loaded.channels.qq, store),
      (error: unknown) =>
        error instanceof QqCredentialError &&
        error.code === 'qq_token_secret_missing',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('replacing a local secret removes the old reference', async () => {
  const root = createRoot()
  try {
    const configDir = join(root, 'config')
    const store = new LocalSecretStore(configDir)
    const service = new ChannelSettingsService({
      configDir,
      loaded: loadConfigFromDirectory(configDir),
      secretStore: store,
    })
    const first = draftFromView(service.view())
    first.qq.credential = { mode: 'new', value: 'napcat-first-token' }
    await service.save(first)
    const firstReference =
      loadConfigFromDirectory(configDir).channels.qq.accessTokenSecret
    assert.ok(firstReference)

    const second = draftFromView(service.view())
    second.qq.credential = { mode: 'new', value: 'napcat-second-token' }
    await service.save(second)
    const secondReference =
      loadConfigFromDirectory(configDir).channels.qq.accessTokenSecret
    assert.ok(secondReference)
    assert.notEqual(secondReference, firstReference)
    assert.equal(store.has(firstReference), false)
    assert.equal(store.get(secondReference), 'napcat-second-token')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kanobot-channel-settings-'))
  cpSync(examplesDir, join(root, 'config'), { recursive: true })
  return root
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
