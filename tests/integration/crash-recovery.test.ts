/**
 * 强制终止后的恢复验收。
 *
 * 子进程用 synchronous=FULL 提交事件和快照，输出状态后由父进程 SIGKILL；
 * 重启必须得到相同状态和相同快照字节。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { canonicalJson } from '../../src/core/state/index.ts'
import {
  createWorkspace,
} from '../helpers/storage-fixture.ts'

const projectRoot = fileURLToPath(new URL('../..', import.meta.url))
const writerScript = fileURLToPath(
  new URL('../fixtures/crash-writer.ts', import.meta.url),
)

test('state survives a forced process kill', { timeout: 20_000 }, async () => {
  const ws = createWorkspace(test)
  const child = spawn(process.execPath, [writerScript, ws.root], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    stdout += chunk
  })
  child.stderr.on('data', chunk => {
    stderr += chunk
  })

  try {
    const ready = await waitForReady(child, () => stdout, () => stderr)
    assert.equal(ready.sequence, 2)
    assert.ok(ready.snapshotJson)

    forceKill(child)
    await waitForExit(child)

    const reopened = ws.open()
    try {
      assert.equal(reopened.lastSequence, ready.sequence)
      assert.equal(
        canonicalJson(reopened.currentState()),
        ready.stateJson,
      )
      assert.equal(reopened.latestSnapshotJson(), ready.snapshotJson)
    } finally {
      reopened.close()
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      forceKill(child)
      await waitForExit(child).catch(() => undefined)
    }
  }
})

interface ReadyPayload {
  sequence: number
  state: unknown
  stateJson: string
  snapshotJson: string
}

function waitForReady(
  child: ReturnType<typeof spawn>,
  readStdout: () => string,
  readStderr: () => string,
): Promise<ReadyPayload> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out waiting for writer: ${readStderr()}`))
    }, 10_000)
    const inspect = (): void => {
      const line = readStdout()
        .split(/\r?\n/)
        .find(item => item.startsWith('READY '))
      if (line === undefined) return
      cleanup()
      try {
        resolve(JSON.parse(line.slice('READY '.length)) as ReadyPayload)
      } catch (error) {
        reject(error)
      }
    }
    const onExit = (code: number | null): void => {
      if (code === 0) return
      cleanup()
      reject(
        new Error(
          `writer exited before READY (code ${String(code)}): ${readStderr()}`,
        ),
      )
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      child.stdout.off('data', inspect)
      child.off('exit', onExit)
    }
    child.stdout.on('data', inspect)
    child.on('exit', onExit)
    inspect()
  })
}

function forceKill(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) {
    throw new Error('writer process has no PID')
  }
  // Windows 上 Node 会忽略具体 signal 名，但仍强制结束进程。
  child.kill('SIGKILL')
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('writer did not exit after SIGKILL')),
      5_000,
    )
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}
