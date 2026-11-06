/**
 * 显式记忆指令的纯函数测试。
 *
 * 只覆盖直接的“记住”表达和不应误判的“记得吗”，不尝试解析复杂语言。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractExplicitMemoryText,
  hasExplicitRememberInstruction,
} from '../../src/core/memory/index.ts'

test('extracts direct remember instructions with a prefix or suffix marker', () => {
  assert.equal(
    extractExplicitMemoryText('记住这个：我对花生过敏。'),
    '我对花生过敏。',
  )
  assert.equal(
    extractExplicitMemoryText('我喜欢窗边的座位，记住这个。'),
    '我喜欢窗边的座位',
  )
  assert.equal(
    extractExplicitMemoryText('请帮我记一下，明天要带伞。'),
    '明天要带伞。',
  )
})

test('does not confuse memory questions with remember instructions', () => {
  assert.equal(hasExplicitRememberInstruction('你还记得我喜欢什么吗？'), false)
  assert.equal(extractExplicitMemoryText('你还记得我喜欢什么吗？'), null)
  assert.equal(extractExplicitMemoryText('记住这个'), null)
})
