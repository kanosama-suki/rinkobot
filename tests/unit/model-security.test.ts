/**
 * 模型端点与本地密钥存储的安全边界测试。
 *
 * 不访问公网：DNS 结果和失败由注入的 lookup 伪造；secret store 只使用
 * 临时目录，验证写入、读取、密文落盘和损坏时 fail-closed。
 */

import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { validateModelBaseUrl } from '../../src/core/config/index.ts'
import {
  createEndpointPreflight,
  endpointSecurityInternals,
  LocalSecretStore,
  SecretStoreError,
} from '../../src/model-providers/index.ts'

test('endpoint preflight rejects local, private and failed DNS targets', async () => {
  const publicPreflight = createEndpointPreflight(
    'https://api.example.com/v1',
    {
      allowPrivateNetwork: false,
      lookupHost: async () => [{ address: '93.184.216.34', family: 4 }],
    },
  )
  await publicPreflight()

  const localhost = createEndpointPreflight('https://localhost/v1', {
    allowPrivateNetwork: false,
  })
  await assert.rejects(
    localhost,
    /private or local address/,
  )

  const privateDns = createEndpointPreflight('https://api.example.com/v1', {
    allowPrivateNetwork: false,
    lookupHost: async () => [{ address: '10.12.0.8', family: 4 }],
  })
  await assert.rejects(privateDns, /private or local address/)

  const mappedLoopback = createEndpointPreflight(
    'https://[::ffff:7f00:1]/v1',
    { allowPrivateNetwork: false },
  )
  await assert.rejects(mappedLoopback, /private or local address/)

  const metadata = createEndpointPreflight(
    'https://169.254.169.254/v1',
    { allowPrivateNetwork: false },
  )
  await assert.rejects(metadata, /private or local address/)

  const failedDns = createEndpointPreflight('https://api.example.com/v1', {
    allowPrivateNetwork: false,
    lookupHost: async () => {
      throw new Error('dns failed')
    },
  })
  await assert.rejects(failedDns, /could not be resolved/)

  let lookups = 0
  const explicitlyPrivate = createEndpointPreflight(
    'http://10.12.0.8/v1',
    {
      allowPrivateNetwork: true,
      lookupHost: async () => {
        lookups += 1
        return []
      },
    },
  )
  await explicitlyPrivate()
  assert.equal(lookups, 0)
})

test('address classifier handles IPv4-mapped IPv6 instead of trusting prefix text', () => {
  for (const address of [
    '127.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '::ffff:a00:1',
    'fd00::1',
    'fe80::1',
    '169.254.169.254',
  ]) {
    assert.equal(endpointSecurityInternals.isPrivateAddress(address), true, address)
  }
  assert.equal(
    endpointSecurityInternals.isPrivateAddress('93.184.216.34'),
    false,
  )
  assert.equal(
    endpointSecurityInternals.isPrivateAddress('2606:4700:4700::1111'),
    false,
  )
})

test('third-party base URLs require HTTPS and explicit private-network opt-in', () => {
  assert.equal(
    validateModelBaseUrl(
      'https://api.example.com/v1/',
      'model.base_url',
      'openai-compatible',
      false,
    ),
    'https://api.example.com/v1',
  )
  assert.throws(
    () =>
      validateModelBaseUrl(
        'http://api.example.com/v1',
        'model.base_url',
        'openai-compatible',
        false,
      ),
    /require HTTPS/,
  )
  assert.throws(
    () =>
      validateModelBaseUrl(
        'https://127.0.0.1:8080/v1',
        'model.base_url',
        'openai-compatible',
        false,
      ),
    /private or loopback/,
  )
  assert.equal(
    validateModelBaseUrl(
      'http://127.0.0.1:8080/v1',
      'model.base_url',
      'openai-compatible',
      true,
    ),
    'http://127.0.0.1:8080/v1',
  )
  assert.throws(
    () =>
      validateModelBaseUrl(
        'https://[::ffff:7f00:1]/v1',
        'model.base_url',
        'openai-compatible',
        false,
      ),
    /private or loopback/,
  )
})

test('local secret store encrypts values and fails closed on corruption', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'kanobot-secret-store-'))
  const plaintext = 'sk-test-only-0123456789'
  try {
    const store = new LocalSecretStore(configDir)
    const reference = store.put(plaintext, 'test credential')
    assert.match(reference, /^secret_[A-Za-z0-9]{16,80}$/)
    assert.equal(store.get(reference), plaintext)
    assert.equal(store.has(reference), true)
    assert.equal(store.describe(reference), 'test credential')

    const storePath = join(configDir, 'secrets', 'model-secrets.json')
    const keyPath = join(configDir, 'secrets', 'model-secrets.key')
    for (const path of [storePath, keyPath]) {
      assert.equal(
        readFileSync(path).includes(Buffer.from(plaintext, 'utf8')),
        false,
        `${path} must not contain plaintext credentials`,
      )
    }

    writeFileSync(storePath, '{"schemaVersion":1,"entries":', 'utf8')
    assert.throws(
      () => store.get(reference),
      (error: unknown) =>
        error instanceof SecretStoreError &&
        error.code === 'secret_store_corrupt',
    )
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('local secret store reports a wrong key without exposing ciphertext', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'kanobot-secret-key-'))
  const plaintext = 'sk-test-only-wrong-key'
  try {
    const store = new LocalSecretStore(configDir)
    const reference = store.put(plaintext, 'test credential')
    writeFileSync(
      join(configDir, 'secrets', 'model-secrets.key'),
      Buffer.alloc(32, 0x42),
    )
    assert.throws(
      () => store.get(reference),
      (error: unknown) => {
        assert.ok(error instanceof SecretStoreError)
        assert.equal(error.code, 'secret_decrypt_failed')
        assert.doesNotMatch(error.message, new RegExp(plaintext))
        return true
      },
    )
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})
