/**
 * M3.1 测试聊天页面。
 *
 * 所有消息都通过 textContent 渲染；SSE 仅接受本页面固定的聊天流格式。
 */

const elements = {
  messages: document.querySelector('#messages'),
  empty: document.querySelector('#empty-state'),
  notice: document.querySelector('#notice'),
  form: document.querySelector('#composer'),
  input: document.querySelector('#message-input'),
  send: document.querySelector('#send-button'),
  modelBadge: document.querySelector('#model-badge'),
  statusModel: document.querySelector('#status-model'),
  statusProvider: document.querySelector('#status-provider'),
  statusCalls: document.querySelector('#status-calls'),
  statusTokens: document.querySelector('#status-tokens'),
  statusCache: document.querySelector('#status-cache'),
  statusCost: document.querySelector('#status-cost'),
  statusLastCall: document.querySelector('#status-last-call'),
  statusMessages: document.querySelector('#status-messages'),
  statusEvents: document.querySelector('#status-events'),
  emptyNote: document.querySelector('#empty-note'),
}

const state = {
  sending: false,
  messageIds: new Set(),
}

void initialize()

async function initialize() {
  try {
    const view = await fetchConversation()
    renderConversation(view)
    focusComposer()
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error))
  }
}

async function fetchConversation() {
  const response = await fetch('/kanobot/api/conversation', {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(await responseMessage(response, '读取聊天记录失败'))
  }
  return response.json()
}

function renderConversation(view) {
  elements.messages.replaceChildren()
  state.messageIds.clear()
  applyModel(view.model)
  applyState(view.state)
  applyUsage(view.modelUsage)
  for (const message of view.messages) {
    appendMessage(message.role, message.text, message.createdAt, message.id)
  }
  updateEmptyState()
}

elements.form.addEventListener('submit', event => {
  event.preventDefault()
  void sendMessage()
})

elements.input.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  elements.form.requestSubmit()
})

async function sendMessage() {
  if (state.sending) return
  const text = elements.input.value.trim()
  if (text === '') {
    showNotice('消息不能为空。')
    return
  }

  state.sending = true
  elements.send.disabled = true
  hideNotice()
  let assistant = null

  try {
    const response = await fetch('/kanobot/api/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text }),
    })
    if (!response.ok) {
      throw new Error(await responseMessage(response, '发送消息失败'))
    }
    if (!response.body) throw new Error('浏览器没有收到可读取的聊天流。')

    elements.input.value = ''
    await consumeEvents(response.body, event => {
      if (event.type === 'ready') {
        applyModel(event.model)
        appendMessage(
          event.userMessage.role,
          event.userMessage.text,
          event.userMessage.createdAt,
          event.userMessage.id,
        )
        assistant = appendPendingAssistant()
      } else if (event.type === 'delta') {
        if (assistant === null) throw new Error('聊天流顺序错误：缺少 ready 事件。')
        appendDelta(assistant, event.text)
      } else if (event.type === 'done') {
        if (assistant === null) throw new Error('聊天流顺序错误：缺少助手消息。')
        finishAssistant(assistant, event.message)
        appendMessage(
          event.message.role,
          '',
          event.message.createdAt,
          event.message.id,
          assistant,
        )
        assistant = null
        applyState(event.state)
        applyUsage(event.modelUsage)
      } else if (event.type === 'error') {
        throw new Error(event.message || '聊天回复失败。')
      }
    })
    if (assistant !== null) {
      throw new Error('聊天流在完成前结束了。')
    }
  } catch (error) {
    if (assistant !== null) {
      assistant.classList.remove('pending')
      assistant.querySelector('.message-text').textContent ||= '回复中断。'
    }
    showNotice(error instanceof Error ? error.message : String(error))
    try {
      renderConversation(await fetchConversation())
    } catch {
      // 初始错误已经展示，刷新失败不再覆盖它。
    }
  } finally {
    state.sending = false
    elements.send.disabled = false
    updateEmptyState()
    focusComposer()
  }
}

async function consumeEvents(stream, onEvent) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const data = frame
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n')
      if (data !== '') onEvent(JSON.parse(data))
      boundary = buffer.indexOf('\n\n')
    }
  }
  buffer += decoder.decode()
}

function appendMessage(role, text, createdAt, id, existingElement = null) {
  if (id && state.messageIds.has(id)) return existingElement
  const article =
    existingElement ?? document.createElement('article')
  article.classList.add('message', role)
  if (id) {
    article.dataset.messageId = id
    state.messageIds.add(id)
  }

  let content = article.querySelector('.message-text')
  if (content === null) {
    content = document.createElement('p')
    content.className = 'message-text'
    article.append(content)
  }
  if (text !== '') content.textContent = text

  let meta = article.querySelector('.message-meta')
  if (meta === null) {
    meta = document.createElement('div')
    meta.className = 'message-meta'
    article.append(meta)
  }
  meta.textContent = formatTime(createdAt)

  if (!article.isConnected) elements.messages.append(article)
  scrollToBottom()
  updateEmptyState()
  return article
}

