/**
 * WebUI 静态结构契约测试。
 *
 * 这里只检查 HTML/JS/CSS 中必须存在的可访问结构、设置入口和敏感字段
 * 约束，不启动浏览器，也不读取运行时配置。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const html = readFileSync(
  fileURLToPath(new URL('../../src/web/assets/index.html', import.meta.url)),
  'utf8',
)
const script = readFileSync(
  fileURLToPath(new URL('../../src/web/assets/app.js', import.meta.url)),
  'utf8',
)
const style = readFileSync(
  fileURLToPath(new URL('../../src/web/assets/app.css', import.meta.url)),
  'utf8',
)

test('the main panel exposes only the four owner tabs', () => {
  assert.match(html, /id="tab-button-status"/)
  assert.match(html, /id="tab-button-initiative"/)
  assert.match(html, /id="tab-button-memory"/)
  assert.match(html, /id="tab-button-audit"/)
  assert.equal(html.includes('id="tab-button-settings"'), false)
  assert.match(html, />主动性 \/ 提醒/)
  assert.match(html, />审计 \/ 事件/)
})

test('settings use an accessible dialog with model and QQ pages', () => {
  assert.match(html, /id="settings-open"[\s\S]*?>[\s\S]*?设置/)
  assert.match(html, /<dialog[\s\S]*?id="settings-dialog"/)
  assert.match(html, /id="settings-dialog-close"/)
  assert.match(html, /data-settings-page="model"/)
  assert.match(html, /data-settings-page="qq"/)
  assert.match(html, /id="settings-page-model"/)
  assert.match(html, /id="settings-page-qq"/)
  assert.match(script, /elements\.settingsDialog\.showModal\(\)/)
  assert.match(script, /elements\.settingsOpen\.focus/)
})

test('the QQ settings page exposes the complete draft fields', () => {
  const ids = [
    'channel-enabled',
    'channel-ws-url',
    'channel-allow-remote',
    'channel-owner-qq',
    'channel-credential-mode',
    'channel-credential-env',
    'channel-credential-secret',
    'channel-private-allow',
    'channel-group-allow',
    'channel-group-require-mention',
    'channel-autonomous-target',
    'channel-connect-timeout',
    'channel-action-timeout',
    'channel-turn-timeout',
    'channel-reconnect-min',
    'channel-reconnect-max',
    'channel-ping-interval',
    'channel-dedupe-retention',
    'channel-coalesce-quiet',
    'channel-coalesce-max-wait',
    'channel-coalesce-max-images',
    'channel-coalesce-max-total-image-bytes',
    'channel-images-download-timeout',
    'channel-outbound-split-chars',
    'channel-outbound-max-parts',
    'channel-outbound-min-interval',
    'channel-limits-max-inbound',
    'channel-limits-max-outbound',
  ]
  for (const id of ids) {
    assert.match(html, new RegExp(`id="${id}"`), id)
  }
  assert.match(
    html,
    /id="channel-credential-secret"[\s\S]*?type="password"[\s\S]*?autocomplete="new-password"/,
  )
  assert.match(
    html,
    /id="channel-credential-secret"[\s\S]*?placeholder="输入后保存"/,
  )
  assert.equal(
    /id="channel-credential-secret"[^>]*value=/.test(html),
    false,
  )
})

test('owner chat and the read-only archive are separate scrollable views', () => {
  assert.match(html, /id="chat-view-owner"/)
  assert.match(html, /id="chat-view-archive"/)
  assert.match(html, /id="archive-conversation"/)
  assert.match(html, /id="archive-refresh"/)
  assert.match(html, /id="history-more"/)
  assert.match(
    html,
    /class="messages-shell"[\s\S]*?id="history-more"[\s\S]*?id="messages"/,
  )
  assert.match(script, /state\.chatView === 'archive'/)
  assert.match(script, /\/kanobot\/api\/timeline/)
  assert.match(script, /\/kanobot\/api\/conversations/)
  assert.match(script, /ownerQqId: parseOwnerQqId/)
  assert.match(script, /elements\.messages\.scrollTop <= 24/)
  assert.match(script, /!hasMore \|\| !atTop \|\| state\.historyLoading/)
  assert.match(style, /\.messages \{[\s\S]*?overflow-y: scroll/)
  assert.match(style, /\.messages-shell \{[\s\S]*?position: relative/)
  assert.match(style, /\.history-more \{[\s\S]*?position: absolute/)
  assert.match(style, /\.chat-view-switch/)
  assert.match(style, /\.message-day/)
  assert.match(style, /\.composer\[hidden\][\s\S]*?display: none/)
})

test('archive conversation names are editable while the owner view stays fixed', () => {
  assert.match(html, /id="archive-rename"/)
  assert.match(html, /id="archive-rename-input"[^>]*maxlength="60"/)
  assert.match(html, /id="archive-rename-save"/)
  assert.match(html, /id="archive-rename-reset"/)
  assert.match(script, /\/kanobot\/api\/conversations\/\$\{encodeURIComponent\(conversationId\)\}/)
  assert.match(script, /conversation\.conversationKind !== 'owner'/)
  assert.match(script, /saveArchiveConversationName\(null\)/)
})

test('the QQ badge and settings panel have independent status surfaces', () => {
  assert.match(html, /id="qq-badge"[\s\S]*?aria-live="polite"/)
  assert.match(html, /id="channel-connection-state"/)
  assert.match(html, /id="owner-qq-warning"/)
  assert.match(script, /settings\/channels\/status/)
  assert.match(script, /ownerQqConfigured !== true/)
  assert.match(script, /status\.ownerQqSaved === true/)
  assert.match(script, /clearInterval\(state\.channelPollTimer\)/)
  assert.match(style, /\.settings-dialog-content[\s\S]*?overflow-y: scroll/)
  assert.match(style, /@media \(max-width: 620px\)[\s\S]*?\.settings-dialog/)
})

test('reminder and secret guidance explains the low-friction flow', () => {
  assert.match(html, /明确委托会自动设置/)
  assert.match(html, /只有时间或内容不清楚时才需要在这里确认/)
  assert.match(html, /token 不会写入 channels\.toml/)
  assert.match(script, /已自动设置/)
  assert.match(script, /新增 .* 条待确认提醒/)
})
