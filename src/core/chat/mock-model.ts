/**
 * 明确标记的本地 mock 模型。
 *
 * 它不访问网络、不读取人格文件、不调用真实 API。输出只用于验证网页、
 * SSE、正文持久化和重启恢复；接入真实模型前不得把它误当成正式人格。
 */

import type { ChatModel, ChatModelRequest } from './types.ts'

const MAX_ECHO_CHARS = 160
const CHUNK_CHARS = 24

export const MOCK_MODEL_ID = 'kanobot-mock-v1'

export class MockChatModel implements ChatModel {
  readonly id = MOCK_MODEL_ID
  readonly mode = 'mock'

  async *stream(request: ChatModelRequest): AsyncIterable<string> {
    const latest = [...request.messages]
      .reverse()
      .find(message => message.role === 'user')
    const input = latest?.text ?? ''
    const excerpt = Array.from(input).slice(0, MAX_ECHO_CHARS).join('')
    const reply =
      `[M3 mock] 我收到了：「${excerpt}」。` +
      '当前是本地占位回复，没有连接真实模型；它只用于验证聊天和持久化。'

    const characters = Array.from(reply)
    for (let offset = 0; offset < characters.length; offset += CHUNK_CHARS) {
      if (request.signal.aborted) {
        throw abortError()
      }
      const chunk = characters.slice(offset, offset + CHUNK_CHARS).join('')
      if (chunk !== '') yield chunk
    }
  }
}

function abortError(): Error {
  const error = new Error('chat model stream aborted')
  error.name = 'AbortError'
  return error
}
