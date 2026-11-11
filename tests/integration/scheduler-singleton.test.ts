/**
 * 单调度循环边界：start() 重复调用必须保持幂等；dispose 后必须报告
 * stopped。unref timer 不会出现在 getActiveResourcesInfo 中，因此这里
 * 不伪称通过资源计数证明“只有一个 timer”；进程级唯一性由 R1 的数据
 * 目录 IPC 锁和第二实例测试保证。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { InitiativeScheduler } from '../../src/core/initiative/index.ts'

test('scheduler start/dispose status is idempotent', async () => {
  const scheduler = new InitiativeScheduler({
    service: {
      async tick() {
        return {
          status: 'completed' as const,
          deliveredOutbox: 0,
          proactiveSent: false,
          planGenerated: false,
          reviewCompleted: false,
        }
      },
    },
    intervalMs: 10_000,
    logger: { info(): void {}, error(): void {} },
  })
  scheduler.start()
  scheduler.start()
  assert.equal(scheduler.isRunning(), true)

  await scheduler.dispose()
  await scheduler.dispose()
  assert.equal(scheduler.isRunning(), false)
  assert.equal(scheduler.disposeSync(), true)
})
