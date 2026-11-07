/**
 * DSH `ctx.llm` 的最小结构接口。
 *
 * 陪伴核心不能导入 DSH；插件入口把宿主对象按这个窄接口注入 provider 工厂。
 * 这里的字段与 DSH 0.2.1-rc.5 的公开类型保持一致，但由本项目自己声明，
 * 避免升级宿主时全局扩散类型依赖。
 */

export type DshInputModality = 'text' | 'image'

export interface DshProviderInfo {
  id: string
  name: string
}

export interface DshResolvedModelInfo {
  provider: string
  id: string
  name: string
  inputModalities?: readonly DshInputModality[]
  defaultMaxTokens?: number
  reasoning?: {
    efforts: readonly {
      id: string
      name: string
    }[]
    defaultEffort?: string
  }
  context?: {
    contextWindow: number
  }
}

export interface DshTextBlock {
  type: 'text'
  text: string
}

export interface DshRequestUserMessage {
  role: 'user'
  content: readonly DshTextBlock[]
}

export interface DshRequestAssistantMessage {
  role: 'assistant'
  id: string
  content: readonly DshTextBlock[]
  source: {
    kind: 'model'
    provider: string
    model: string
  }
}

export type DshRequestMessage =
  | DshRequestUserMessage
  | DshRequestAssistantMessage

export interface DshGenerateOptions {
  provider: string
  model: string
  system?: string
  messages: DshRequestMessage[]
  maxTokens?: number
  reasoningEffort?: string
  temperature?: number
  stop?: string[]
  signal?: AbortSignal
}

export type DshStreamChunk =
  | {
      type: 'block-start'
      index: number
      blockType: string
    }
  | {
      type: 'text-delta'
      index: number
      text: string
    }
  | {
      type: 'reasoning-delta'
      index: number
      text: string
    }
  | {
      type: 'block-end'
      index: number
      block: {
        type: string
        text?: string
      }
    }
  | {
      type: 'usage'
      usage: {
        inputTokens: number
        outputTokens: number
        totalTokens?: number
        cacheReadTokens?: number
        cacheWriteTokens?: number
        reasoningTokens?: number
      }
    }
  | {
      type: 'finish'
      reason:
        | { kind: 'stop' }
        | { kind: 'max-tokens' }
        | { kind: 'tool-calls' }
        | {
            kind: 'error' | 'aborted'
            failure: {
              code: string
              message?: string
              status?: number
            }
          }
    }
  | {
      type: string
      [key: string]: unknown
    }

export interface DshPreparedCall {
  model: DshResolvedModelInfo
  stream(options: DshGenerateOptions): AsyncIterable<DshStreamChunk>
}

export interface DshLlmBridge {
  listProviders(): DshProviderInfo[]
  listModels(provider: string): Promise<readonly DshResolvedModelInfo[]>
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<DshResolvedModelInfo>
  prepareCall(
    config: {
      provider: string
      model: string
      maxTokens?: number
      reasoningEffort?: string
    },
    signal?: AbortSignal,
  ): Promise<DshPreparedCall>
  stream(options: DshGenerateOptions): AsyncIterable<DshStreamChunk>
}
