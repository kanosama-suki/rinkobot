/**
 * M3.4 回复风格规则的纯函数测试。
 *
 * 只测试本地文本规则，不调用模型，也不读取任何人格文件。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { checkReplyStyle } from '../../src/core/chat/index.ts'

test('short natural replies pass the style check', () => {
  const result = checkReplyStyle('今天先别把自己逼太紧。')
  assert.equal(result.ok, true)
  assert.deepEqual(result.violations, [])
})

test('banned AI phrasing is reported', () => {
  const result = checkReplyStyle('作为AI，你应该早点休息。')
  assert.equal(result.ok, false)
  assert.ok(result.violations.some(item => item.code === 'banned_phrase'))
})

test('short replies cannot exceed three non-empty lines', () => {
  const result = checkReplyStyle('第一行\n第二行\n第三行\n第四行')
  assert.equal(result.ok, false)
  assert.ok(
    result.violations.some(
      item => item.code === 'short_too_many_lines',
    ),
  )
})

test('long replies enforce punctuation, www and rhythm rules', () => {
  const repeatedLongSentence =
    '这是一段没有四到八字短句而且不断继续下去的长句子，'.repeat(12) +
    '！！www'
  const result = checkReplyStyle(repeatedLongSentence)
  assert.equal(result.ok, false)
  const codes = new Set(result.violations.map(item => item.code))
  assert.ok(codes.has('long_too_many_exclamations'))
  assert.ok(codes.has('long_www'))
  assert.ok(codes.has('long_missing_short_sentence'))
})

test('long reply with one short sentence per paragraph passes', () => {
  const reply =
    '今天有点累。\n' +
    '先坐下来慢慢说。我把声音放轻一点，也把步子放慢一点。\n' +
    '外面还在下雨。我们不急着把话说完，也不急着把情绪整理成答案。\n\n' +
    '你可以先喝口水。\n' +
    '等你想说的时候再继续。我会在这里，不催你，也不替你做决定。\n' +
    '这里只是占位回复。'.repeat(6)
  const result = checkReplyStyle(reply)
  assert.equal(result.ok, true, JSON.stringify(result.violations))
})

test('serious long talk rejects the word 主人 when explicitly marked', () => {
  const result = checkReplyStyle('主人，今天先休息吧。'.repeat(20), {
    serious: true,
  })
  assert.equal(result.ok, false)
  assert.ok(
    result.violations.some(
      item => item.code === 'serious_uses_master',
    ),
  )
})
