/**
 * QQ 目标与文本拆条的单元测试。
 *
 * 验证出站目标必须落在白名单，以及拆分按 Unicode 码点而不是 UTF-16
 * code unit 计算，避免 emoji 被切成半个字符。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseOutboxTarget,
  splitQqText,
  targetAllowed,
  QqFormatError,
} from '../../src/channels/index.ts'

test('only configured QQ targets are allowed', () => {
  assert.equal(
    targetAllowed(
      { kind: 'private', id: '10001' },
      ['10001'],
      ['20002'],
    ),
    true,
  )
  assert.equal(
    targetAllowed(
      { kind: 'group', id: '20002' },
      ['10001'],
      ['20002'],
    ),
    true,
  )
  assert.equal(
    targetAllowed(
      { kind: 'private', id: '88888' },
      ['10001'],
      ['20002'],
    ),
    false,
  )
  assert.deepEqual(parseOutboxTarget('qq:private:10001'), {
    kind: 'private',
    id: '10001',
  })
  assert.equal(parseOutboxTarget('qq:private:abc'), null)
})

test('splits by code points and refuses to exceed the part limit', () => {
  const parts = splitQqText('😀你好呀世界', 3, 3)
  assert.deepEqual(parts, ['😀你好', '呀世界'])

  assert.throws(
    () => splitQqText('abcdef', 2, 2),
    (error: unknown) =>
      error instanceof QqFormatError && error.code === 'too_many_parts',
  )
  assert.throws(
    () => splitQqText('   ', 10, 1),
    (error: unknown) =>
      error instanceof QqFormatError && error.code === 'empty_reply',
  )
})
