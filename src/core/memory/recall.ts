/**
 * 记忆召回的问题意图、主题匹配和确定性相关性评分。
 *
 * 目标不是“多找几条”，而是先判断当前问题是否真的需要某条记忆：
 * - 问“你记得……”属于明确回忆请求；
 * - 问“你喜欢……”是在问燐子自己的偏好，不能拿 kano 的偏好替代回答；
 * - 普通聊天只有主题直接命中时才允许注入记忆；
 * - 重要度只用于相关度相同后的排序，不能压过相关性。
 */

import type { MemoryRecord } from '../state/index.ts'
import {
  listMemorySearchTokens,
  type MemorySearchResult,
} from '../storage/index.ts'

const RECALL_TOPIC_STOPWORDS = new Set([
  '还', '也', '又', '再', '就', '都', '很', '太', '更', '比较',
  '记得', '记不记得', '还记得', '记得吗', '知道', '想起',
  '以前', '之前', '上次', '曾经', '过去', '当时',
  '说过', '提过', '告诉过', '讲过', '提起过',
  '喜欢', '爱', '讨厌', '最爱', '偏好', '爱好', '兴趣', '感兴趣',
  '觉得', '认为', '想要', '希望',
  '做', '干', '干嘛', '干什么',
  '最近', '现在', '今天', '昨天', '明天', '刚才', '刚刚',
  '平时', '一般', '通常', '常常', '经常', '有点', '一点',
  '事情', '东西', '这个', '那个', '一下', '点', '些', '儿',
])

const TOPIC_AUXILIARY_PREFIX =
  /^(?:想|要|会|能|去|来|在|有|做)(.+)$/u

const MEMORY_QUERY_PATTERN =
  /(?:记不记得|还记得|记得|以前|之前|上次|曾经|说过|提过|告诉过|提起过|我说过)/u
const ASSISTANT_SUBJECT_PATTERN =
  /(?:^|[，。！？,.!?\s])(?:你|妳)(?:的(?:爱好|兴趣|偏好|生活|日常)|平时|一般|最近|现在|通常|正在|喜欢|爱|讨厌|会|在玩|玩|看|读|做|有没有|是不是)/u

const SHARED_MEMORY_KINDS = new Set([
  'shared_experience',
  'relationship',
  'relationship_event',
  'conflict',
  'repair',
  'care',
  'promise',
  'commitment',
])

export type MemoryQueryIntent =
  | 'memory_check'
  | 'preference_question'
  | 'general'

export type MemoryQuerySubject = 'owner' | 'assistant' | 'unknown'

export interface MemoryQueryPlan {
  intent: MemoryQueryIntent
  subject: MemoryQuerySubject
  asksAboutMemory: boolean
  topics: string[]
}

export interface MemoryRelevance {
  score: number
  matchedTopics: string[]
  rejectedReason:
    | 'no_topic'
    | 'assistant_subject'
    | 'below_threshold'
    | null
}

export interface MemoryRecallResult extends MemorySearchResult {
  relevance: number
  matchedTopics: string[]
}

export function analyzeMemoryQuery(text: string): MemoryQueryPlan {
  const asksAboutMemory = MEMORY_QUERY_PATTERN.test(text)
  const asksAboutOwner =
    /(?:^|[，。！？,.!?\s])我(?:的|喜欢|爱|讨厌|最近|现在|平时|通常)/u
      .test(text)
  const asksAboutAssistant =
    !asksAboutMemory && !asksAboutOwner && ASSISTANT_SUBJECT_PATTERN.test(text)
  const topics = listMemorySearchTokens(text)
    .map(token => token.toLocaleLowerCase('zh-CN'))
    .map(normalizeRecallTopic)
    .filter((token): token is string => token !== null)
    .filter(token => !RECALL_TOPIC_STOPWORDS.has(token))
    .filter((token, index, all) => all.indexOf(token) === index)

  const intent: MemoryQueryIntent = asksAboutMemory
    ? 'memory_check'
    : /(?:喜欢|爱|讨厌|最爱|偏好|爱好|兴趣|感兴趣)/u.test(text)
      ? 'preference_question'
      : 'general'

  return {
    intent,
    subject: asksAboutAssistant
      ? 'assistant'
      : asksAboutOwner
        ? 'owner'
        : 'unknown',
    asksAboutMemory,
    topics,
  }
}

function normalizeRecallTopic(token: string): string | null {
  if (RECALL_TOPIC_STOPWORDS.has(token)) return null
  const auxiliary = TOPIC_AUXILIARY_PREFIX.exec(token)
  if (auxiliary?.[1] !== undefined) {
    const content = auxiliary[1].trim()
    if (content === '' || RECALL_TOPIC_STOPWORDS.has(content)) return null
    return content
  }
  return token
}

export function scoreMemoryRelevance(
  plan: MemoryQueryPlan,
  result: MemorySearchResult,
): MemoryRelevance {
  if (plan.topics.length === 0) {
    return {
      score: 0,
      matchedTopics: [],
      rejectedReason: 'no_topic',
    }
  }
  if (
    plan.subject === 'assistant' &&
    !plan.asksAboutMemory &&
    !isSharedMemory(result.memory)
  ) {
    return {
      score: 0,
      matchedTopics: [],
      rejectedReason: 'assistant_subject',
    }
  }

  const text = result.text.toLocaleLowerCase('zh-CN')
  const matchedTopics = plan.topics.filter(topic =>
    containsToken(text, topic))
  return {
    score: matchedTopics.length / plan.topics.length,
    matchedTopics,
    rejectedReason: null,
  }
}

/**
 * 同等相关度下：
 * 1. 重要内容优先；
 * 2. 最近刚被提过的内容靠后，降低同一件事被反复复述的概率；
 * 3. 再按全文检索名次稳定排序。
 */
export function compareMemoryRecallResults(
  left: MemoryRecallResult,
  right: MemoryRecallResult,
): number {
  return (
    right.relevance - left.relevance ||
    importanceRank(left.memory) - importanceRank(right.memory) ||
    recallFreshnessRank(left.memory) - recallFreshnessRank(right.memory) ||
    compareRecallTime(left.memory, right.memory) ||
    left.rank - right.rank ||
    left.memory.id.localeCompare(right.memory.id)
  )
}

function isSharedMemory(memory: MemoryRecord): boolean {
  return SHARED_MEMORY_KINDS.has(memory.kind)
}

function containsToken(text: string, token: string): boolean {
  if (/^[a-z0-9][a-z0-9_.:-]*$/i.test(token)) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:$|[^a-z0-9_])`, 'i')
      .test(text)
  }
  return text.includes(token)
}

function importanceRank(memory: MemoryRecord): number {
  switch (memory.importance) {
    case 'permanent':
      return 0
    case 'important':
      return 1
    default:
      return 2
  }
}

function recallFreshnessRank(memory: MemoryRecord): number {
  return memory.lastRecalledAt === null ? 0 : 1
}

function compareRecallTime(
  left: MemoryRecord,
  right: MemoryRecord,
): number {
  if (left.lastRecalledAt === right.lastRecalledAt) return 0
  if (left.lastRecalledAt === null) return -1
  if (right.lastRecalledAt === null) return 1
  return left.lastRecalledAt.localeCompare(right.lastRecalledAt)
}
