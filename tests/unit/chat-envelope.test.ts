/**
 * 对话信封的纯函数和流式提取测试。
 *
 * 不访问数据库或模型；重点验证转义、分片、字段顺序和可降级字段。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ChatEnvelopeError,
  ReplyEnvelopeStream,
  parseChatEnvelope,
} from '../../src/core/chat/index.ts'
import { chatEnvelopeText } from '../helpers/chat-envelope.ts'

test('streaming reply survives JSON escapes and arbitrary code-unit splits', () => {
  const reply = '第一行\n第二行“引号”和反斜杠 \\ 以及 😊。'
  const raw = chatEnvelopeText(reply)
  const stream = new ReplyEnvelopeStream()
  let visible = ''
  // 逐 UTF-16 code unit 喂入，专门覆盖 emoji 代理对跨 chunk 的情况。
  for (let index = 0; index < raw.length; index += 1) {
    visible += stream.push(raw[index])
  }
  assert.equal(visible, reply)
  assert.equal(stream.completeReply(), reply)
})

test('streaming finds reply even when it is not the first field', () => {
  const reply = '后置字段也可以。'
  const raw = JSON.stringify({
    schemaVersion: 1,
    memoryCandidates: [{ text: '占位', quote: '占位' }],
    reply,
    appraisal: { valence: 0.1, arousal: 0.2, confidence: 0.5 },
    commitments: [],
  })
  const stream = new ReplyEnvelopeStream()
  let visible = ''
  for (let index = 0; index < raw.length; index += 5) {
    visible += stream.push(raw.slice(index, index + 5))
  }
  assert.equal(visible, reply)
})

test('a fake reply key inside the real reply is ignored', () => {
  const reply = '正文里写着 "reply": "假值" 但这不是字段。'
  const raw = chatEnvelopeText(reply)
  const stream = new ReplyEnvelopeStream()
  let visible = ''
  for (const chunk of raw.match(/.{1,9}/gsu) ?? []) {
    visible += stream.push(chunk)
  }
  assert.equal(visible, reply)
  assert.equal(parseChatEnvelope(raw, '虚构输入').reply, reply)
})

test('markdown fence around the envelope is tolerated', () => {
  const raw = '```json\n' + chatEnvelopeText('围栏外的正文。') + '\n```'
  const parsed = parseChatEnvelope(raw, '虚构输入')
  assert.equal(parsed.reply, '围栏外的正文。')
})

test('invalid appraisal is dropped without dropping the reply', () => {
  const raw = chatEnvelopeText('正文仍然有效。', {
    appraisal: {
      valence: 2,
      arousal: 0.2,
      confidence: 0.8,
    },
  })
  const parsed = parseChatEnvelope(raw, '虚构输入')
  assert.equal(parsed.reply, '正文仍然有效。')
  assert.equal(parsed.appraisal, null)
  assert.ok(parsed.issues.includes('appraisal_invalid'))
})

test('invalid memory candidates are skipped and valid ones retained', () => {
  const reply = '好。'
  const userText = '我喜欢雨天，也说过咖啡。'
  const raw = JSON.stringify({
    schemaVersion: 1,
    reply,
    memoryCandidates: [
      {
        text: 'kano 喜欢雨天。',
        quote: '我喜欢雨天',
        kind: 'preference',
        source: 'user_stated',
        sensitivity: 'normal',
        importance: 'normal',
        confidence: 0.9,
      },
      {
        text: '引用不存在。',
        quote: '这句话不在对话里',
        kind: 'preference',
        source: 'user_stated',
        sensitivity: 'normal',
        importance: 'normal',
        confidence: 0.9,
      },
    ],
    appraisal: { valence: 0.1, arousal: 0.2, confidence: 0.5 },
    commitments: [],
  })
  const parsed = parseChatEnvelope(raw, userText)
  assert.equal(parsed.memoryCandidates.length, 1)
  assert.equal(parsed.skippedMemoryCandidates, 1)
  assert.ok(parsed.issues.includes('memory_candidates_skipped'))
})

test('commitment dueAt is normalized and invalid commitments are skipped', () => {
  const raw = chatEnvelopeText('好。', {
    commitments: [
      {
        text: '明早提醒带伞。',
        dueAt: '2026-11-06T23:00:00+08:00',
      },
      {
        text: '',
        dueAt: null,
      },
    ],
  })
  const parsed = parseChatEnvelope(raw, '虚构输入')
  assert.equal(parsed.commitments.length, 1)
  assert.equal(parsed.commitments[0]?.dueAt, '2026-11-06T15:00:00.000Z')
  assert.equal(parsed.skippedCommitments, 1)
  assert.ok(parsed.issues.includes('commitments_skipped'))
})

test('missing schemaVersion or reply is a fatal envelope error', () => {
  assert.throws(
    () => parseChatEnvelope(JSON.stringify({ reply: '没有版本。' }), '输入'),
    (error: unknown) =>
      error instanceof ChatEnvelopeError &&
      error.code === 'chat_envelope_invalid_shape',
  )
  assert.throws(
    () => parseChatEnvelope(JSON.stringify({
      schemaVersion: 1,
      reply: '',
      memoryCandidates: [],
      appraisal: { valence: 0, arousal: 0, confidence: 0 },
      commitments: [],
    }), '输入'),
    (error: unknown) =>
      error instanceof ChatEnvelopeError &&
      error.code === 'chat_envelope_invalid_shape',
  )
})

test('truncated reply cannot be used as a fallback', () => {
  const stream = new ReplyEnvelopeStream()
  stream.push('{"schemaVersion":1,"reply":"还没有结束')
  assert.equal(stream.completeReply(), null)
  assert.throws(
    () => parseChatEnvelope(stream.rawOutput, '输入'),
    (error: unknown) =>
      error instanceof ChatEnvelopeError &&
      error.code === 'chat_envelope_invalid_json',
  )
})
