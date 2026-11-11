/**
 * 数据目录单进程所有权测试。
 *
 * 覆盖：第二实例拒绝、释放后可重入、SIGKILL 留下的元数据恢复、
 * PID 被无关活进程复用时不误判、损坏/跨主机锁 fail-closed，以及
 * 本地控制通道的 owner token 校验。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { connect, type Socket } from 'node:net'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import type { TestContext } from 'node:test'

import {
  acquireRuntimeLock,
  queryRuntimeControl,
  readRuntimeLock,
  RuntimeLockError,
  runtimeLockPath,
} from '../../src/app/runtime-lock.ts'

test('a second instance is rejected and release allows a new owner', async t => {
  const dataDir = createDataDir(t)
  const first = await acquireRuntimeLock(dataDir, { version: 'test-1' })
  try {
    const metadata = readRuntimeLock(dataDir)
    assert.equal(metadata?.pid, process.pid)
    assert.equal(metadata?.version, 'test-1')
    assert.equal(metadata?.hostname, hostname())
    assert.match(metadata?.ownerToken ?? '', /^[0-9a-f]{64}$/)
    assert.equal(existsSync(runtimeLockPath(dataDir)), true)

    await assert.rejects(
      () => acquireRuntimeLock(dataDir, { version: 'test-2' }),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeLockError)
        assert.equal(error.code, 'LOCK_HELD')
        assert.match(error.message, /已被另一个 Rinkobot 实例占用/)
        return true
      },
    )
    assert.equal(
      readRuntimeLock(dataDir)?.ownerToken,
      metadata?.ownerToken,
    )
  } finally {
    await first.release()
  }

  assert.equal(existsSync(runtimeLockPath(dataDir)), false)
  const second = await acquireRuntimeLock(dataDir, { version: 'test-3' })
  try {
    assert.equal(readRuntimeLock(dataDir)?.version, 'test-3')
  } finally {
    await second.release()
  }
})

test('stale lock metadata after SIGKILL is recovered without PID checks', async t => {
  const dataDir = createDataDir(t)
  writeLockFile(dataDir, {
    pid: 999_999,
    version: 'crashed',
    ownerToken: 'a'.repeat(64),
  })

  const lock = await acquireRuntimeLock(dataDir, { version: 'recovered' })
  try {
    const metadata = readRuntimeLock(dataDir)
    assert.equal(metadata?.pid, process.pid)
    assert.equal(metadata?.version, 'recovered')
    assert.notEqual(metadata?.ownerToken, 'a'.repeat(64))
  } finally {
    await lock.release()
  }
})

test('a live PID reused by an unrelated process does not own the lock', async t => {
  const dataDir = createDataDir(t)
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    stdio: 'ignore',
  })
  t.after(() => {
    if (!child.killed) child.kill('SIGKILL')
  })
  assert.ok(child.pid !== undefined)

  writeLockFile(dataDir, {
    pid: child.pid,
    version: 'pid-reused',
    ownerToken: 'b'.repeat(64),
  })
  const lock = await acquireRuntimeLock(dataDir, { version: 'real-owner' })
  try {
    assert.equal(readRuntimeLock(dataDir)?.ownerToken, lock.metadata.ownerToken)
    assert.equal(child.exitCode, null)
  } finally {
    await lock.release()
  }
})

test('corrupt or foreign lock metadata fails closed and is preserved', async t => {
  const dataDir = createDataDir(t)
  writeFileSync(runtimeLockPath(dataDir), '{not-json', 'utf8')
  await assert.rejects(
    () => acquireRuntimeLock(dataDir, { version: 'test' }),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeLockError)
      assert.equal(error.code, 'LOCK_INVALID')
      return true
    },
  )
  assert.equal(readFileSync(runtimeLockPath(dataDir), 'utf8'), '{not-json')

  rmSync(runtimeLockPath(dataDir), { force: true })
  writeLockFile(dataDir, {
    pid: process.pid,
    version: 'foreign',
    ownerToken: 'c'.repeat(64),
    hostname: 'foreign-host.invalid',
  })
  await assert.rejects(
    () => acquireRuntimeLock(dataDir, { version: 'test' }),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeLockError)
      assert.equal(error.code, 'LOCK_FOREIGN_HOST')
      return true
    },
  )
  assert.equal(
    readRuntimeLock(dataDir)?.hostname,
    'foreign-host.invalid',
  )
})

test('local control requests require the current owner token', async t => {
  const dataDir = createDataDir(t)
  const lock = await acquireRuntimeLock(dataDir, { version: 'test' })
  try {
    lock.setControlHandler(request => ({
      command: request.command,
    }))
    const response = await queryRuntimeControl(dataDir, { command: 'ping' })
    assert.deepEqual(response, { ok: true, command: 'ping' })

    const rejection = await rawControlRequest(
      lock.controlEndpoint(),
      { command: 'ping', ownerToken: 'd'.repeat(64) },
    )
    assert.equal(rejection.ok, false)
    assert.match(String(rejection.error), /未授权/)
  } finally {
    await lock.release()
  }
})

interface LockFileInput {
  pid: number
  version: string
  ownerToken: string
  hostname?: string
}

function writeLockFile(dataDir: string, input: LockFileInput): void {
  writeFileSync(
    runtimeLockPath(dataDir),
    `${JSON.stringify({
      schemaVersion: 1,
      pid: input.pid,
      startedAt: '2026-11-11T00:00:00.000Z',
      acquiredAt: '2026-11-11T00:00:01.000Z',
      hostname: input.hostname ?? hostname(),
      ownerToken: input.ownerToken,
      version: input.version,
    }, null, 2)}\n`,
    'utf8',
  )
}

function createDataDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'kanobot-lock-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const dataDir = join(dir, 'data')
  mkdirSync(dataDir, { recursive: true })
  return dataDir
}

async function rawControlRequest(
  endpoint: string,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolveRequest, rejectRequest) => {
    const socket: Socket = connect(endpoint)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.setTimeout(3_000, () => {
      socket.destroy()
      rejectRequest(new Error('control request timed out'))
    })
    socket.on('error', rejectRequest)
    socket.on('data', chunk => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      socket.destroy()
      resolveRequest(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>)
    })
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`)
    })
  })
}
