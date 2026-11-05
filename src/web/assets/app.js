/**
 * M3.3 聊天与所有者记忆面板。
 *
 * 所有来自服务器和模型的文本都通过 textContent 渲染；SSE 只接受本页面
 * 固定的聊天流格式。记忆操作必须经过 DSH 登录态，页面不保存任何凭据。
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
  tabStatus: document.querySelector('#tab-status'),
  tabMemory: document.querySelector('#tab-memory'),
  tabButtons: Array.from(document.querySelectorAll('.tab-button')),
  memoryBadge: document.querySelector('#memory-badge'),
  memoryAdd: document.querySelector('#memory-add'),
  memorySearch: document.querySelector('#memory-search'),
  memorySearchInput: document.querySelector('#memory-search-input'),
  memoryFilters: Array.from(document.querySelectorAll('.memory-filter')),
  memoryList: document.querySelector('#memory-list'),
  memoryEmpty: document.querySelector('#memory-empty'),
  memoryError: document.querySelector('#memory-error'),
  countActive: document.querySelector('#count-active'),
  countCandidate: document.querySelector('#count-candidate'),
  countTrash: document.querySelector('#count-trash'),
  dialog: document.querySelector('#memory-dialog'),
  dialogTitle: document.querySelector('#memory-dialog-title'),
  dialogClose: document.querySelector('#memory-dialog-close'),
  dialogCancel: document.querySelector('#memory-cancel'),
  dialogForm: document.querySelector('#memory-form'),
  dialogError: document.querySelector('#memory-form-error'),
  memoryText: document.querySelector('#memory-text'),
  memoryKind: document.querySelector('#memory-kind'),
  memoryImportance: document.querySelector('#memory-importance'),
  memorySensitivity: document.querySelector('#memory-sensitivity'),
}

const state = {
  sending: false,
  messageIds: new Set(),
  activeTab: 'status',
  memoryStatus: 'active',
  memoryQuery: '',
  editingMemoryId: null,
  counts: { active: 0, candidate: 0, trash: 0 },
  memories: [],
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
  try {
    await loadMemories()
  } catch (error) {
    showMemoryError(errorMessage(error))
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
        assistant = appendPendingAssistant(event.recalledMemoryCount)
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
        applyState(event.state)
        applyUsage(event.modelUsage)
        appendMemoryOutcome(assistant, event.memory)
        assistant = null
        void loadMemories().catch(error => showMemoryError(errorMessage(error)))
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
    showNotice(errorMessage(error))
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
  const article = existingElement ?? document.createElement('article')
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

function appendPendingAssistant(recalledMemoryCount) {
  const article = document.createElement('article')
  article.className = 'message assistant pending'
  const content = document.createElement('p')
  content.className = 'message-text'
  const meta = document.createElement('div')
  meta.className = 'message-meta'
  meta.textContent = recalledMemoryCount > 0
    ? `正在生成… · 检索到 ${recalledMemoryCount} 条记忆`
    : '正在生成…'
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

function appendMemoryOutcome(article, memory) {
  if (!memory || typeof memory !== 'object') return
  let text = ''
  if (memory.status === 'succeeded') {
    if (memory.createdCount > 0) {
      text = `这轮记下了 ${memory.createdCount} 条` +
        (memory.candidateCount > 0
          ? `，其中 ${memory.candidateCount} 条待你确认`
          : '')
    } else {
      text = '这轮没有新的长期记忆。'
    }
  } else if (memory.status === 'failed') {
    text = '这轮记忆整理失败；回复已经保存。'
  } else if (memory.status === 'skipped') {
    text = '这轮记忆整理已跳过。'
  }
  if (text === '') return
  const note = document.createElement('p')
  note.className = 'memory-outcome'
  note.textContent = text
  article.append(note)
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

function formatDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
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

/* ------------------------------ 所有者面板 ------------------------------ */

for (const button of elements.tabButtons) {
  button.addEventListener('click', () => switchTab(button.dataset.tab))
}

function switchTab(tab) {
  if (tab !== 'status' && tab !== 'memory') return
  state.activeTab = tab
  for (const button of elements.tabButtons) {
    const active = button.dataset.tab === tab
    button.classList.toggle('active', active)
    button.setAttribute('aria-selected', active ? 'true' : 'false')
  }
  elements.tabStatus.hidden = tab !== 'status'
  elements.tabMemory.hidden = tab !== 'memory'
  if (tab === 'memory') {
    void loadMemories().catch(error => showMemoryError(errorMessage(error)))
  }
}

