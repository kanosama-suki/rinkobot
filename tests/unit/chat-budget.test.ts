/**
 * 共享模型预算的单元测试。
 *
 * 预算对象不依赖数据库或计时器；这里验证并发槽、每日预留和释放的
 * 原子语义，跨聊天服务的行为由 chat-limits 集成测试覆盖。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { ChatModelBudget } from '../../src/core/chat/index.ts'

test('a shared budget rejects concurrency and daily over-reservation', () => {
  const budget = new ChatModelBudget({
    maxConcurrentModelCalls: 1,
    dailyModelCallLimit: 4,
  })

  assert.equal(budget.beginTurn(2, 0), null)
  assert.equal(budget.beginTurn(1, 0), 'model_capacity_reached')
  assert.equal(budget.reserveAdditionalCall(0), true)
  assert.equal(budget.reserveAdditionalCall(2), false)
  assert.deepEqual(budget.snapshot(), {
    activeModelCalls: 1,
    reservedModelCalls: 3,
    maxConcurrentModelCalls: 1,
    dailyModelCallLimit: 4,
  })

  budget.beginReservedCall()
  budget.beginReservedCall()
  budget.beginReservedCall()
  budget.finishTurn(0)
  assert.deepEqual(budget.snapshot(), {
    activeModelCalls: 0,
    reservedModelCalls: 0,
    maxConcurrentModelCalls: 1,
    dailyModelCallLimit: 4,
  })
})

test('a failed reservation does not consume budget', () => {
  const budget = new ChatModelBudget({
    maxConcurrentModelCalls: 2,
    dailyModelCallLimit: 2,
  })

  assert.equal(
    budget.beginTurn(3, 0),
    'daily_model_call_limit_reached',
  )
  assert.deepEqual(budget.snapshot(), {
    activeModelCalls: 0,
    reservedModelCalls: 0,
    maxConcurrentModelCalls: 2,
    dailyModelCallLimit: 2,
  })
})
