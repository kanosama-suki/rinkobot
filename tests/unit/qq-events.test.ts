/**
 * QQ OneBot 消息解析的单元测试。
 *
 * 不连接 NapCat；只验证白名单、自我消息、@ 判定和图片引用的平台语义。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseQqMessageEvent,
  shouldAcceptGroupMessage,
} from '../../src/channels/index.ts'

const policy = {
  selfId: '99999',
  privateAllow: ['10001'],
  groupAllow: ['20002'],
  groupRequireMention: true,
  now: () => new Date('2026-11-07T02:00:00.000Z'),
}

test('rejects non-whitelisted, self and non-message events', () => {
  assert.equal(
    parseQqMessageEvent(
      privateEvent({ messageId: 10, userId: 88888, text: '不在白名单' }),
      policy,
    ).kind,
    'ignore',
  )
  assert.equal(
    parseQqMessageEvent(
      privateEvent({ messageId: 11, userId: 99999, text: '自己的消息' }),
      policy,
    ).kind,
    'ignore',
  )
  assert.equal(
    parseQqMessageEvent(
      {
        ...privateEvent({ messageId: 12, text: '通知' }),
        post_type: 'notice',
      },
      policy,
    ).kind,
    'ignore',
  )
  assert.equal(
    parseQqMessageEvent(
      groupEvent({ messageId: 13, groupId: 77777, text: '不在白名单' }),
      policy,
    ).kind,
    'ignore',
  )
})

test('parses private text/images and group @ mentions', () => {
  const privateParsed = parseQqMessageEvent(
    privateEvent({
      messageId: 20,
      text: '看看这个',
      images: ['image.png'],
    }),
    policy,
  )
  assert.equal(privateParsed.kind, 'message')
  if (privateParsed.kind !== 'message') return
  assert.equal(privateParsed.message.targetKey, 'private:10001')
  assert.equal(privateParsed.message.conversationKey, 'qq-private-10001')
  assert.equal(privateParsed.message.text, '看看这个')
  assert.equal(privateParsed.message.images.length, 1)
  assert.equal(privateParsed.message.images[0]?.file, 'image.png')

  const groupParsed = parseQqMessageEvent(
    groupEvent({
      messageId: 21,
      text: '群消息',
      mentioned: true,
    }),
    policy,
  )
  assert.equal(groupParsed.kind, 'message')
  if (groupParsed.kind !== 'message') return
  assert.equal(groupParsed.message.targetKey, 'group:20002')
  assert.equal(groupParsed.message.mentionedBot, true)
  assert.equal(
    shouldAcceptGroupMessage(groupParsed.message, true, false),
    true,
  )
  assert.equal(
    shouldAcceptGroupMessage(groupParsed.message, true, true),
    true,
  )

  const notMentioned = parseQqMessageEvent(
    groupEvent({ messageId: 22, text: '没有 @' }),
    policy,
  )
  assert.equal(notMentioned.kind, 'message')
  if (notMentioned.kind !== 'message') return
  assert.equal(notMentioned.message.mentionedBot, false)
  assert.equal(
    shouldAcceptGroupMessage(notMentioned.message, true, false),
    false,
  )
})

test('parses CQ string mentions and images', () => {
  const parsed = parseQqMessageEvent(
    groupEvent({
      messageId: 30,
      message:
        '[CQ:at,qq=99999] 你好 [CQ:image,file=photo.jpg,file_id=abc]',
      mentioned: false,
    }),
    policy,
  )
  assert.equal(parsed.kind, 'message')
  if (parsed.kind !== 'message') return
  assert.equal(parsed.message.mentionedBot, true)
  assert.match(parsed.message.text, /你好/)
  assert.equal(parsed.message.images[0]?.file, 'photo.jpg')
  assert.equal(parsed.message.images[0]?.fileId, 'abc')
})

interface PrivateEventOptions {
  messageId: number
  userId?: number
  text?: string
  images?: string[]
}

function privateEvent(options: PrivateEventOptions): Record<string, unknown> {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: 99999,
    user_id: options.userId ?? 10001,
    message_id: options.messageId,
    time: 1_791_000_000,
    message: segments(options.text, options.images),
  }
}

interface GroupEventOptions {
  messageId: number
  groupId?: number
  text?: string
  images?: string[]
  mentioned?: boolean
  message?: string
}

function groupEvent(options: GroupEventOptions): Record<string, unknown> {
  return {
    post_type: 'message',
    message_type: 'group',
    self_id: 99999,
    group_id: options.groupId ?? 20002,
    user_id: 30003,
    message_id: options.messageId,
    time: 1_791_000_000,
    message:
      options.message ??
      [
        ...(options.mentioned === true
          ? [{ type: 'at', data: { qq: 99999 } }]
          : []),
        ...segments(options.text, options.images),
      ],
  }
}

function segments(
  text: string | undefined,
  images: string[] | undefined,
): unknown[] {
  return [
    ...(text === undefined ? [] : [{ type: 'text', data: { text } }]),
    ...(images ?? []).map(file => ({
      type: 'image',
      data: { file, file_id: file, file_size: 12 },
    })),
  ]
}
