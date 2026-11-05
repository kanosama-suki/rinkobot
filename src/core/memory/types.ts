/**
 * 记忆领域输入契约。
 *
 * 这里的 source 描述证据来源，不描述真假：推断和外部内容也能写入，但
 * 默认只进入候选，不能直接成为可检索的长期记忆。
 */

import type {
  Importance,
  MemorySource,
  Sensitivity,
} from '../state/index.ts'

export interface RememberMemoryInput {
  text: string
  quoteText?: string | null
  kind: string
  source: MemorySource
  confidence?: number
  sensitivity?: Sensitivity
  importance?: Importance
  id?: string
  createdAt?: string
}

export interface CorrectMemoryInput {
  text: string
  quoteText?: string | null
  kind: string
  importance?: Importance
  id?: string
  createdAt?: string
}

export interface MemorySearchOptions {
  limit?: number
  markRecalled?: boolean
}

export class MemoryInputError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'MemoryInputError'
    this.code = code
  }
}
