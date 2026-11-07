/**
 * 提醒意图纯函数测试：不碰数据库和模型，只验证确定性分类、确认词和
 * 保守去重边界。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyReminderIntent,
  normalizeReminderText,
  reminderReplyIntent,
  reminderTextsEquivalent,
  reminderTimesClose,
} from '../../src/core/initiative/reminder-intent.ts'

test('classifies explicit, ambiguous, and inferred reminder intent', () => {
  assert.equal(
    classifyReminderIntent('明早九点半提醒我洗澡'),
    'explicit',
  )
  assert.equal(
    classifyReminderIntent('一小时后叫我收衣服'),
    'explicit',
  )
  assert.equal(
    classifyReminderIntent('提醒我晚点洗澡'),
    'ambiguous',
  )
  assert.equal(
    classifyReminderIntent('提醒我洗澡'),
    'ambiguous',
  )
  assert.equal(
    classifyReminderIntent('明早有个会'),
    'none',
  )
})

test('recognizes natural confirmation and rejection replies', () => {
  for (const text of ['可以喵', '好呀', '确认', '就这样', '没问题']) {
    assert.equal(reminderReplyIntent(text), 'confirm', text)
  }
  for (const text of ['不要', '不用了喵', '取消吧', '算了']) {
    assert.equal(reminderReplyIntent(text), 'reject', text)
  }
  assert.equal(reminderReplyIntent('可以，明早九点提醒我'), null)
})

test('reminder deduplication keeps different actions apart', () => {
  assert.equal(
    reminderTextsEquivalent(
      '明早九点提醒 kano 洗澡。',
      '提醒我洗澡',
    ),
    true,
  )
  assert.equal(
    reminderTextsEquivalent(
      '提醒 kano 洗澡',
      '提醒 kano 喝水',
    ),
    false,
  )
  assert.equal(
    normalizeReminderText('提醒我明早九点半洗澡'),
    '洗澡',
  )
  assert.equal(
    reminderTimesClose(
      '2026-11-06T01:00:00.000Z',
      '2026-11-06T01:01:00.000Z',
    ),
    true,
  )
  assert.equal(
    reminderTimesClose(
      '2026-11-06T01:00:00.000Z',
      '2026-11-06T01:03:00.000Z',
    ),
    false,
  )
})