for (const button of elements.memoryFilters) {
  button.addEventListener('click', () => {
    const status = button.dataset.status
    if (status !== 'active' && status !== 'candidate' && status !== 'trash') return
    state.memoryStatus = status
    state.memoryQuery = ''
    elements.memorySearchInput.value = ''
    for (const item of elements.memoryFilters) {
      item.classList.toggle('active', item === button)
    }
    void loadMemories().catch(error => showMemoryError(errorMessage(error)))
  })
}

elements.memorySearch.addEventListener('submit', event => {
  event.preventDefault()
  state.memoryQuery = elements.memorySearchInput.value.trim()
  state.memoryStatus = 'active'
  for (const item of elements.memoryFilters) {
    item.classList.toggle('active', item.dataset.status === 'active')
  }
  void loadMemories().catch(error => showMemoryError(errorMessage(error)))
})

elements.memoryAdd.addEventListener('click', () => openMemoryDialog())
elements.dialogClose.addEventListener('click', closeMemoryDialog)
elements.dialogCancel.addEventListener('click', closeMemoryDialog)
elements.dialog.addEventListener('click', event => {
  if (event.target === elements.dialog) closeMemoryDialog()
})
elements.dialogForm.addEventListener('submit', event => {
  event.preventDefault()
  void saveMemory()
})
elements.memoryList.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]')
  if (!(button instanceof HTMLButtonElement)) return
  const id = button.dataset.id
  const action = button.dataset.action
  if (!id || !action) return
  void runMemoryAction(id, action).catch(error => showMemoryError(errorMessage(error)))
})

async function loadMemories() {
  const params = new URLSearchParams({ status: state.memoryStatus })
  if (state.memoryQuery !== '') params.set('q', state.memoryQuery)
  const response = await fetch(`/kanobot/api/memories?${params}`, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(await responseMessage(response, '读取记忆失败'))
  }
  const payload = await response.json()
  state.memories = Array.isArray(payload.memories) ? payload.memories : []
  if (payload.counts && typeof payload.counts === 'object') {
    state.counts = {
      active: Number(payload.counts.active) || 0,
      candidate: Number(payload.counts.candidate) || 0,
      trash: Number(payload.counts.trash) || 0,
    }
  }
  renderMemoryCounts()
  renderMemoryList()
  hideMemoryError()
}

function renderMemoryCounts() {
  elements.countActive.textContent = String(state.counts.active)
  elements.countCandidate.textContent = String(state.counts.candidate)
  elements.countTrash.textContent = String(state.counts.trash)
  elements.memoryBadge.textContent = String(state.counts.candidate)
}

function renderMemoryList() {
  elements.memoryList.replaceChildren()
  if (state.memories.length === 0) {
    elements.memoryEmpty.hidden = false
    elements.memoryEmpty.textContent = state.memoryQuery !== ''
      ? '没有搜到匹配的记忆。'
      : '这里还没有记忆。'
    return
  }
  elements.memoryEmpty.hidden = true
  for (const memory of state.memories) {
    elements.memoryList.append(renderMemoryCard(memory))
  }
}

function renderMemoryCard(memory) {
  const article = document.createElement('article')
  article.className = `memory-item status-${memory.status}`

  const text = document.createElement('p')
  text.className = 'memory-text'
  text.textContent = String(memory.text ?? '')
  article.append(text)

  const meta = document.createElement('div')
  meta.className = 'memory-meta'
  meta.append(
    chip(kindLabel(memory.kind)),
    chip(importanceLabel(memory.importance)),
    chip(sensitivityLabel(memory.sensitivity), `sensitivity-${memory.sensitivity}`),
    chip(sourceLabel(memory.source)),
    chip(formatDate(memory.createdAt)),
  )
  article.append(meta)

  if (
    typeof memory.quoteText === 'string' &&
    memory.quoteText !== '' &&
    memory.quoteText !== memory.text
  ) {
    const details = document.createElement('details')
    details.className = 'memory-quote'
    const summary = document.createElement('summary')
    summary.textContent = '原话'
    const quote = document.createElement('p')
    quote.textContent = memory.quoteText
    details.append(summary, quote)
    article.append(details)
  }

  if (memory.status === 'deleted' && memory.purgeAfter) {
    const expiry = document.createElement('p')
    expiry.className = 'memory-expiry'
    expiry.textContent = `预计 ${formatDate(memory.purgeAfter)} 彻底清除`
    article.append(expiry)
  }

  const actions = document.createElement('div')
  actions.className = 'memory-actions'
  if (memory.status === 'active') {
    actions.append(
      actionButton('编辑', 'edit', memory.id, false),
      actionButton('删除', 'trash', memory.id, true),
    )
  } else if (memory.status === 'candidate') {
    actions.append(
      actionButton('转正', 'promote', memory.id, false),
      actionButton('删除', 'trash', memory.id, true),
    )
  } else if (memory.status === 'deleted') {
    actions.append(
      actionButton('恢复', 'restore', memory.id, false),
      actionButton('彻底清除', 'purge', memory.id, true),
    )
  }
  article.append(actions)
  return article
}

