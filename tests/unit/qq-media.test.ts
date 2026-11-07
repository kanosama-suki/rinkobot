/**
 * QQ 图片读取边界的单元测试。
 *
 * 使用本地临时文件和假网关；不访问真实 QQ CDN，也不读取正式缓存。
 */

import assert from 'node:assert/strict'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  isAllowedQqImageUrl,
  resolveQqImages,
  QqMediaError,
  type QqGateway,
} from '../../src/channels/index.ts'
import { TEST_IMAGES } from '../helpers/vision-fixtures.ts'

test('allows current NapCat CDN hosts and rejects lookalikes', () => {
  assert.equal(
    isAllowedQqImageUrl(
      'https://multimedia.nt.qq.com.cn/download?fileid=test',
    ),
    true,
  )
  assert.equal(
    isAllowedQqImageUrl('https://gchat.qpic.cn/gchatpic_new/1/2'),
    true,
  )
  assert.equal(
    isAllowedQqImageUrl('https://multimedia.nt.qq.com.cn.evil.invalid/a'),
    false,
  )
  assert.equal(
    isAllowedQqImageUrl('https://evilqq.com.cn/a'),
    false,
  )
  assert.equal(
    isAllowedQqImageUrl('https://user:pass@multimedia.nt.qq.com.cn/a'),
    false,
  )
})

test('rechecks actual bytes after reading a local cache file', async t => {
  const root = mkdtempSync(join(tmpdir(), 'kanobot-qq-media-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'cache.png')
  writeFileSync(path, TEST_IMAGES['image/png'])

  const gateway = {
    getImage: async () => ({
      status: 'ok',
      retcode: 0,
      data: { file: path },
    }),
    getFile: async () => ({ status: 'ok', retcode: 0, data: {} }),
    getMsg: async () => ({ status: 'ok', retcode: 0, data: {} }),
  } as unknown as QqGateway

  await assert.rejects(
    resolveQqImages(
      gateway,
      [{
        file: 'cache.png',
        fileId: 'cache.png',
        messageId: '1',
        declaredBytes: null,
      }],
      {
        maxBytesPerImage: 10,
        maxTotalBytes: 20,
        downloadTimeoutMs: 1_000,
        stat: (async () => ({
          isFile: () => true,
          size: 1,
        })) as never,
        readFile: (async () => Buffer.alloc(11)) as never,
      },
      new AbortController().signal,
    ),
    (error: unknown) =>
      error instanceof QqMediaError && error.code === 'image_too_large',
  )
})

test('bounds downloaded image streams before buffering the whole response', async () => {
  const gateway = {
    getImage: async () => ({ status: 'ok', retcode: 0, data: {} }),
    getFile: async () => ({ status: 'ok', retcode: 0, data: {} }),
    getMsg: async () => ({ status: 'ok', retcode: 0, data: {} }),
  } as unknown as QqGateway
  const fetch = async (): Promise<Response> =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(11))
          controller.close()
        },
      }),
    )

  await assert.rejects(
    resolveQqImages(
      gateway,
      [{
        file: 'https://multimedia.nt.qq.com.cn/test',
        fileId: null,
        messageId: '1',
        declaredBytes: null,
      }],
      {
        maxBytesPerImage: 10,
        maxTotalBytes: 20,
        downloadTimeoutMs: 1_000,
        fetch: fetch as unknown as typeof globalThis.fetch,
      },
      new AbortController().signal,
    ),
    (error: unknown) =>
      error instanceof QqMediaError && error.code === 'image_too_large',
  )
})
