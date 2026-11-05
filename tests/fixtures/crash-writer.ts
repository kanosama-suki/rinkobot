/**
 * 崩溃恢复测试的写入子进程。
 *
 * 它提交事件和快照后输出 READY，然后等待父进程强制终止。这个文件只被
 * 测试用 spawn 启动，不进入插件运行时。
 */

import { fileURLToPath } from 'node:url'

import { loadConfigFromDirectory } from '../../src/core/config/index.ts'
import {
  canonicalJson,
  systemClock,
} from '../../src/core/state/index.ts'
import { KanobotStorage } from '../../src/core/storage/index.ts'

const dataDir = process.argv[2]
if (dataDir === undefined) {
  console.error('usage: node tests/fixtures/crash-writer.ts <data-dir>')
  process.exit(2)
}

const configDir = fileURLToPath(new URL('../../config/examples', import.meta.url))
const loaded = loadConfigFromDirectory(configDir)
const store = KanobotStorage.openFromConfig(loaded, dataDir, systemClock)

try {
  const base = Date.now() - 180_000
  store.appendEvent({
    eventId: 'crash-event-1',
    schemaVersion: 1,
    occurredAt: new Date(base).toISOString(),
    source: 'tick',
    type: 'tick',
    payload: { elapsedMinutes: 90, awake: true },
    evidenceRefs: [],
    confidence: 1,
  })
  store.appendEvent({
    eventId: 'crash-event-2',
    schemaVersion: 1,
    occurredAt: new Date(base + 60_000).toISOString(),
    source: 'user',
    type: 'interaction.recorded',
    payload: { kind: 'conversation', intensity: 0.6 },
    evidenceRefs: [],
    confidence: 1,
  })
  store.createSnapshot()

  process.stdout.write(
    `READY ${JSON.stringify({
      sequence: store.lastSequence,
      state: store.currentState(),
      stateJson: canonicalJson(store.currentState()),
      snapshotJson: store.latestSnapshotJson(),
    })}\n`,
  )
} catch (error) {
  console.error(error)
  store.close()
  process.exit(1)
}

// 保持进程存活，让父测试在确认提交完成后使用 SIGKILL 结束它。
setInterval(() => {}, 60_000)