function chip(text, extraClass = '') {
  const span = document.createElement('span')
  span.className = `chip ${extraClass}`.trim()
  span.textContent = text
  return span
}

function actionButton(label, action, id, danger) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = danger ? 'text-button danger' : 'text-button'
  button.dataset.action = action
  button.dataset.id = id
  button.textContent = label
  return button
}

async function runMemoryAction(id, action) {
  if (action === 'edit') {
    const memory = state.memories.find(item => item.id === id)
    if (memory) openMemoryDialog(memory)
    return
  }
  if (action === 'trash') {
    if (!window.confirm('把这条记忆放进回收站？30 天内可以恢复。')) return
    await memoryRequest(`/kanobot/api/memories/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  } else if (action === 'promote') {
    await memoryRequest(
      `/kanobot/api/memories/${encodeURIComponent(id)}/promote`,
      { method: 'POST' },
    )
  } else if (action === 'restore') {
    await memoryRequest(
      `/kanobot/api/memories/${encodeURIComponent(id)}/restore`,
      { method: 'POST' },
    )
  } else if (action === 'purge') {
    if (!window.confirm('彻底清除后无法恢复，也会从检索索引中删除。继续？')) return
    await memoryRequest(
      `/kanobot/api/memories/${encodeURIComponent(id)}/purge`,
      { method: 'POST', body: { confirm: true } },
    )
  } else {
    return
  }
  await loadMemories()
}

function openMemoryDialog(memory = null) {
  state.editingMemoryId = memory?.id ?? null
  elements.dialogTitle.textContent = memory === null ? '新增记忆' : '编辑记忆'
  elements.memoryText.value = memory?.text ?? ''
  setSelectValue(elements.memoryKind, memory?.kind ?? 'preference')
  setSelectValue(elements.memoryImportance, memory?.importance ?? 'normal')
  setSelectValue(elements.memorySensitivity, memory?.sensitivity ?? 'normal')
  elements.dialogError.hidden = true
  elements.dialog.showModal()
  elements.memoryText.focus()
}

function setSelectValue(select, value) {
  if (!Array.from(select.options).some(option => option.value === value)) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = value
    select.append(option)
  }
  select.value = value
}

function closeMemoryDialog() {
  state.editingMemoryId = null
  elements.dialog.close()
}

async function saveMemory() {
  const text = elements.memoryText.value.trim()
  if (text === '') {
    showDialogError('记忆内容不能为空。')
    return
  }
  const body = {
    text,
    kind: elements.memoryKind.value,
    importance: elements.memoryImportance.value,
    sensitivity: elements.memorySensitivity.value,
  }
  try {
    if (state.editingMemoryId === null) {
      await memoryRequest('/kanobot/api/memories', { method: 'POST', body })
    } else {
      await memoryRequest(
        `/kanobot/api/memories/${encodeURIComponent(state.editingMemoryId)}`,
        { method: 'PATCH', body },
      )
    }
    closeMemoryDialog()
    await loadMemories()
  } catch (error) {
    showDialogError(errorMessage(error))
  }
}

async function memoryRequest(path, options = {}) {
  const headers = { accept: 'application/json' }
  const init = {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers,
  }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  const response = await fetch(path, init)
  if (!response.ok) {
    throw new Error(await responseMessage(response, '记忆操作失败'))
  }
  return response.json()
}

function showMemoryError(message) {
  elements.memoryError.textContent = message
  elements.memoryError.hidden = false
}

function hideMemoryError() {
  elements.memoryError.hidden = true
}

function showDialogError(message) {
  elements.dialogError.textContent = message
  elements.dialogError.hidden = false
}

function kindLabel(value) {
  switch (value) {
    case 'preference':
      return '偏好'
    case 'personal_fact':
      return '事实'
    case 'plan':
      return '计划'
    case 'shared_experience':
      return '共同经历'
    case 'relationship_event':
      return '关系'
    case 'note':
      return '备注'
    default:
      return '记忆'
  }
}

function importanceLabel(value) {
  switch (value) {
    case 'permanent':
      return '永久'
    case 'important':
      return '重要'
    default:
      return '普通'
  }
}

function sensitivityLabel(value) {
  switch (value) {
    case 'sensitive':
      return '敏感'
    case 'third_party':
      return '第三人'
    default:
      return '正常'
  }
}

function sourceLabel(value) {
  switch (value) {
    case 'user_stated':
      return '你说过'
    case 'rinko_inferred':
      return '推断'
    case 'external':
      return '外部'
    default:
      return '来源未知'
  }
}
