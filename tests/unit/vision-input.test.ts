/**
 * 图片输入边界测试。
 *
 * 覆盖 MIME、规范 base64、魔数、大小和数量限制；这里不访问网络，
 * 也不把夹具写入数据库。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ChatInputError,
  EMPTY_IMAGE_MESSAGE_TEXT,
  EMPTY_MULTI_IMAGE_MESSAGE_TEXT,
  parseChatTurnInput,
} from '../../src/core/chat/index.ts'
import {
  VisionInputError,
  validateVisionImages,
} from '../../src/core/vision/index.ts'
import {
  TEST_IMAGES,
  TEST_PNG_BASE64,
  imagePayload,
} from '../helpers/vision-fixtures.ts'

test('accepts canonical PNG, JPEG and WebP payloads with matching magic bytes', () => {
  for (const mimeType of Object.keys(TEST_IMAGES) as Array<
    keyof typeof TEST_IMAGES
  >) {
    const images = validateVisionImages(
      [imagePayload(mimeType)],
      { maxImageBytes: 1024 },
    )
    assert.equal(images.length, 1)
    assert.equal(images[0]?.mimeType, mimeType)
    assert.deepEqual(
      Array.from(images[0]?.bytes ?? []),
      Array.from(TEST_IMAGES[mimeType]),
    )
    assert.equal(
      images[0]?.base64,
      TEST_IMAGES[mimeType].toString('base64'),
    )
  }
})

test('undefined or an empty image array means no image', () => {
  assert.deepEqual(validateVisionImages(undefined, { maxImageBytes: 1024 }), [])
  assert.deepEqual(validateVisionImages([], { maxImageBytes: 1024 }), [])
})

test('rejects malformed image lists and extra image fields', () => {
  expectVisionInputError(
    () => validateVisionImages('not-an-array', { maxImageBytes: 1024 }),
    'invalid_images',
  )
  expectVisionInputError(
    () =>
      validateVisionImages(
        [imagePayload('image/png'), imagePayload('image/png')],
        { maxImageBytes: 1024 },
      ),
    'too_many_images',
  )
  expectVisionInputError(
    () =>
      validateVisionImages(
        [{ ...imagePayload('image/png'), url: 'https://example.invalid' }],
        { maxImageBytes: 1024 },
      ),
    'invalid_image',
  )
})

test('rejects unsupported MIME, empty data and non-canonical base64', () => {
  expectVisionInputError(
    () =>
      validateVisionImages(
        [{ mimeType: 'image/gif', data: TEST_PNG_BASE64 }],
        { maxImageBytes: 1024 },
      ),
    'unsupported_image_type',
  )
  expectVisionInputError(
    () =>
      validateVisionImages(
        [{ mimeType: 'image/png', data: '' }],
        { maxImageBytes: 1024 },
      ),
    'invalid_image',
  )
  expectVisionInputError(
    () =>
      validateVisionImages(
        [{ mimeType: 'image/png', data: 'abc' }],
        { maxImageBytes: 1024 },
      ),
    'invalid_image',
  )
  expectVisionInputError(
    () =>
      validateVisionImages(
        [{ mimeType: 'image/png', data: 'AAAA====' }],
        { maxImageBytes: 1024 },
      ),
    'invalid_image',
  )
})

test('rejects mismatched magic bytes and images over the configured limit', () => {
  expectVisionInputError(
    () =>
      validateVisionImages(
        [{ mimeType: 'image/jpeg', data: TEST_PNG_BASE64 }],
        { maxImageBytes: 1024 },
      ),
    'image_type_mismatch',
  )
  expectVisionInputError(
    () =>
      validateVisionImages(
        [imagePayload('image/png')],
        { maxImageBytes: TEST_IMAGES['image/png'].byteLength - 1 },
      ),
    'image_too_large',
  )
  assert.throws(
    () => validateVisionImages([], { maxImageBytes: 0 }),
    /between 1 and 5242880/,
  )
})

test('chat input keeps string compatibility and uses an explicit image-only placeholder', () => {
  const textTurn = parseChatTurnInput('普通文字消息')
  assert.equal(textTurn.text, '普通文字消息')
  assert.deepEqual(textTurn.images, [])
  assert.equal(textTurn.imageOnly, false)

  const imageOnly = parseChatTurnInput({
    text: '   ',
    images: [imagePayload('image/png')],
  })
  assert.equal(imageOnly.text, EMPTY_IMAGE_MESSAGE_TEXT)
  assert.equal(imageOnly.imageOnly, true)
  assert.equal(imageOnly.images.length, 1)

  const multiImageOnly = parseChatTurnInput(
    {
      images: [imagePayload('image/png'), imagePayload('image/webp')],
    },
    { maxImages: 2 },
  )
  assert.equal(multiImageOnly.text, EMPTY_MULTI_IMAGE_MESSAGE_TEXT)
  assert.equal(multiImageOnly.imageOnly, true)
  assert.equal(multiImageOnly.images.length, 2)

  const captioned = parseChatTurnInput({
    text: '看看这张虚构卡片',
    images: [imagePayload('image/webp')],
  })
  assert.equal(captioned.text, '看看这张虚构卡片')
  assert.equal(captioned.imageOnly, false)
})

test('chat input rejects missing text, unknown fields and invalid image data', () => {
  expectChatInputError(() => parseChatTurnInput({}), 'invalid_message')
  expectChatInputError(
    () =>
      parseChatTurnInput({
        text: '带未知字段',
        extra: true,
      }),
    'invalid_message',
  )
  expectChatInputError(
    () =>
      parseChatTurnInput({
        images: [{ mimeType: 'image/gif', data: TEST_PNG_BASE64 }],
      }),
    'unsupported_image_type',
  )
})

function expectVisionInputError(
  action: () => unknown,
  code: string,
): void {
  assert.throws(
    action,
    (error: unknown) =>
      error instanceof VisionInputError && error.code === code,
  )
}

function expectChatInputError(action: () => unknown, code: string): void {
  assert.throws(
    action,
    (error: unknown) =>
      error instanceof ChatInputError && error.code === code,
  )
}
