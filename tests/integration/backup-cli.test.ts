/**
 * 备份管理 CLI 集成验收。
 *
 * 覆盖 list/create/restore、修改后恢复、独立墓碑库不被覆盖、
 * 存活实例拒绝 restore、损坏/旧 schema 备份 fail-closed 且保留原库。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createAppServer } from '../../src/app/index.ts'
import { runBackupCommand } from '../../src/app/backup-command.ts'
import { loadConfigFromDirectory } from '../../src/core/config/index.ts'
import {
  KanobotStorage,
  STORAGE_SCHEMA_VERSION,
} from '../../src/core/storage/index.ts'
import { systemClock } from '../../src/core/state/index.ts'
import {
  memoryFor,
  outboxFor,
} from '../helpers/storage-fixture.ts'

const examplesDir = fileURLToPath(
  new URL('../../config/examples', import.meta.url),
)
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

test('backup list/create/restore keeps tombstones independent', async t => {
  const layout = createLayout(t)
  const loaded = loadConfigFromDirectory(layout.configDir)
  const secret = '备份 CLI 恢复后不应复活的虚构正文-R1-4f21'
  let store = KanobotStorage.openFromConfig(
    loaded,
    layout.dataDir,
    systemClock,
  )
  try {
    store.putBody({
      id: 'body-backup-cli',
      kind: 'chat',
      content: secret,
    })
    store.putMemory(memoryFor('memory-backup-cli', 'body-backup-cli'))
    store.putOutbox(outboxFor('outbox-backup-cli', 'body-backup-cli'))
  } finally {
    store.close()
  }

  const createdCli = await runCli([
    '--config',
    layout.configDir,
    '--data',
    layout.dataDir,
    'create',
  ])
  assert.equal(createdCli.code, 0)
  const created = JSON.parse(createdCli.stdout) as {
    command: string
    backup: { path: string }
  }
  assert.equal(created.command, 'create')
  assert.equal(existsSync(created.backup.path), true)
  const backupPath = created.backup.path

  const listedCli = await runCli([
    '--config',
    layout.configDir,
    '--data',
    layout.dataDir,
    'list',
  ])
  assert.equal(listedCli.code, 0)
  const listed = JSON.parse(listedCli.stdout) as {
    command: string
    backups: Array<{ path: string }>
  }
  assert.equal(listed.command, 'list')
  assert.equal(
    listed.backups.some(backup => backup.path === backupPath),
    true,
  )

  store = KanobotStorage.openFromConfig(loaded, layout.dataDir, systemClock)
  try {
    store.purge({ targetType: 'body', targetId: 'body-backup-cli' })
    store.appendChatMessage({
      conversationId: 'main',
      role: 'user',
      text: '恢复后不应保留的备份之后虚构消息。',
      createdAt: '2026-11-11T00:00:01.000Z',
    })
  } finally {
    store.close()
  }

  const tombstonePath = join(layout.dataDir, 'tombstones.sqlite')
  const tombstoneBefore = await fileHash(tombstonePath)

  const restoredCli = await runCli([
    '--config',
    layout.configDir,
    '--data',
    layout.dataDir,
    'restore',
    '--backup',
    backupPath,
  ])
  assert.equal(restoredCli.code, 0)
  const restored = JSON.parse(restoredCli.stdout) as {
    command: string
    restoredBackupPath: string
  }
  assert.equal(restored.command, 'restore')
  assert.equal(restored.restoredBackupPath, backupPath)
  assert.equal(await fileHash(tombstonePath), tombstoneBefore)
  assert.equal(existsSync(backupPath), true)

  store = KanobotStorage.openFromConfig(loaded, layout.dataDir, systemClock)
  try {
    assert.equal(store.getBody('body-backup-cli'), null)
    assert.equal(store.getMemory('memory-backup-cli'), null)
    assert.equal(store.getOutbox('outbox-backup-cli'), null)
    assert.equal(
      store.listChatMessages('main', 10)
        .some(message => message.text.includes('备份之后虚构消息')),
      false,
    )
  } finally {
    store.close()
  }

  const afterRestoreCli = await runCli([
    '--config',
    layout.configDir,
    '--data',
    layout.dataDir,
    'list',
  ])
  assert.equal(afterRestoreCli.code, 0)
  const parsed = JSON.parse(afterRestoreCli.stdout) as {
    command: string
    backups: Array<{ path: string }>
  }
  assert.equal(parsed.command, 'list')
  assert.equal(parsed.backups.some(backup => backup.path === backupPath), true)
})

test('restore refuses a live instance and leaves it running', async t => {
  const layout = createLayout(t)
  configureMockModel(layout.configDir)
  const loaded = loadConfigFromDirectory(layout.configDir)
  let store = KanobotStorage.openFromConfig(
    loaded,
    layout.dataDir,
    systemClock,
  )
  try {
    store.putBody({
      id: 'body-running-restore',
      kind: 'chat',
      content: '运行中恢复拒绝测试的虚构正文。',
    })
  } finally {
    store.close()
  }
  const created = await runBackupCommand({
    configDir: layout.configDir,
    dataDir: layout.dataDir,
    command: 'create',
  })
  assert.ok(created.backup !== undefined)

  const app = await createAppServer({
    configDir: layout.configDir,
    dataDir: layout.dataDir,
    port: 0,
    logger: { info(): void {}, error(): void {} },
  })
  try {
    await assert.rejects(
      () =>
        runBackupCommand({
          configDir: layout.configDir,
          dataDir: layout.dataDir,
          command: 'restore',
          backup: created.backup?.path,
        }),
      /已被另一个 Rinkobot 实例占用/,
    )
    const health = await fetch(`${app.baseUrl}/kanobot/api/health`)
    assert.equal(health.status, 200)
  } finally {
    await app.close()
  }
})

test('corrupt and mismatched backups fail closed and keep the original database', async t => {
  const layout = createLayout(t)
  const loaded = loadConfigFromDirectory(layout.configDir)
  const store = KanobotStorage.openFromConfig(
    loaded,
    layout.dataDir,
    systemClock,
  )
  try {
    store.putBody({
      id: 'body-original',
      kind: 'chat',
      content: '原库必须保留的虚构正文。',
    })
  } finally {
    store.close()
  }
  const created = await runBackupCommand({
    configDir: layout.configDir,
    dataDir: layout.dataDir,
    command: 'create',
  })
  assert.ok(created.backup !== undefined)

  const databasePath = join(layout.dataDir, 'kanobot.sqlite')
  const originalHash = await fileHash(databasePath)

  const corruptPath = join(
    layout.dataDir,
    'backups',
    'kanobot-backup-20261111T000000000Z-badbeef.sqlite',
  )
  writeFileSync(corruptPath, 'this is not a sqlite database', 'utf8')
  await assert.rejects(
    () =>
      runBackupCommand({
        configDir: layout.configDir,
        dataDir: layout.dataDir,
        command: 'restore',
        backup: corruptPath,
      }),
    /database|integrity|backup|restore/i,
  )
  assert.equal(await fileHash(databasePath), originalHash)
  assert.equal(existsSync(corruptPath), true)

  const mismatchPath = join(
    layout.dataDir,
    'backups',
    'kanobot-backup-20261111T000000001Z-deadbeef.sqlite',
  )
  copyFileSync(created.backup.path, mismatchPath)
  const mismatch = new DatabaseSync(mismatchPath)
  try {
    mismatch.prepare('DELETE FROM schema_migrations WHERE version = ?')
      .run(STORAGE_SCHEMA_VERSION)
    mismatch.prepare(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
    ).run(STORAGE_SCHEMA_VERSION - 1, '2026-11-10T00:00:00.000Z')
    mismatch.exec(`PRAGMA user_version = ${STORAGE_SCHEMA_VERSION - 1}`)
  } finally {
    mismatch.close()
  }
  await assert.rejects(
    () =>
      runBackupCommand({
        configDir: layout.configDir,
        dataDir: layout.dataDir,
        command: 'restore',
        backup: mismatchPath,
      }),
    /schema version|does not match|refusing to restore/i,
  )
  assert.equal(await fileHash(databasePath), originalHash)
  assert.equal(existsSync(mismatchPath), true)

  const divergentPath = join(
    layout.dataDir,
    'backups',
    'kanobot-backup-20261111T000000002Z-feedface.sqlite',
  )
  copyFileSync(created.backup.path, divergentPath)
  const divergent = new DatabaseSync(divergentPath)
  try {
    divergent.prepare('DELETE FROM schema_migrations WHERE version = ?')
      .run(STORAGE_SCHEMA_VERSION)
    divergent.prepare(
      'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
    ).run(STORAGE_SCHEMA_VERSION - 1, '2026-11-10T00:00:00.000Z')
  } finally {
    divergent.close()
  }
  await assert.rejects(
    () =>
      runBackupCommand({
        configDir: layout.configDir,
        dataDir: layout.dataDir,
        command: 'restore',
        backup: divergentPath,
      }),
    /migrations .*does not match|refusing to restore/i,
  )
  assert.equal(await fileHash(databasePath), originalHash)
  assert.equal(existsSync(divergentPath), true)
})

function createLayout(t: TestContext): {
  root: string
  configDir: string
  dataDir: string
} {
  const root = mkdtempSync(join(tmpdir(), 'kanobot-backup-cli-'))
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

async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolveHash, rejectHash) => {
    createReadStream(path)
      .on('data', chunk => hash.update(chunk))
      .once('error', rejectHash)
      .once('end', resolveHash)
  })
  return hash.digest('hex')
}

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

async function runCli(args: string[]): Promise<CliResult> {
  return await new Promise<CliResult>((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      ['scripts/backup.ts', ...args],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', rejectRun)
    child.once('close', code => resolveRun({ code, stdout, stderr }))
  })
}
