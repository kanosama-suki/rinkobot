/**
 * M4 记忆质量门控回归测试。
 *
 * 用真实 SQLite/FTS 索引验证“问题意图 → 主题覆盖 → 相关度门槛”的链路，
 * 不调用模型，也不依赖真实人格或外部服务。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { KanobotMemoryService } from '../../src/core/memory/index.ts'
import { createWorkspace } from '../helpers/storage-fixture.ts'

test('a game question cannot be hijacked by an unrelated permanent tea memory', () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    const tea = memory.remember({
      text: 'kano 喜欢喝茶，尤其喜欢乌龙茶。',
      kind: 'preference',
      source: 'user_stated',
      importance: 'permanent',
    })
    const game = memory.remember({
      text: 'kano 喜欢玩策略游戏和单人游戏。',
      kind: 'preference',
      source: 'user_stated',
      importance: 'important',
    })

    const recalled = memory.recall('我喜欢玩什么游戏？', 5, {
      markRecalled: false,
    })
    assert.deepEqual(recalled.map(result => result.memory.id), [game.id])
    assert.equal(recalled[0]?.relevance, 1)
    assert.ok(recalled.every(result => result.memory.id !== tea.id))
  } finally {
    store.close()
  }
})

test('asking about the assistant does not inject owner preferences', () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    memory.remember({
      text: 'kano 喜欢玩策略游戏和单人游戏。',
      kind: 'preference',
      source: 'user_stated',
      importance: 'permanent',
    })

    assert.deepEqual(
      memory.recall('你喜欢玩什么游戏？', 5, { markRecalled: false }),
      [],
    )
  } finally {
    store.close()
  }
})

test('an explicit memory question can retrieve the matching old preference', () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    const tea = memory.remember({
      text: 'kano 喜欢喝茶，尤其喜欢乌龙茶。',
      kind: 'preference',
      source: 'user_stated',
      importance: 'important',
    })

    const recalled = memory.recall(
      '你还记得我以前说过喜欢喝什么吗？',
      5,
      { markRecalled: false },
    )
    assert.equal(recalled[0]?.memory.id, tea.id)
    assert.equal(recalled[0]?.relevance, 1)
  } finally {
    store.close()
  }
})

test('generic activity questions recall no memory when there is no topic', () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock)
    memory.remember({
      text: 'kano 喜欢窗边的座位。',
      kind: 'preference',
      source: 'user_stated',
      importance: 'permanent',
    })

    assert.deepEqual(
      memory.recall('你现在在做什么？', 5, { markRecalled: false }),
      [],
    )
  } finally {
    store.close()
  }
})

test('the relevance threshold is configurable and rejects partial matches', () => {
  const ws = createWorkspace(test)
  const store = ws.open()
  try {
    const memory = new KanobotMemoryService(store, ws.clock, {
      recall: {
        minRelevance: 1,
        candidateLimit: 24,
      },
    })
    memory.remember({
      text: 'kano 喜欢玩策略游戏。',
      kind: 'preference',
      source: 'user_stated',
      importance: 'important',
    })

    // 只命中“游戏”，没有命中“玩”，因此在严格门槛下不注入。
    assert.deepEqual(
      memory.recall('周末一起玩游戏吗？', 5, { markRecalled: false }),
      [],
    )
  } finally {
    store.close()
  }
})
