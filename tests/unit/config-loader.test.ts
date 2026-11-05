/**
 * 配置加载器的单元测试。
 *
 * 每个错误用例只破坏一条规则，并断言错误同时带文件名和字段路径；
 * 这样既能验证 fail-closed，也能防止错误定位信息退化。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  ConfigError,
  loadConfigFromDirectory,
} from '../../src/core/config/index.ts'

const examplesDir = fileURLToPath(new URL('../../config/examples', import.meta.url))

// 三个最小合法配置是错误用例的基线，每个失败测试只替换其中一条规则。
const validSystem = `schema_version = 1
environment = "development"

[time]
timezone = "Asia/Shanghai"
quiet_hours_start = "00:10"
quiet_hours_end = "07:00"

[model]
provider = "deepseek-official"
name = "deepseek-flash"
timeout_ms = 120000
max_retries = 2

[resources]
max_concurrent_model_calls = 2
daily_model_call_limit = 2000
`

const validIdentity = `schema_version = 1
mode = "placeholder"
display_name = "Kanobot Test"
owner_name = "kano"
`

const validPolicy = `schema_version = 1

[tools]
allow = []

[permissions]
allow_shell = false
allow_file_write = false
allow_network = false
allow_public_posting = false

[limits]
max_reply_chars = 2000
max_steps_per_turn = 1

[emergency]
stop_file = "STOP"
`

interface ConfigOverrides {
  system?: string
  identity?: string
  policy?: string
}

function writeConfigs(overrides: ConfigOverrides = {}): string {
  // 每个用例使用独立临时目录，避免测试之间共享或污染真实配置。
  const dir = mkdtempSync(join(tmpdir(), 'kanobot-config-'))
  writeFileSync(join(dir, 'system.toml'), overrides.system ?? validSystem, 'utf8')
  writeFileSync(join(dir, 'identity.toml'), overrides.identity ?? validIdentity, 'utf8')
  writeFileSync(join(dir, 'policy.toml'), overrides.policy ?? validPolicy, 'utf8')
  return dir
}

function expectIssue(
  action: () => unknown,
  expectedField: string,
  expectedFile: string,
): void {
  // 同时检查字段和文件，确保 ConfigError 不只是“报错了”而是能定位。
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ConfigError)
    assert.ok(
      error.issues.some(
        issue => issue.field === expectedField && issue.file.endsWith(expectedFile),
      ),
      `expected issue ${expectedFile} [${expectedField}], got ${JSON.stringify(error.issues)}`,
    )
    return true
  })
}

test('loads the checked-in example configuration', () => {
  const config = loadConfigFromDirectory(examplesDir)
  assert.equal(config.system.schemaVersion, 1)
  assert.equal(config.system.environment, 'development')
  assert.equal(config.system.time.timezone, 'Asia/Shanghai')
  assert.equal(config.identity.mode, 'placeholder')
  assert.deepEqual(config.policy.tools.allow, [])
  assert.equal(config.policy.permissions.allowShell, false)
})

test('maps snake_case TOML fields to typed runtime fields', () => {
  const dir = writeConfigs()
  try {
    const config = loadConfigFromDirectory(dir)
    assert.deepEqual(config.system.model, {
      provider: 'deepseek-official',
      name: 'deepseek-flash',
      timeoutMs: 120000,
      maxRetries: 2,
    })
    assert.equal(config.identity.displayName, 'Kanobot Test')
    assert.equal(config.policy.emergency.stopFile, 'STOP')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects an unknown nested field and reports file plus field', () => {
  const dir = writeConfigs({
    system: validSystem.replace('max_retries = 2', 'max_retries = 2\nsurprise = true'),
  })
  try {
    expectIssue(() => loadConfigFromDirectory(dir), 'model.surprise', 'system.toml')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects a wrong field type', () => {
  const dir = writeConfigs({
    system: validSystem.replace('daily_model_call_limit = 2000', 'daily_model_call_limit = "many"'),
  })
  try {
    expectIssue(
      () => loadConfigFromDirectory(dir),
      'resources.daily_model_call_limit',
      'system.toml',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects an unsupported schema version', () => {
  const dir = writeConfigs({
    policy: validPolicy.replace('schema_version = 1', 'schema_version = 2'),
  })
  try {
    expectIssue(() => loadConfigFromDirectory(dir), 'schema_version', 'policy.toml')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects malformed TOML and keeps the file in the error', () => {
  const dir = writeConfigs({
    system: validSystem.replace('timeout_ms = 120000', 'timeout_ms ='),
  })
  try {
    expectIssue(() => loadConfigFromDirectory(dir), '$', 'system.toml')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects a production deployment with placeholder identity', () => {
  const dir = writeConfigs({
    system: validSystem.replace(
      'environment = "development"',
      'environment = "production"',
    ),
  })
  try {
    expectIssue(() => loadConfigFromDirectory(dir), 'mode', 'identity.toml')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects a private identity without a persona file', () => {
  const dir = writeConfigs({
    identity: validIdentity.replace('mode = "placeholder"', 'mode = "private"'),
  })
  try {
    expectIssue(() => loadConfigFromDirectory(dir), 'persona_file', 'identity.toml')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects a persona path that escapes the data directory', () => {
  const dir = writeConfigs({
    identity:
      validIdentity.replace('mode = "placeholder"', 'mode = "private"') +
      'persona_file = "../rinko.md"\n',
  })
  try {
    expectIssue(() => loadConfigFromDirectory(dir), 'persona_file', 'identity.toml')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects model tools in the first version', () => {
  const dir = writeConfigs({
    policy: validPolicy.replace('allow = []', 'allow = ["pwsh"]'),
  })
  try {
    expectIssue(() => loadConfigFromDirectory(dir), 'tools.allow', 'policy.toml')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects an enabled shell permission', () => {
  const dir = writeConfigs({
    policy: validPolicy.replace('allow_shell = false', 'allow_shell = true'),
  })
  try {
    expectIssue(
      () => loadConfigFromDirectory(dir),
      'permissions.allow_shell',
      'policy.toml',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects an invalid quiet-hour time', () => {
  const dir = writeConfigs({
    system: validSystem.replace('quiet_hours_start = "00:10"', 'quiet_hours_start = "24:10"'),
  })
  try {
    expectIssue(
      () => loadConfigFromDirectory(dir),
      'time.quiet_hours_start',
      'system.toml',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects an unknown timezone', () => {
  const dir = writeConfigs({
    system: validSystem.replace('timezone = "Asia/Shanghai"', 'timezone = "Mars/Olympus"'),
  })
  try {
    expectIssue(() => loadConfigFromDirectory(dir), 'time.timezone', 'system.toml')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects a stop file with path separators', () => {
  const dir = writeConfigs({
    policy: validPolicy.replace('stop_file = "STOP"', 'stop_file = "../STOP"'),
  })
  try {
    expectIssue(
      () => loadConfigFromDirectory(dir),
      'emergency.stop_file',
      'policy.toml',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects a missing configuration directory', () => {
  const dir = join(tmpdir(), `kanobot-missing-${process.pid}-${Date.now()}`)
  expectIssue(() => loadConfigFromDirectory(dir), '$', dir)
})