function appendPendingAssistant() {
  const article = document.createElement('article')
  article.className = 'message assistant pending'
  const content = document.createElement('p')
  content.className = 'message-text'
  const meta = document.createElement('div')
  meta.className = 'message-meta'
  meta.textContent = '正在生成…'
  article.append(content, meta)
  elements.messages.append(article)
  scrollToBottom()
  updateEmptyState()
  return article
}

function appendDelta(article, text) {
  const content = article.querySelector('.message-text')
  content.textContent += text
  scrollToBottom()
}

function finishAssistant(article, message) {
  article.classList.remove('pending')
  article.querySelector('.message-text').textContent = message.text
  article.querySelector('.message-meta').textContent = formatTime(message.createdAt)
}

function applyModel(model) {
  if (!model || typeof model.id !== 'string') return
  const isMock = model.mode === 'mock'
  elements.modelBadge.textContent = isMock
    ? 'mock · 未连接真实模型'
    : `Magpie · ${model.id}`
  elements.statusModel.textContent = `${model.id} (${model.mode})`
  elements.statusProvider.textContent =
    typeof model.provider === 'string' ? model.provider : model.mode
  elements.emptyNote.textContent = isMock
    ? '这是占位人格和本地 mock 回复，不会调用真实模型。'
    : '这是占位人格；回复来自本地 Magpie 路由中的精确模型。'
}

function applyState(value) {
  if (!value) return
  elements.statusMessages.textContent = String(value.messageCount)
  elements.statusEvents.textContent = String(value.lastSequence)
}

function applyUsage(value) {
  if (!value || typeof value !== 'object') return
  elements.statusCalls.textContent =
    `${value.todayCallCount} / ${value.dailyCallLimit}`
  const lastCall = value.lastCall
  if (!lastCall || typeof lastCall !== 'object') {
    elements.statusTokens.textContent = '—'
    elements.statusCache.textContent = '—'
    elements.statusCost.textContent = '—'
    elements.statusLastCall.textContent = '—'
    return
  }

  const usage = lastCall.usage
  if (usage) {
    elements.statusTokens.textContent =
      `入 ${formatCount(usage.inputTokens)} · 出 ${formatCount(usage.outputTokens)}`
    elements.statusCache.textContent =
      `缓存 ${formatCount(usage.cacheReadTokens)} · 推理 ${formatCount(usage.reasoningTokens)}`
  } else {
    elements.statusTokens.textContent = '—'
    elements.statusCache.textContent = '—'
  }
  elements.statusCost.textContent =
    typeof lastCall.estimatedCost === 'number'
      ? `${formatCost(lastCall.estimatedCost)}（未标币种）`
      : '—'
  const status = statusLabel(lastCall.status)
  elements.statusLastCall.textContent =
    lastCall.status === 'succeeded'
      ? `${status} · ${lastCall.attempts} 次请求`
      : `${status}${lastCall.errorCode ? ` · ${lastCall.errorCode}` : ''}`
}

function updateEmptyState() {
  elements.empty.hidden = elements.messages.childElementCount > 0
}

function showNotice(message) {
  elements.notice.replaceChildren()
  if (message.includes('登录') || message.includes('认证')) {
    const prefix = document.createTextNode(`${message} `)
    const link = document.createElement('a')
    link.href = '/'
    link.textContent = '打开 DSH 根页面'
    elements.notice.append(prefix, link)
  } else {
    elements.notice.textContent = message
  }
  elements.notice.hidden = false
}

function hideNotice() {
  elements.notice.hidden = true
}

function focusComposer() {
  elements.input.focus({ preventScroll: true })
}

function scrollToBottom() {
  elements.messages.scrollTop = elements.messages.scrollHeight
}

function formatTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function formatCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? new Intl.NumberFormat('zh-CN').format(value)
    : '—'
}

function formatCost(value) {
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value === 0) return '0'
  if (value < 0.000001) return value.toExponential(3)
  return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}

function statusLabel(value) {
  switch (value) {
    case 'succeeded':
      return '成功'
    case 'running':
      return '进行中'
    case 'failed':
      return '失败'
    case 'aborted':
      return '已中止'
    default:
      return '未知'
  }
}

async function responseMessage(response, fallback) {
  try {
    const payload = await response.json()
    if (response.status === 401) {
      return payload?.error?.message || '需要先登录 DSH。'
    }
    return payload?.error?.message || fallback
  } catch {
    return `${fallback}（HTTP ${response.status}）`
  }
}
