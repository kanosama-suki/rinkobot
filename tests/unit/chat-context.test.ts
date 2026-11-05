/**
 * 上下文组装器的纯函数测试。
 *
 * 不打开数据库，也不调用模型；用固定时钟和虚构消息验证时间描述、
 * 分块上限、总预算裁剪顺序，以及身份和当前消息不会被预算静默删除。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assembleChatContext,
  ChatContextError,
  DEFAULT_CHAT_CONTEXT_BUDGET,
  type ChatContextBudget,
} from '../../src/core/chat/index.ts'
import type {
  ChatMessageRecord,
  MemorySearchResult,
} from '../../src/core/storage/index.ts'
import type { LifeState } from '../../src/core/state/index.ts'

const NOW = new Date('2026-11-05T00:30:00.000Z')

test('renders local time, weekday, silence duration, and qualitative state', () => {
  const result = assembleChatContext({
    baseSystemPrompt: '身份与优先规则：不可删除。',
    state: lifeState({
      activity: 'reading',
      energy: 0.3,
      socialBattery: 0.3,
      valence: 0.1,
      arousal: 0.5,
    }),
    previousMessages: [],
    currentMessageText: '你在做什么？',
    memories: [],
    now: NOW,
    timezone: 'Asia/Shanghai',
    previousUserMessageAt: '2026-11-04T22:30:00.000Z',
  })

  assert.match(result.systemPrompt, /2026-11-05 星期四 08:30/)
  assert.match(result.systemPrompt, /Asia\/Shanghai，UTC\+08:00/)
  assert.match(result.systemPrompt, /UTC 2026-11-05T00:30:00\.000Z/)
  assert.match(result.systemPrompt, /约 2 小时前/)
  assert.match(result.systemPrompt, /正在看书/)
  assert.match(result.systemPrompt, /有点困/)
  assert.match(result.systemPrompt, /想安静一些/)
  assert.match(result.systemPrompt, /心情平稳/)
  assert.doesNotMatch(
    result.systemPrompt,
    /\b(?:energy|socialBattery|valence|arousal)\b/,
  )
  assert.deepEqual(result.messages, [
    { role: 'user', text: '你在做什么？' },
  ])
  assert.equal(result.memoryIds.length, 0)
})

test('drops the oldest dialogue before touching relevant memories', () => {
  const base = '身份规则。'.repeat(500)
  const previousMessages = [
    chatMessage('m1', 'user', 'OLDEST-USER'),
    chatMessage('m2', 'assistant', 'OLDEST-ASSISTANT'),
    chatMessage('m3', 'user', 'NEWEST-USER'),
    chatMessage('m4', 'assistant', 'NEWEST-ASSISTANT'),
  ]
  const memories = [
    memoryResult('mem-high', 'HIGH-RELEVANCE-MEMORY'),
    memoryResult('mem-low', 'LOW-RELEVANCE-MEMORY'),
  ]
  const input = {
    baseSystemPrompt: base,
    state: lifeState(),
    previousMessages,
    currentMessageText: 'CURRENT-MESSAGE',
    memories,
    now: NOW,
    timezone: 'Asia/Shanghai',
    previousUserMessageAt: '2026-11-04T22:30:00.000Z',
    budget: {
      ...DEFAULT_CHAT_CONTEXT_BUDGET,
      maxPromptChars: 20_000,
    },
  }
  const unconstrained = assembleChatContext(input)
  const result = assembleChatContext({
    ...input,
    budget: {
      ...input.budget,
      maxPromptChars: unconstrained.stats.promptChars - 1,
      maxMessageChars: 100,
    } satisfies ChatContextBudget,
  })

  assert.ok(result.stats.droppedHistoryMessages > 0)
  assert.equal(result.stats.droppedMemoryItems, 0)
  assert.equal(result.memoryIds.length, 2)
  assert.match(result.systemPrompt, /LOW-RELEVANCE-MEMORY/)
  assert.equal(
    result.messages.at(-1)?.text,
    'CURRENT-MESSAGE',
  )
})

test('drops the lowest-relevance memory after history is exhausted', () => {
  const base = '身份规则。'.repeat(500)
  const memories = [
    memoryResult('mem-high', 'HIGH-RELEVANCE-MEMORY'),
    memoryResult('mem-mid', 'MID-RELEVANCE-MEMORY'),
    memoryResult('mem-low', 'LOW-RELEVANCE-MEMORY'),
  ]
  const input = {
    baseSystemPrompt: base,
    state: lifeState(),
    previousMessages: [],
    currentMessageText: 'CURRENT-MESSAGE',
    memories,
    now: NOW,
    timezone: 'Asia/Shanghai',
    previousUserMessageAt: null,
    budget: {
      ...DEFAULT_CHAT_CONTEXT_BUDGET,
      maxPromptChars: 20_000,
    },
  }
  const unconstrained = assembleChatContext(input)
  const result = assembleChatContext({
    ...input,
    budget: {
      ...input.budget,
      maxPromptChars: unconstrained.stats.promptChars - 1,
      maxMessageChars: 100,
    } satisfies ChatContextBudget,
  })

  assert.equal(result.stats.droppedHistoryMessages, 0)
  assert.equal(result.stats.droppedMemoryItems, 1)
  assert.deepEqual(result.memoryIds, ['mem-high', 'mem-mid'])
  assert.match(result.systemPrompt, /MID-RELEVANCE-MEMORY/)
  assert.doesNotMatch(result.systemPrompt, /LOW-RELEVANCE-MEMORY/)
})

test('enforces memory item count and per-item truncation', () => {
  const memories = [
    memoryResult('mem-1', 'A'.repeat(100)),
    memoryResult('mem-2', 'B'.repeat(100)),
    memoryResult('mem-3', 'C'.repeat(100)),
  ]
  const result = assembleChatContext({
    baseSystemPrompt: '身份规则。',
    state: lifeState(),
    previousMessages: [],
    currentMessageText: 'CURRENT-MESSAGE',
    memories,
    now: NOW,
    timezone: 'Asia/Shanghai',
    previousUserMessageAt: null,
    budget: {
      ...DEFAULT_CHAT_CONTEXT_BUDGET,
      maxMemoryItems: 2,
      maxMemoryItemChars: 20,
    },
  })

  assert.equal(result.stats.memoryItemCount, 2)
  assert.equal(result.stats.droppedMemoryItems, 1)
  assert.deepEqual(result.memoryIds, ['mem-1', 'mem-2'])
  assert.match(result.systemPrompt, /A{19}…/)
  assert.doesNotMatch(result.systemPrompt, /C{20}/)
})

test('supports disabling recent history without duplicating the current message', () => {
  const result = assembleChatContext({
    baseSystemPrompt: '身份规则。',
    state: lifeState(),
    previousMessages: [
      chatMessage('m1', 'user', '不该进入提示词的旧消息'),
      chatMessage('m2', 'assistant', '不该进入提示词的旧回复'),
    ],
    currentMessageText: 'CURRENT-MESSAGE',
    memories: [],
    now: NOW,
    timezone: 'Asia/Shanghai',
    previousUserMessageAt: '2026-11-04T22:30:00.000Z',
    budget: {
      ...DEFAULT_CHAT_CONTEXT_BUDGET,
      maxHistoryMessages: 0,
    },
  })

  assert.deepEqual(result.messages, [
    { role: 'user', text: 'CURRENT-MESSAGE' },
  ])
  assert.equal(result.stats.historyMessageCount, 0)
  assert.equal(result.stats.droppedHistoryMessages, 2)
})

test('fails closed instead of truncating protected base rules or current message', () => {
  assert.throws(
    () =>
      assembleChatContext({
        baseSystemPrompt: '不可删除的身份规则。'.repeat(400),
        state: lifeState(),
        previousMessages: [],
        currentMessageText: 'CURRENT-MESSAGE',
        memories: [],
        now: NOW,
        timezone: 'Asia/Shanghai',
        previousUserMessageAt: null,
        budget: {
          ...DEFAULT_CHAT_CONTEXT_BUDGET,
          maxPromptChars: 2_000,
          maxMessageChars: 100,
        },
      }),
    (error: unknown) =>
      error instanceof ChatContextError &&
      error.code === 'context_budget_exceeded',
  )
})

test('rejects an over-budget current message and an unknown timezone', () => {
  assert.throws(
    () =>
      assembleChatContext({
        baseSystemPrompt: '身份规则。',
        state: lifeState(),
        previousMessages: [],
        currentMessageText: 'X'.repeat(51),
        memories: [],
        now: NOW,
        timezone: 'Asia/Shanghai',
        previousUserMessageAt: null,
        budget: {
          ...DEFAULT_CHAT_CONTEXT_BUDGET,
          maxMessageChars: 50,
        },
      }),
    (error: unknown) =>
      error instanceof ChatContextError &&
      error.code === 'context_budget_exceeded',
  )

  assert.throws(
    () =>
      assembleChatContext({
        baseSystemPrompt: '身份规则。',
        state: lifeState(),
        previousMessages: [],
        currentMessageText: 'CURRENT-MESSAGE',
        memories: [],
        now: NOW,
        timezone: 'Mars/Olympus',
        previousUserMessageAt: null,
      }),
    (error: unknown) =>
      error instanceof ChatContextError &&
      error.code === 'invalid_timezone',
  )
})

function lifeState(overrides: Partial<LifeState> & {
  energy?: number
  socialBattery?: number
  valence?: number
  arousal?: number
} = {}): LifeState {
  return {
    activity: overrides.activity ?? 'idle',
    affect: {
      valence: overrides.valence ?? 0.1,
      arousal: overrides.arousal ?? 0.3,
    },
    energy: overrides.energy ?? 0.7,
    socialBattery: overrides.socialBattery ?? 0.7,
    relationship: {
      closeness: 0.6,
      hurt: 0,
      repairNeeded: false,
    },
    attention: {
      busyUntil: null,
    },
    commitments: [],
  }
}

function chatMessage(
  id: string,
  role: 'user' | 'assistant',
  text: string,
): ChatMessageRecord {
  return {
    id,
    bodyId: `body-${id}`,
    conversationId: 'main',
    role,
    text,
    createdAt: '2026-11-04T22:30:00.000Z',
  }
}

function memoryResult(id: string, text: string): MemorySearchResult {
  return {
    memory: {
      schemaVersion: 1,
      id,
      kind: 'preference',
      contentRef: `body-${id}`,
      quoteRef: null,
      source: 'user_stated',
      createdAt: '2026-11-01T00:00:00.000Z',
      confidence: 1,
      sensitivity: 'normal',
      importance: 'normal',
      lastRecalledAt: null,
      status: 'active',
      replacedBy: null,
      deletedAt: null,
      purgeAfter: null,
    },
    text,
    rank: 0,
  }
}
