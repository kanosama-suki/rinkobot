/**
 * 独立陪伴核心的聊天、完整对话档案、记忆、主动性、状态、视觉、审计、设置弹窗
 * 与紧急停止面板。
 *
 * 所有来自服务器和模型的文本都通过 textContent 渲染；SSE 只接受本页面
 * 固定的聊天流格式。记忆操作必须经过所有者会话，页面不保存任何凭据。
 */

const elements = {
  chatPanel: document.querySelector('.chat-panel'),
  chatViewOwner: document.querySelector('#chat-view-owner'),
  chatViewArchive: document.querySelector('#chat-view-archive'),
  archiveControls: document.querySelector('#archive-controls'),
  archiveConversation: document.querySelector('#archive-conversation'),
  archiveRename: document.querySelector('#archive-rename'),
  archiveRenameInput: document.querySelector('#archive-rename-input'),
  archiveRenameSave: document.querySelector('#archive-rename-save'),
  archiveRenameReset: document.querySelector('#archive-rename-reset'),
  archiveRefresh: document.querySelector('#archive-refresh'),
  chatContextNote: document.querySelector('#chat-context-note'),
  ownerQqWarning: document.querySelector('#owner-qq-warning'),
  historyMore: document.querySelector('#history-more'),
  messages: document.querySelector('#messages'),
  empty: document.querySelector('#empty-state'),
  emptyTitle: document.querySelector('#empty-state p'),
  notice: document.querySelector('#notice'),
  form: document.querySelector('#composer'),
  input: document.querySelector('#message-input'),
  send: document.querySelector('#send-button'),
  imageInput: document.querySelector('#image-input'),
  imageButton: document.querySelector('#image-button'),
  imageRemove: document.querySelector('#image-remove'),
  imagePreview: document.querySelector('#image-preview'),
  imagePreviewImg: document.querySelector('#image-preview-img'),
  imagePreviewName: document.querySelector('#image-preview-name'),
  visionStatus: document.querySelector('#vision-status'),
  statusVision: document.querySelector('#status-vision'),
  modelBadge: document.querySelector('#model-badge'),
  controlBadge: document.querySelector('#control-badge'),
  statusModel: document.querySelector('#status-model'),
  statusProvider: document.querySelector('#status-provider'),
  statusCalls: document.querySelector('#status-calls'),
  statusTokens: document.querySelector('#status-tokens'),
  statusCache: document.querySelector('#status-cache'),
  statusCost: document.querySelector('#status-cost'),
  statusLastCall: document.querySelector('#status-last-call'),
  statusMessages: document.querySelector('#status-messages'),
  statusAffect: document.querySelector('#status-affect'),
  statusRelationship: document.querySelector('#status-relationship'),
  statusCommitments: document.querySelector('#status-commitments'),
  statusEvents: document.querySelector('#status-events'),
  emptyNote: document.querySelector('#empty-note'),
  composerHint: document.querySelector('.composer-hint'),
  tabStatus: document.querySelector('#tab-status'),
  tabInitiative: document.querySelector('#tab-initiative'),
  tabMemory: document.querySelector('#tab-memory'),
  tabAudit: document.querySelector('#tab-audit'),
  tabButtons: Array.from(document.querySelectorAll('.tab-button')),
  qqBadge: document.querySelector('#qq-badge'),
  initiativeBadge: document.querySelector('#initiative-badge'),
  initiativeEnabled: document.querySelector('#initiative-enabled'),
  initiativeQuiet: document.querySelector('#initiative-quiet'),
  initiativeLast: document.querySelector('#initiative-last'),
  initiativeNext: document.querySelector('#initiative-next'),
  initiativeUnanswered: document.querySelector('#initiative-unanswered'),
  initiativeWindow: document.querySelector('#initiative-window'),
  initiativeRefresh: document.querySelector('#initiative-refresh'),
  initiativeError: document.querySelector('#initiative-error'),
  notificationEnable: document.querySelector('#notification-enable'),
  notificationStatus: document.querySelector('#notification-status'),
  circuitWarning: document.querySelector('#circuit-warning'),
  circuitText: document.querySelector('#circuit-text'),
  circuitReset: document.querySelector('#circuit-reset'),
  planList: document.querySelector('#plan-list'),
  planEmpty: document.querySelector('#plan-empty'),
  reminderCandidateList: document.querySelector('#reminder-candidate-list'),
  reminderCandidateEmpty: document.querySelector('#reminder-candidate-empty'),
  reminderList: document.querySelector('#reminder-list'),
  reminderEmpty: document.querySelector('#reminder-empty'),
  careList: document.querySelector('#care-list'),
  careEmpty: document.querySelector('#care-empty'),
  summaryList: document.querySelector('#summary-list'),
  summaryEmpty: document.querySelector('#summary-empty'),
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
  countArchived: document.querySelector('#count-archived'),
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
  emergencyState: document.querySelector('#emergency-state'),
  emergencyNote: document.querySelector('#emergency-note'),
  emergencyButton: document.querySelector('#emergency-button'),
  auditBadge: document.querySelector('#audit-badge'),
  auditRefresh: document.querySelector('#audit-refresh'),
  auditSource: document.querySelector('#audit-source'),
  auditList: document.querySelector('#audit-list'),
  auditEmpty: document.querySelector('#audit-empty'),
  auditError: document.querySelector('#audit-error'),
  auditMore: document.querySelector('#audit-more'),
  settingsOpen: document.querySelector('#settings-open'),
  settingsDialog: document.querySelector('#settings-dialog'),
  settingsDialogClose: document.querySelector('#settings-dialog-close'),
  settingsNavButtons: Array.from(
    document.querySelectorAll('[data-settings-page]'),
  ),
  settingsPageModel: document.querySelector('#settings-page-model'),
  settingsPageQq: document.querySelector('#settings-page-qq'),
  settingsForm: document.querySelector('#settings-form'),
  settingsDiscover: document.querySelector('#settings-discover'),
  settingsRefresh: document.querySelector('#settings-refresh'),
  settingsReadOnly: document.querySelector('#settings-readonly'),
  settingsError: document.querySelector('#settings-error'),
  settingsStatus: document.querySelector('#settings-status'),
  settingsTest: document.querySelector('#settings-test'),
  settingsSave: document.querySelector('#settings-save'),
  settingsChatProvider: document.querySelector('#settings-chat-provider'),
  settingsChatDiscovery: document.querySelector('#settings-chat-discovery'),
  settingsChatDiscoverySummary: document.querySelector('#settings-chat-discovery-summary'),
  settingsChatRediscover: document.querySelector('#settings-chat-rediscover'),
  settingsChatModelSection: document.querySelector('#settings-chat-model-section'),
  settingsChatModelCount: document.querySelector('#settings-chat-model-count'),
  settingsChatModelChips: document.querySelector('#settings-chat-model-chips'),
  settingsChatModelMore: document.querySelector('#settings-chat-model-more'),
  settingsChatModelNote: document.querySelector('#settings-chat-model-note'),
  settingsChatName: document.querySelector('#settings-chat-name'),
  settingsChatBaseField: document.querySelector('#settings-chat-base-field'),
  settingsChatBaseUrl: document.querySelector('#settings-chat-base-url'),
  settingsChatTimeout: document.querySelector('#settings-chat-timeout'),
  settingsChatRetries: document.querySelector('#settings-chat-retries'),
  settingsChatMaxOutput: document.querySelector('#settings-chat-max-output'),
  settingsChatReasoning: document.querySelector('#settings-chat-reasoning'),
  settingsChatPrivate: document.querySelector('#settings-chat-private'),
  settingsChatCredentialMode: document.querySelector('#settings-chat-credential-mode'),
  settingsChatCredentialStatus: document.querySelector('#settings-chat-credential-status'),
  settingsChatEnvField: document.querySelector('#settings-chat-env-field'),
  settingsChatEnv: document.querySelector('#settings-chat-env'),
  settingsChatSecretField: document.querySelector('#settings-chat-secret-field'),
  settingsChatSecret: document.querySelector('#settings-chat-secret'),
  settingsVisionEnabled: document.querySelector('#settings-vision-enabled'),
  settingsVisionFields: document.querySelector('#settings-vision-fields'),
  settingsVisionProvider: document.querySelector('#settings-vision-provider'),
  settingsVisionName: document.querySelector('#settings-vision-name'),
  settingsVisionDiscovery: document.querySelector('#settings-vision-discovery'),
  settingsVisionDiscoverySummary: document.querySelector('#settings-vision-discovery-summary'),
  settingsVisionRediscover: document.querySelector('#settings-vision-rediscover'),
  settingsVisionSupportedSection: document.querySelector('#settings-vision-supported-section'),
  settingsVisionSupportedCount: document.querySelector('#settings-vision-supported-count'),
  settingsVisionSupportedChips: document.querySelector('#settings-vision-supported-chips'),
  settingsVisionSupportedMore: document.querySelector('#settings-vision-supported-more'),
  settingsVisionUnknownSection: document.querySelector('#settings-vision-unknown-section'),
  settingsVisionUnknownCount: document.querySelector('#settings-vision-unknown-count'),
  settingsVisionUnknownChips: document.querySelector('#settings-vision-unknown-chips'),
  settingsVisionUnknownMore: document.querySelector('#settings-vision-unknown-more'),
  settingsVisionEmptyNote: document.querySelector('#settings-vision-empty-note'),
  settingsVisionBaseUrl: document.querySelector('#settings-vision-base-url'),
  settingsVisionTimeout: document.querySelector('#settings-vision-timeout'),
  settingsVisionRetries: document.querySelector('#settings-vision-retries'),
  settingsVisionMaxOutput: document.querySelector('#settings-vision-max-output'),
  settingsVisionImageBytes: document.querySelector('#settings-vision-image-bytes'),
  settingsVisionDescriptionChars: document.querySelector('#settings-vision-description-chars'),
  settingsVisionPrivate: document.querySelector('#settings-vision-private'),
  settingsVisionCredentialMode: document.querySelector('#settings-vision-credential-mode'),
  settingsVisionCredentialStatus: document.querySelector('#settings-vision-credential-status'),
  settingsVisionEnvField: document.querySelector('#settings-vision-env-field'),
  settingsVisionEnv: document.querySelector('#settings-vision-env'),
  settingsVisionSecretField: document.querySelector('#settings-vision-secret-field'),
  settingsVisionSecret: document.querySelector('#settings-vision-secret'),
  channelForm: document.querySelector('#channel-settings-form'),
  channelRefresh: document.querySelector('#channel-settings-refresh'),
  channelReadOnly: document.querySelector('#channel-readonly'),
  channelError: document.querySelector('#channel-settings-error'),
  channelStatus: document.querySelector('#channel-settings-status'),
  channelConnectionState: document.querySelector('#channel-connection-state'),
  channelEnabled: document.querySelector('#channel-enabled'),
  channelWsUrl: document.querySelector('#channel-ws-url'),
  channelAllowRemote: document.querySelector('#channel-allow-remote'),
  channelOwnerQq: document.querySelector('#channel-owner-qq'),
  channelCredentialMode: document.querySelector('#channel-credential-mode'),
  channelCredentialStatus: document.querySelector('#channel-credential-status'),
  channelCredentialEnvField: document.querySelector('#channel-credential-env-field'),
  channelCredentialEnv: document.querySelector('#channel-credential-env'),
  channelCredentialSecretField: document.querySelector('#channel-credential-secret-field'),
  channelCredentialSecret: document.querySelector('#channel-credential-secret'),
  channelPrivateAllow: document.querySelector('#channel-private-allow'),
  channelGroupAllow: document.querySelector('#channel-group-allow'),
  channelGroupRequireMention: document.querySelector('#channel-group-require-mention'),
  channelAutonomousTarget: document.querySelector('#channel-autonomous-target'),
  channelConnectTimeout: document.querySelector('#channel-connect-timeout'),
  channelActionTimeout: document.querySelector('#channel-action-timeout'),
  channelTurnTimeout: document.querySelector('#channel-turn-timeout'),
  channelReconnectMin: document.querySelector('#channel-reconnect-min'),
  channelReconnectMax: document.querySelector('#channel-reconnect-max'),
  channelPingInterval: document.querySelector('#channel-ping-interval'),
  channelDedupeRetention: document.querySelector('#channel-dedupe-retention'),
  channelCoalesceQuiet: document.querySelector('#channel-coalesce-quiet'),
  channelCoalesceMaxWait: document.querySelector('#channel-coalesce-max-wait'),
  channelCoalesceMaxImages: document.querySelector('#channel-coalesce-max-images'),
  channelCoalesceMaxTotalImageBytes: document.querySelector('#channel-coalesce-max-total-image-bytes'),
  channelImagesDownloadTimeout: document.querySelector('#channel-images-download-timeout'),
  channelOutboundSplitChars: document.querySelector('#channel-outbound-split-chars'),
  channelOutboundMaxParts: document.querySelector('#channel-outbound-max-parts'),
  channelOutboundMinInterval: document.querySelector('#channel-outbound-min-interval'),
  channelLimitsMaxInbound: document.querySelector('#channel-limits-max-inbound'),
  channelLimitsMaxOutbound: document.querySelector('#channel-limits-max-outbound'),
  channelTest: document.querySelector('#channel-test'),
  channelSave: document.querySelector('#channel-save'),
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const POLL_INTERVAL_MS = 30_000
const MODEL_CHOICE_LIMIT = 8
const PAGE_SIZE = 50

const state = {
  sending: false,
  polling: false,
  image: null,
  maxImageBytes: MAX_IMAGE_BYTES,
  model: null,
  chatView: 'owner',
  ownerMessages: [],
  ownerMessageIds: new Set(),
  ownerHasMore: false,
  ownerNextBeforeSequence: null,
  archiveMessages: [],
  archiveMessageIds: new Set(),
  archiveHasMore: false,
  archiveNextBeforeSequence: null,
  archiveConversationId: '',
  archiveConversations: [],
  archiveLoading: false,
  archiveRenameBusy: false,
  historyLoading: false,
  activeTab: 'status',
  memoryStatus: 'active',
  memoryQuery: '',
  editingMemoryId: null,
  counts: { active: 0, candidate: 0, archived: 0, trash: 0 },
  memories: [],
  emergency: null,
  auditSource: 'all',
  auditEntries: [],
  auditVisible: 50,
  initiative: null,
  channelStatus: null,
  channelSettings: null,
  channelBusy: false,
  channelPollTimer: null,
  modelSettings: null,
  discovery: null,
  chatModelsExpanded: false,
  visionSupportedExpanded: false,
  visionUnknownExpanded: false,
  settingsBusy: false,
  settingsPage: 'model',
}

void initialize()

async function initialize() {
  try {
    const view = await fetchConversation()
    applyOwnerPage(view, true)
    renderCurrentView('bottom')
    focusComposer()
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error))
  }
  try {
    await loadMemories()
  } catch (error) {
    showMemoryError(errorMessage(error))
  }
  try {
    await loadControl()
  } catch (error) {
    showNotice(errorMessage(error))
  }
  try {
    await loadInitiative()
  } catch (error) {
    showInitiativeError(errorMessage(error))
  }
  try {
    await loadChannelStatus()
  } catch (error) {
    elements.qqBadge.textContent = 'QQ 状态不可用'
  }
  updateNotificationControls()
  state.channelPollTimer = window.setInterval(() => {
    void pollUpdates()
  }, POLL_INTERVAL_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void pollUpdates()
  })
  window.addEventListener('pagehide', () => {
    if (state.channelPollTimer !== null) {
      window.clearInterval(state.channelPollTimer)
      state.channelPollTimer = null
    }
  })
}

async function pollUpdates() {
  if (state.polling) return
  state.polling = true
  try {
    const previousProactiveAt = state.initiative?.lastProactiveAt ?? null
    let initiativeView = null
    try {
      initiativeView = await loadInitiative()
    } catch {
      // 主动性接口可能被宿主关闭；已有错误会在打开页签时显示。
    }
    try {
      await loadChannelStatus()
    } catch {
      // 顶部 badge 是常驻状态增强；打开设置页时会显示具体错误。
    }
    if (!state.sending) {
      try {
        const newMessages = await refreshConversation()
        if (state.chatView === 'archive') {
          await refreshArchiveLatest()
        }
        const latestProactiveAt = initiativeView?.lastProactiveAt ?? null
        if (
          latestProactiveAt !== null &&
          latestProactiveAt !== previousProactiveAt &&
          document.visibilityState !== 'visible'
        ) {
          const proactiveMessage = newMessages.find(message =>
            message.role === 'assistant' &&
            message.createdAt === latestProactiveAt
          )
          if (proactiveMessage !== undefined) {
            notifyProactiveMessage(proactiveMessage)
          }
        }
      } catch {
        // 轮询是后台增强；失败不打断当前聊天或面板操作。
      }
    }
  } finally {
    state.polling = false
  }
}

async function refreshConversation() {
  const previousIds = new Set(state.ownerMessageIds)
  const view = await fetchConversation()
  const newMessages = applyOwnerPage(view, false)
  if (state.chatView === 'owner' && newMessages.length > 0) {
    for (const message of newMessages) {
      appendMessage(
        message.role,
        message.text,
        message.createdAt,
        message.id,
      )
    }
  }
  return newMessages.filter(message => !previousIds.has(message.id))
}

function applyOwnerPage(view, replace) {
  const previousIds = new Set(state.ownerMessageIds)
  applyModel(view.model)
  applyVision(view.vision)
  applyState(view.state)
  applyUsage(view.modelUsage)
  const incoming = Array.isArray(view.messages) ? view.messages : []
  const byId = new Map()
  if (!replace) {
    for (const message of state.ownerMessages) byId.set(message.id, message)
  }
  for (const message of incoming) byId.set(message.id, message)
  state.ownerMessages = sortMessages(Array.from(byId.values()))
  state.ownerMessageIds = new Set(
    state.ownerMessages.map(message => message.id),
  )
  state.ownerHasMore = view.hasMore === true
  state.ownerNextBeforeSequence =
    Number.isSafeInteger(view.nextBeforeSequence)
      ? view.nextBeforeSequence
      : null
  const newMessages = incoming.filter(message => !previousIds.has(message.id))
  return newMessages
}

async function fetchConversation(beforeSequence = null) {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
  if (Number.isSafeInteger(beforeSequence)) {
    params.set('beforeSeq', String(beforeSequence))
  }
  const response = await fetch(`/kanobot/api/conversation?${params}`, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(await responseMessage(response, '读取聊天记录失败'))
  }
  return response.json()
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

elements.imageButton.addEventListener('click', () => {
  if (state.image === null) elements.imageInput.click()
})

elements.imageInput.addEventListener('change', () => {
  const file = elements.imageInput.files?.[0]
  if (file === undefined) return
  // 先复位选择器，校验失败或稍后重选同一文件时仍能触发 change。
  elements.imageInput.value = ''
  void setImageFile(file).catch(error => showNotice(errorMessage(error)))
})

elements.imageRemove.addEventListener('click', () => {
  clearImage()
  elements.input.focus({ preventScroll: true })
})

elements.chatViewOwner.addEventListener('click', () => {
  void setChatView('owner')
})

elements.chatViewArchive.addEventListener('click', () => {
  void setChatView('archive')
})

elements.archiveConversation.addEventListener('change', () => {
  state.archiveConversationId = elements.archiveConversation.value
  updateArchiveRenameControls()
  void loadArchivePage(true)
})

elements.archiveRenameSave.addEventListener('click', () => {
  void saveArchiveConversationName(elements.archiveRenameInput.value)
})

elements.archiveRenameReset.addEventListener('click', () => {
  void saveArchiveConversationName(null)
})

elements.archiveRenameInput.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.isComposing) return
  event.preventDefault()
  elements.archiveRenameSave.click()
})

elements.archiveRefresh.addEventListener('click', () => {
  void refreshArchive()
})

elements.historyMore.addEventListener('click', () => {
  void loadOlderMessages()
})

elements.messages.addEventListener('scroll', () => {
  updateHistoryControls()
}, { passive: true })

async function setChatView(view) {
  if (view !== 'owner' && view !== 'archive') return
  if (state.chatView === view) return
  if (state.sending) {
    showNotice('当前回复完成后才能切换视图。')
    return
  }
  state.chatView = view
  if (view === 'owner') {
    renderCurrentView('bottom')
    focusComposer()
    return
  }
  renderCurrentView('bottom')
  await Promise.all([
    loadConversationDirectory(),
    loadArchivePage(true),
  ])
}

async function loadConversationDirectory() {
  const response = await fetch('/kanobot/api/conversations', {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(await responseMessage(response, '读取会话目录失败'))
  }
  const view = await response.json()
  state.archiveConversations = Array.isArray(view.conversations)
    ? view.conversations
    : []
  renderArchiveConversationOptions()
  updateArchiveRenameControls()
}

function renderArchiveConversationOptions() {
  const selected = state.archiveConversationId
  const options = document.createDocumentFragment()
  const all = document.createElement('option')
  all.value = ''
  all.textContent = '全部来源'
  options.append(all)
  for (const conversation of state.archiveConversations) {
    if (
      typeof conversation.conversationId !== 'string' ||
      typeof conversation.conversationLabel !== 'string'
    ) {
      continue
    }
    if (
      conversation.conversationKind !== 'owner' &&
      !(Number(conversation.messageCount) > 0)
    ) {
      continue
    }
    const option = document.createElement('option')
    option.value = conversation.conversationId
    option.textContent = `${conversation.conversationLabel}` +
      ` (${Number(conversation.messageCount) || 0})`
    options.append(option)
  }
  elements.archiveConversation.replaceChildren(options)
  const stillPresent = state.archiveConversations.some(
    conversation => conversation.conversationId === selected,
  )
  state.archiveConversationId = stillPresent ? selected : ''
  elements.archiveConversation.value = state.archiveConversationId
}

function updateArchiveRenameControls() {
  const conversation = state.archiveConversations.find(
    item => item.conversationId === state.archiveConversationId,
  )
  const editable =
    state.chatView === 'archive' &&
    conversation !== undefined &&
    conversation.conversationKind !== 'owner'
  elements.archiveRename.hidden = !editable
  if (!editable) return

  elements.archiveRenameInput.placeholder = conversation.conversationId
  if (document.activeElement !== elements.archiveRenameInput) {
    elements.archiveRenameInput.value =
      typeof conversation.displayName === 'string'
        ? conversation.displayName
        : ''
  }
  elements.archiveRenameSave.disabled = state.archiveRenameBusy
  elements.archiveRenameReset.disabled =
    state.archiveRenameBusy ||
    typeof conversation.displayName !== 'string'
}

async function saveArchiveConversationName(displayName) {
  if (state.archiveRenameBusy) return
  const conversationId = state.archiveConversationId
  const current = state.archiveConversations.find(
    item => item.conversationId === conversationId,
  )
  if (current === undefined) return

  const previous = captureScroll()
  state.archiveRenameBusy = true
  updateArchiveRenameControls()
  try {
    const response = await fetch(
      `/kanobot/api/conversations/${encodeURIComponent(conversationId)}`,
      {
        method: 'PUT',
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ displayName }),
      },
    )
    if (!response.ok) {
      throw new Error(await responseMessage(response, '保存会话名称失败'))
    }
    const summary = await response.json()
    if (
      typeof summary.conversationLabel !== 'string' ||
      (summary.displayName !== null &&
        typeof summary.displayName !== 'string')
    ) {
      throw new Error('会话名称响应格式不正确')
    }
    const index = state.archiveConversations.findIndex(
      item => item.conversationId === conversationId,
    )
    if (index >= 0) {
      state.archiveConversations[index] = {
        ...state.archiveConversations[index],
        ...summary,
      }
    }
    // 已加载的档案消息保留稳定 ID 和滚动位置，只更新来源标签。
    for (const message of state.archiveMessages) {
      if (message.conversationId === conversationId) {
        message.conversationLabel = summary.conversationLabel
      }
    }
    renderArchiveConversationOptions()
    renderCurrentView('anchor', previous)
  } catch (error) {
    showNotice(errorMessage(error))
  } finally {
    state.archiveRenameBusy = false
    updateArchiveRenameControls()
  }
}

async function loadArchivePage(replace) {
  if (state.archiveLoading) return
  state.archiveLoading = true
  try {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
    if (state.archiveConversationId !== '') {
      params.set('conversationId', state.archiveConversationId)
    }
    const response = await fetch(`/kanobot/api/timeline?${params}`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) {
      throw new Error(await responseMessage(response, '读取对话档案失败'))
    }
    const view = await response.json()
    const byId = new Map()
    if (!replace) {
      for (const message of state.archiveMessages) byId.set(message.id, message)
    }
    for (const message of Array.isArray(view.messages) ? view.messages : []) {
      byId.set(message.id, message)
    }
    state.archiveMessages = sortMessages(Array.from(byId.values()))
    state.archiveMessageIds = new Set(
      state.archiveMessages.map(message => message.id),
    )
    state.archiveHasMore = view.hasMore === true
    state.archiveNextBeforeSequence =
      Number.isSafeInteger(view.nextBeforeSequence)
        ? view.nextBeforeSequence
        : null
    renderCurrentView('bottom')
  } catch (error) {
    showNotice(errorMessage(error))
  } finally {
    state.archiveLoading = false
    updateHistoryControls()
  }
}

async function refreshArchive() {
  await loadConversationDirectory().catch(error => showNotice(errorMessage(error)))
  await loadArchivePage(true)
}

async function refreshArchiveLatest() {
  if (state.archiveLoading) return
  const previous = captureScroll()
  state.archiveLoading = true
  try {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
    if (state.archiveConversationId !== '') {
      params.set('conversationId', state.archiveConversationId)
    }
    const response = await fetch(`/kanobot/api/timeline?${params}`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) {
      throw new Error(await responseMessage(response, '刷新对话档案失败'))
    }
    const view = await response.json()
    const byId = new Map(
      state.archiveMessages.map(message => [message.id, message]),
    )
    let changed = false
    for (const message of Array.isArray(view.messages) ? view.messages : []) {
      if (!byId.has(message.id)) changed = true
      byId.set(message.id, message)
    }
    if (!changed) return
    const previouslyHadMore = state.archiveHasMore
    state.archiveMessages = sortMessages(Array.from(byId.values()))
    state.archiveMessageIds = new Set(
      state.archiveMessages.map(message => message.id),
    )
    state.archiveHasMore = previouslyHadMore || view.hasMore === true
    state.archiveNextBeforeSequence = state.archiveHasMore
      ? (state.archiveMessages[0]?.sequence ?? null)
      : null
    if (state.chatView === 'archive') {
      renderCurrentView('anchor', previous)
    }
  } catch {
    // 后台刷新失败不覆盖当前档案；手动刷新仍会显示具体错误。
  } finally {
    state.archiveLoading = false
    updateHistoryControls()
  }
}

async function loadOlderMessages() {
  if (state.historyLoading) return
  if (state.chatView === 'owner' && !state.ownerHasMore) return
  if (state.chatView === 'archive' && !state.archiveHasMore) return
  state.historyLoading = true
  updateHistoryControls()
  const previous = captureScroll()
  try {
    if (state.chatView === 'owner') {
      const cursor = state.ownerNextBeforeSequence
      if (!Number.isSafeInteger(cursor)) return
      const view = await fetchConversation(cursor)
      applyOwnerPage(view, false)
      renderCurrentView('anchor', previous)
    } else {
      const cursor = state.archiveNextBeforeSequence
      if (!Number.isSafeInteger(cursor)) return
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        beforeSeq: String(cursor),
      })
      if (state.archiveConversationId !== '') {
        params.set('conversationId', state.archiveConversationId)
      }
      const response = await fetch(`/kanobot/api/timeline?${params}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) {
        throw new Error(await responseMessage(response, '读取更早对话失败'))
      }
      const view = await response.json()
      const byId = new Map(
        state.archiveMessages.map(message => [message.id, message]),
      )
      for (const message of Array.isArray(view.messages) ? view.messages : []) {
        byId.set(message.id, message)
      }
      state.archiveMessages = sortMessages(Array.from(byId.values()))
      state.archiveMessageIds = new Set(
        state.archiveMessages.map(message => message.id),
      )
      state.archiveHasMore = view.hasMore === true
      state.archiveNextBeforeSequence =
        Number.isSafeInteger(view.nextBeforeSequence)
          ? view.nextBeforeSequence
          : null
      renderCurrentView('anchor', previous)
    }
  } catch (error) {
    showNotice(errorMessage(error))
  } finally {
    state.historyLoading = false
    updateHistoryControls()
  }
}

function sortMessages(messages) {
  return [...messages].sort((left, right) => {
    const leftSequence = Number.isSafeInteger(left.sequence)
      ? left.sequence
      : Number.MAX_SAFE_INTEGER
    const rightSequence = Number.isSafeInteger(right.sequence)
      ? right.sequence
      : Number.MAX_SAFE_INTEGER
    if (leftSequence !== rightSequence) return leftSequence - rightSequence
    return Date.parse(left.createdAt) - Date.parse(right.createdAt)
  })
}

function captureScroll() {
  return {
    top: elements.messages.scrollTop,
    height: elements.messages.scrollHeight,
  }
}

function renderCurrentView(scrollMode = 'preserve', previous = null) {
  const ownerView = state.chatView === 'owner'
  elements.chatViewOwner.classList.toggle('active', ownerView)
  elements.chatViewArchive.classList.toggle('active', !ownerView)
  elements.chatViewOwner.setAttribute('aria-pressed', String(ownerView))
  elements.chatViewArchive.setAttribute('aria-pressed', String(!ownerView))
  elements.archiveControls.hidden = ownerView
  elements.form.hidden = !ownerView
  elements.composerHint.hidden = !ownerView
  elements.chatContextNote.textContent = ownerView
    ? '这里是你和她的共享会话；指定所有者 QQ 的私聊也会进入这里。'
    : '这里是跨会话只读档案；不会把这些消息合并进“我们的对话”，也不能在这里发送。'
  updateEmptyCopy()
  renderMessageList(
    ownerView ? state.ownerMessages : state.archiveMessages,
    !ownerView,
  )
  updateHistoryControls()
  updateArchiveRenameControls()
  if (scrollMode === 'bottom') {
    scrollToBottom()
  } else if (scrollMode === 'anchor' && previous !== null) {
    const delta = elements.messages.scrollHeight - previous.height
    elements.messages.scrollTop = previous.top + delta
    updateHistoryControls()
  }
}

function updateEmptyCopy() {
  const archive = state.chatView === 'archive'
  elements.emptyTitle.textContent = archive
    ? '还没有可查看的对话。'
    : '这里还没有消息。'
  if (archive) {
    elements.emptyNote.textContent =
      '所有来源的消息会按时间顺序汇总在这里；这里只读，不会改变“我们的对话”。'
    return
  }
  const model = state.model
  if (model === null) {
    elements.emptyNote.textContent = '正在读取模型状态…'
  } else if (model.mode === 'mock') {
    elements.emptyNote.textContent =
      '这是占位人格和本地 mock 回复，不会调用真实模型。'
  } else {
    elements.emptyNote.textContent =
      '这是占位人格；回复来自配置的模型路由。'
  }
}

function renderMessageList(messages, includeSource) {
  const fragment = document.createDocumentFragment()
  let currentDay = ''
  for (const message of messages) {
    const day = formatDate(message.createdAt)
    if (day !== currentDay) {
      const separator = document.createElement('div')
      separator.className = 'message-day'
      separator.dataset.day = day
      separator.textContent = formatDayLabel(message.createdAt)
      fragment.append(separator)
      currentDay = day
    }
    fragment.append(
      createMessageElement(
        message.role,
        message.text,
        message.createdAt,
        message.id,
        includeSource ? message.conversationLabel : null,
      ),
    )
  }
  elements.messages.replaceChildren(fragment)
  updateEmptyState()
}

function createMessageElement(role, text, createdAt, id, sourceLabel = null) {
  const article = document.createElement('article')
  article.className = `message ${role}`
  const day = formatDate(createdAt)
  if (day !== '') article.dataset.day = day
  if (id) article.dataset.messageId = id

  const content = document.createElement('p')
  content.className = 'message-text'
  content.textContent = text
  const meta = document.createElement('div')
  meta.className = 'message-meta'
  if (sourceLabel !== null && sourceLabel !== '') {
    const source = document.createElement('span')
    source.className = 'message-source'
    source.textContent = sourceLabel
    meta.append(source)
  }
  const time = document.createElement('span')
  time.className = 'message-time'
  time.textContent = formatTime(createdAt)
  meta.append(time)
  article.append(content, meta)
  return article
}

function updateHistoryControls() {
  const hasMore = state.chatView === 'owner'
    ? state.ownerHasMore
    : state.archiveHasMore
  const atTop = elements.messages.scrollTop <= 24
  elements.historyMore.hidden =
    !hasMore || !atTop || state.historyLoading
  elements.historyMore.disabled = state.historyLoading
  elements.historyMore.textContent = state.historyLoading
    ? '正在加载更早的消息…'
    : '加载更早的消息'
}

async function sendMessage() {
  if (state.sending) return
  const text = elements.input.value.trim()
  const image = state.image
  if (text === '' && image === null) {
    showNotice('消息不能为空。')
    return
  }
  const payload = { text }
  if (image !== null) {
    payload.images = [{ mimeType: image.mimeType, data: image.data }]
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
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      throw new Error(await responseMessage(response, '发送消息失败'))
    }
    if (!response.body) throw new Error('浏览器没有收到可读取的聊天流。')

    elements.input.value = ''
    clearImage()
    await consumeEvents(response.body, event => {
      if (event.type === 'ready') {
        hideVisionStatus()
        applyModel(event.model)
        appendMessage(
          event.userMessage.role,
          event.userMessage.text,
          event.userMessage.createdAt,
          event.userMessage.id,
        )
        assistant = appendPendingAssistant(event.recalledMemoryCount)
      } else if (event.type === 'vision') {
        showVisionStatus(
          `正在读取图片（${event.model.provider} · ${event.model.id}）…`,
        )
      } else if (event.type === 'delta') {
        if (assistant === null) throw new Error('聊天流顺序错误：缺少 ready 事件。')
        appendDelta(assistant, event.text)
      } else if (event.type === 'retry') {
        if (assistant === null) throw new Error('聊天流顺序错误：缺少重写气泡。')
        beginAssistantRetry(assistant, event)
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
        appendStyleOutcome(assistant, event.styleCheck, event.styleRetry)
        appendEnvelopeOutcome(assistant, event.envelope)
        assistant = null
        void loadMemories().catch(error => showMemoryError(errorMessage(error)))
        void loadInitiative().catch(error =>
          showInitiativeError(errorMessage(error)),
        )
      } else if (event.type === 'error') {
        throw new Error(event.message || '聊天回复失败。')
      }
    })
    if (assistant !== null) {
      throw new Error('聊天流在完成前结束了。')
    }
  } catch (error) {
    hideVisionStatus()
    if (assistant !== null) {
      assistant.classList.remove('pending')
      assistant.querySelector('.message-text').textContent ||= '回复中断。'
    }
    showNotice(errorMessage(error))
    try {
      const view = await fetchConversation()
      applyOwnerPage(view, true)
      renderCurrentView('bottom')
    } catch {
      // 初始错误已经展示，刷新失败不再覆盖它。
    }
  } finally {
    hideVisionStatus()
    state.sending = false
    elements.send.disabled = false
    updateEmptyState()
    focusComposer()
  }
}

async function setImageFile(file) {
  if (!IMAGE_TYPES.has(file.type)) {
    showNotice('图片只支持 PNG、JPEG 或 WebP。')
    return
  }
  if (file.size === 0 || file.size > state.maxImageBytes) {
    showNotice(
      `图片不能为空，且不能超过 ${formatBytes(state.maxImageBytes)}。`,
    )
    return
  }
  const dataUrl = await readFileAsDataUrl(file)
  const comma = dataUrl.indexOf(',')
  if (comma < 0 || !dataUrl.slice(0, comma).includes(';base64')) {
    showNotice('浏览器没有生成可用的图片数据。')
    return
  }
  state.image = {
    mimeType: file.type,
    data: dataUrl.slice(comma + 1),
    dataUrl,
    name: file.name || '图片',
  }
  elements.imagePreviewImg.src = dataUrl
  elements.imagePreviewName.textContent = state.image.name
  elements.imagePreview.hidden = false
}

function clearImage() {
  state.image = null
  elements.imagePreview.hidden = true
  elements.imagePreviewImg.removeAttribute('src')
  elements.imagePreviewName.textContent = ''
  elements.imageInput.value = ''
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('读取图片失败。'))
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new Error('浏览器没有返回图片数据。'))
      }
    }
    reader.readAsDataURL(file)
  })
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
  let article = existingElement
  if (article === null && id) {
    article = elements.messages.querySelector(
      `[data-message-id="${cssEscape(id)}"]`,
    )
  }
  const known = id !== null && state.ownerMessageIds.has(id)
  if (known && article !== null && article.isConnected) return article
  if (article === null) {
    article = createMessageElement(role, text, createdAt, id)
  }
  article.classList.add('message', role)
  const day = formatDate(createdAt)
  if (day !== '') article.dataset.day = day
  if (id) {
    article.dataset.messageId = id
    state.ownerMessageIds.add(id)
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
  const time = meta.querySelector('.message-time')
  if (time === null) {
    meta.replaceChildren()
    const createdTime = document.createElement('span')
    createdTime.className = 'message-time'
    createdTime.textContent = formatTime(createdAt)
    meta.append(createdTime)
  } else {
    time.textContent = formatTime(createdAt)
  }

  if (id && !known) {
    const storedText = text === ''
      ? (content?.textContent ?? '')
      : text
    const without = state.ownerMessages.filter(message => message.id !== id)
    state.ownerMessages = sortMessages([
      ...without,
      { id, role, text: storedText, createdAt },
    ])
  }

  if (!article.isConnected) {
    ensureDaySeparator(createdAt)
    elements.messages.append(article)
  }
  scrollToBottom()
  updateEmptyState()
  return article
}

function ensureDaySeparator(createdAt) {
  const day = formatDate(createdAt)
  if (day === '') return
  const last = elements.messages.lastElementChild
  if (last !== null && last.dataset.day === day) return
  const separator = document.createElement('div')
  separator.className = 'message-day'
  separator.dataset.day = day
  separator.textContent = formatDayLabel(createdAt)
  elements.messages.append(separator)
}

function appendPendingAssistant(recalledMemoryCount) {
  const article = document.createElement('article')
  article.className = 'message assistant pending'
  article.dataset.day = formatDate(new Date().toISOString())
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

function beginAssistantRetry(article, event) {
  article.classList.add('pending', 'retrying')
  const content = article.querySelector('.message-text')
  content.textContent = ''
  const labels = Array.isArray(event.initialViolationCodes)
    ? event.initialViolationCodes.join('、')
    : ''
  article.querySelector('.message-meta').textContent = labels === ''
    ? '风格检查未通过，正在重写…'
    : `风格检查未通过（${labels}），正在重写…`
}

function finishAssistant(article, message) {
  article.classList.remove('pending', 'retrying')
  article.querySelector('.message-text').textContent = message.text
  article.querySelector('.message-meta').textContent = formatTime(message.createdAt)
}

function appendMemoryOutcome(article, memory) {
  if (!memory || typeof memory !== 'object') return
  const skipped =
    Number.isInteger(memory.skippedCount) && memory.skippedCount > 0
      ? memory.skippedCount
      : 0
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
    if (skipped > 0) {
      text += `另有 ${skipped} 条候选未通过门禁或未写入。`
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

function appendStyleOutcome(article, styleCheck, styleRetry) {
  if (!styleCheck || typeof styleCheck !== 'object') return
  const messages = Array.isArray(styleCheck.violations)
    ? styleCheck.violations
        .map(violation => violation?.message)
        .filter(message => typeof message === 'string' && message !== '')
    : []
  let text = ''
  if (styleRetry?.attempted === true) {
    text = styleCheck.ok === true
      ? '风格检查未通过，已自动重写一次并通过。'
      : `风格检查未通过，已自动重写一次；当前回复仍有：${messages.join('；')}`
  } else if (styleCheck.ok === false) {
    text = messages.length > 0
      ? `风格检查提示：${messages.join('；')}`
      : '风格检查未通过。'
    if (styleRetry?.reason === 'daily_model_call_limit') {
      text += '（今日调用额度不足，未自动重写）'
    }
  }
  if (text === '') return
  const note = document.createElement('p')
  note.className = 'style-outcome'
  note.textContent = text
  article.append(note)
}

function appendEnvelopeOutcome(article, envelope) {
  if (!envelope || typeof envelope !== 'object') return
  const messages = []
  if (typeof envelope.errorCode === 'string') {
    messages.push(
      envelope.errorCode === 'chat_envelope_invalid_json'
        ? '结构化输出损坏，已保留正文但丢弃记忆和状态更新'
        : '结构化输出不完整，已保留正文但丢弃元数据',
    )
  } else if (envelope.ok === false && Array.isArray(envelope.issueCodes)) {
    const labels = []
    for (const code of envelope.issueCodes) {
      const label = envelopeIssueLabel(code)
      if (label !== '' && !labels.includes(label)) labels.push(label)
    }
    if (labels.length > 0) {
      messages.push(`部分结构化字段未写入：${labels.join('、')}`)
    }
  }
  if (
    typeof envelope.commitmentsCreated === 'number' &&
    envelope.commitmentsCreated > 0
  ) {
    messages.push(`新增 ${envelope.commitmentsCreated} 条承诺`)
  }
  if (
    typeof envelope.remindersActivated === 'number' &&
    envelope.remindersActivated > 0
  ) {
    messages.push(`已自动设置 ${envelope.remindersActivated} 条提醒`)
  }
  if (
    typeof envelope.reminderCandidatesCreated === 'number' &&
    envelope.reminderCandidatesCreated > 0
  ) {
    messages.push(
      `新增 ${envelope.reminderCandidatesCreated} 条待确认提醒`,
    )
  }
  if (
    typeof envelope.careItemsCreated === 'number' &&
    envelope.careItemsCreated > 0
  ) {
    messages.push(`新增 ${envelope.careItemsCreated} 条后续关心`)
  }
  if (messages.length === 0) return
  const note = document.createElement('p')
  note.className = 'style-outcome'
  note.textContent = messages.join('；')
  article.append(note)
}

function envelopeIssueLabel(code) {
  switch (code) {
    case 'appraisal_missing':
    case 'appraisal_invalid':
      return '心情判断无效'
    case 'appraisal_event_failed':
      return '心情状态写入失败'
    case 'memory_candidates_not_array':
    case 'memory_candidates_skipped':
      return '部分记忆候选未通过门禁'
    case 'commitments_not_array':
    case 'commitments_skipped':
    case 'commitments_not_applied':
      return '部分承诺未写入'
    case 'reminder_candidates_not_array':
    case 'reminder_candidates_skipped':
    case 'reminder_candidates_disabled':
    case 'reminder_candidates_rejected':
      return '部分提醒候选未创建'
    case 'reminder_intent_not_explicit':
      return '模型推断的提醒未创建'
    case 'reminder_candidate_duplicate':
      return '重复提醒已跳过'
    case 'reminder_activation_stopped':
      return '紧急停止阻止提醒自动生效'
    case 'reminder_confirmation_ambiguous':
      return '有多条待确认提醒，未自动选择'
    case 'reminder_confirmation_turn_ignored':
      return '确认轮里的重复提醒候选已忽略'
    case 'reminder_confirmation_failed':
      return '聊天确认提醒失败'
    case 'reminder_rejection_failed':
      return '聊天拒绝提醒失败'
    case 'care_candidates_not_array':
    case 'care_candidates_skipped':
    case 'care_candidates_disabled':
    case 'care_candidates_rejected':
      return '部分关心事项未创建'
    default:
      return ''
  }
}

function applyModel(model) {
  if (!model || typeof model.id !== 'string') return
  state.model = model
  const isMock = model.mode === 'mock'
  elements.modelBadge.textContent = isMock
    ? 'mock · 未连接真实模型'
    : `${model.provider || '模型'} · ${model.id}`
  elements.statusModel.textContent = `${model.id} (${model.mode})`
  elements.statusProvider.textContent =
    typeof model.provider === 'string' ? model.provider : model.mode
  updateEmptyCopy()
}

function applyVision(value) {
  if (!value || typeof value !== 'object') return
  state.maxImageBytes =
    Number.isSafeInteger(value.maxImageBytes) && value.maxImageBytes > 0
      ? value.maxImageBytes
      : MAX_IMAGE_BYTES
  const enabled = value.enabled === true && value.model &&
    typeof value.model.id === 'string'
  if (!enabled) {
    elements.statusVision.textContent = '未配置（只支持文字）'
    elements.imageButton.hidden = true
    clearImage()
    return
  }
  elements.statusVision.textContent =
    `${value.model.id} (${value.model.provider || value.model.mode})`
  elements.imageButton.hidden = false
}

function formatBytes(value) {
  if (value % (1024 * 1024) === 0) return `${value / (1024 * 1024)} MiB`
  return `${Math.ceil(value / 1024)} KiB`
}

function showVisionStatus(message) {
  elements.visionStatus.textContent = message
  elements.visionStatus.hidden = false
}

function hideVisionStatus() {
  elements.visionStatus.hidden = true
  elements.visionStatus.textContent = ''
}

function applyState(value) {
  if (!value) return
  elements.statusMessages.textContent = String(value.messageCount)
  elements.statusEvents.textContent = String(value.lastSequence)
  if (value.affect) {
    elements.statusAffect.textContent =
      `心情 ${formatDecimal(value.affect.valence)} · 唤醒 ${formatDecimal(value.affect.arousal)}`
  }
  if (value.relationship) {
    const repair = value.relationship.repairNeeded ? ' · 需要修复' : ''
    elements.statusRelationship.textContent =
      `亲近 ${formatDecimal(value.relationship.closeness)}` +
      ` · 受伤 ${formatDecimal(value.relationship.hurt)}${repair}`
  }
  if (value.commitments) {
    elements.statusCommitments.textContent =
      `${Number(value.commitments.open ?? 0)} 未完成 / ${Number(value.commitments.total ?? 0)}`
  }
}

function formatDecimal(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toFixed(2)
    : '—'
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
  elements.notice.textContent = message
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
  updateHistoryControls()
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

function formatDayLabel(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  if (formatDate(date.toISOString()) === formatDate(today.toISOString())) {
    return '今天'
  }
  if (formatDate(date.toISOString()) === formatDate(yesterday.toISOString())) {
    return '昨天'
  }
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(date)
}

function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value)
  }
  return String(value).replace(/["\\]/g, '\\$&')
}

async function loadInitiative() {
  const response = await fetch('/kanobot/api/initiative', {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (response.status === 404) {
    renderInitiativeUnavailable()
    return null
  }
  if (!response.ok) {
    throw new Error(await responseMessage(response, '读取主动性状态失败'))
  }
  const view = await response.json()
  applyInitiative(view)
  hideInitiativeError()
  return view
}

function applyInitiative(view) {
  if (!view || typeof view !== 'object') return
  state.initiative = view
  elements.initiativeEnabled.textContent =
    view.enabled === true ? '已开启，可偶尔主动联系' : '已关闭'
  elements.initiativeQuiet.textContent =
    view.quietNow === true ? '当前安静，不主动打扰' : '当前可主动联系'
  elements.initiativeLast.textContent =
    view.lastProactiveAt === null
      ? '还没有主动说过话'
      : formatDateTime(view.lastProactiveAt)
  elements.initiativeNext.textContent =
    view.nextProactiveAt === null
      ? '尚未安排'
      : formatDateTime(view.nextProactiveAt)
  elements.initiativeUnanswered.textContent =
    `${Number(view.consecutiveUnanswered) || 0} 条`
  elements.initiativeWindow.textContent =
    `${Number(view.circuit?.recentMessageCount) || 0} 条主动消息`

  const circuitOpen = view.circuit?.open === true
  elements.circuitWarning.hidden = !circuitOpen
  if (circuitOpen) {
    elements.circuitText.textContent =
      `短时间主动消息偏多，已在 ${formatDateTime(view.circuit.openedAt)} 暂停。` +
      '你可以等她安静一会儿，或确认后手动恢复。'
  }

  renderPlan(view.plan)
  const candidates = Array.isArray(view.reminderCandidates)
    ? view.reminderCandidates
    : []
  const reminders = Array.isArray(view.reminders) ? view.reminders : []
  const careItems = Array.isArray(view.careItems) ? view.careItems : []
  const summaries = Array.isArray(view.summaries) ? view.summaries : []
  renderReminderCandidates(candidates)
  renderReminders(reminders)
  renderCareItems(careItems)
  renderSummaries(summaries)

  const pendingCare = careItems.filter(item => item.status === 'pending').length
  const activeReminders = reminders.filter(reminder =>
    reminder.status === 'confirmed' || reminder.status === 'queued',
  ).length
  elements.initiativeBadge.textContent = String(
    candidates.filter(candidate => candidate.status === 'pending').length +
      activeReminders +
      pendingCare,
  )
}

function renderInitiativeUnavailable() {
  state.initiative = null
  elements.initiativeBadge.textContent = '0'
  elements.initiativeEnabled.textContent = '当前插件未启用'
  elements.initiativeQuiet.textContent = '—'
  elements.initiativeLast.textContent = '—'
  elements.initiativeNext.textContent = '—'
  elements.initiativeUnanswered.textContent = '—'
  elements.initiativeWindow.textContent = '—'
  elements.circuitWarning.hidden = true
  elements.planList.replaceChildren()
  elements.reminderCandidateList.replaceChildren()
  elements.reminderList.replaceChildren()
  elements.careList.replaceChildren()
  elements.summaryList.replaceChildren()
  elements.planEmpty.hidden = false
  elements.planEmpty.textContent = '当前插件没有提供主动性数据。'
  elements.reminderCandidateEmpty.hidden = false
  elements.reminderEmpty.hidden = false
  elements.careEmpty.hidden = false
  elements.summaryEmpty.hidden = false
}

function renderPlan(plan) {
  elements.planList.replaceChildren()
  if (!plan || !Array.isArray(plan.items) || plan.items.length === 0) {
    elements.planEmpty.hidden = false
    elements.planEmpty.textContent = '今天还没有生成计划。'
    return
  }
  elements.planEmpty.hidden = true
  for (const item of plan.items) {
    elements.planList.append(initiativeItem({
      text: String(item.title ?? ''),
      chips: [
        planKindLabel(item.kind),
        `${formatClock(item.startsAt)}–${formatClock(item.endsAt)}`,
        planStatusLabel(item.status),
      ],
      pending: item.status === 'active',
    }))
  }
}

function renderReminderCandidates(candidates) {
  elements.reminderCandidateList.replaceChildren()
  if (candidates.length === 0) {
    elements.reminderCandidateEmpty.hidden = false
    return
  }
  elements.reminderCandidateEmpty.hidden = true
  for (const candidate of candidates) {
    elements.reminderCandidateList.append(initiativeItem({
      text: String(candidate.text ?? ''),
      chips: [`提醒时间 ${formatDateTime(candidate.dueAt)}`],
      pending: candidate.status === 'pending',
      actions: candidate.status === 'pending'
        ? [
            actionButton('确认', 'confirm-reminder', candidate.id, false),
            actionButton('拒绝', 'reject-reminder', candidate.id, true),
          ]
        : [],
    }))
  }
}

function renderReminders(reminders) {
  elements.reminderList.replaceChildren()
  if (reminders.length === 0) {
    elements.reminderEmpty.hidden = false
    return
  }
  elements.reminderEmpty.hidden = true
  const current = reminders.filter(reminder =>
    reminder.status === 'confirmed' || reminder.status === 'queued',
  )
  const history = reminders.filter(reminder =>
    reminder.status !== 'confirmed' && reminder.status !== 'queued',
  )
  appendReminderGroup('当前提醒', current, '没有等待中的提醒。')
  appendReminderGroup('历史提醒', history, '还没有已送达、取消或失败的提醒。')
}

function appendReminderGroup(label, reminders, emptyText) {
  const heading = document.createElement('p')
  heading.className = 'initiative-group-label'
  heading.textContent = label
  elements.reminderList.append(heading)
  if (reminders.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'initiative-group-empty'
    empty.textContent = emptyText
    elements.reminderList.append(empty)
    return
  }
  for (const reminder of reminders) {
    const cancellable =
      reminder.status === 'confirmed' || reminder.status === 'queued'
    const chips = [
      `时间 ${formatDateTime(reminder.dueAt)}`,
      reminderStatusLabel(reminder.status),
    ]
    if (reminder.deliveredAt !== null) {
      chips.push(`送达 ${formatDateTime(reminder.deliveredAt)}`)
    }
    elements.reminderList.append(initiativeItem({
      text: String(reminder.text ?? ''),
      chips,
      pending: reminder.status === 'confirmed' || reminder.status === 'queued',
      actions: cancellable
        ? [actionButton('取消', 'cancel-reminder', reminder.id, true)]
        : [],
    }))
  }
}

function renderCareItems(items) {
  elements.careList.replaceChildren()
  if (items.length === 0) {
    elements.careEmpty.hidden = false
    return
  }
  elements.careEmpty.hidden = true
  for (const item of items) {
    elements.careList.append(initiativeItem({
      text: String(item.text ?? ''),
      chips: [
        `关心窗口 ${formatDateTime(item.dueFrom)}–${formatDateTime(item.dueUntil)}`,
        careStatusLabel(item.status),
      ],
      pending: item.status === 'pending' || item.status === 'queued',
    }))
  }
}

function renderSummaries(summaries) {
  elements.summaryList.replaceChildren()
  if (summaries.length === 0) {
    elements.summaryEmpty.hidden = false
    return
  }
  elements.summaryEmpty.hidden = true
  for (const summary of summaries) {
    const details = document.createElement('details')
    details.className = 'initiative-item summary-item'
    const heading = document.createElement('summary')
    heading.textContent =
      `${summary.localDay} · ${formatDateTime(summary.createdAt)}`
    const body = document.createElement('p')
    body.textContent = String(summary.summary ?? '')
    details.append(heading, body)
    if (Array.isArray(summary.sourceMessageIds)) {
      const meta = document.createElement('div')
      meta.className = 'initiative-item-meta'
      meta.append(chip(`来源 ${summary.sourceMessageIds.length} 条消息`))
      details.append(meta)
    }
    elements.summaryList.append(details)
  }
}

function initiativeItem({ text, chips, actions = [], pending = false }) {
  const article = document.createElement('article')
  article.className = pending ? 'initiative-item pending' : 'initiative-item'
  const body = document.createElement('p')
  body.className = 'initiative-item-text'
  body.textContent = text
  article.append(body)
  if (chips.length > 0) {
    const meta = document.createElement('div')
    meta.className = 'initiative-item-meta'
    for (const label of chips) meta.append(chip(label))
    article.append(meta)
  }
  if (actions.length > 0) {
    const controls = document.createElement('div')
    controls.className = 'initiative-item-actions'
    controls.append(...actions)
    article.append(controls)
  }
  return article
}

function formatClock(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function planKindLabel(value) {
  switch (value) {
    case 'reading':
      return '阅读'
    case 'movie':
      return '观影'
    case 'simulation':
      return '模拟生活'
    case 'study':
      return '学习'
    case 'resting':
      return '休息'
    case 'walk':
      return '散步'
    case 'music':
      return '听音乐'
    default:
      return '日常'
  }
}

function planStatusLabel(value) {
  switch (value) {
    case 'active':
      return '进行中'
    case 'completed':
      return '已完成'
    case 'skipped':
      return '已跳过'
    default:
      return '待进行'
  }
}

function reminderStatusLabel(value) {
  switch (value) {
    case 'confirmed':
      return '已确认'
    case 'queued':
      return '发送队列中'
    case 'delivered':
      return '已送达'
    case 'cancelled':
      return '已取消'
    case 'failed':
      return '发送失败'
    default:
      return '未知状态'
  }
}

function careStatusLabel(value) {
  switch (value) {
    case 'pending':
      return '等待合适时机'
    case 'queued':
      return '准备关心'
    case 'delivered':
      return '已经关心过'
    case 'dismissed':
      return '已忽略'
    case 'expired':
      return '窗口已过'
    default:
      return '未知状态'
  }
}

function updateNotificationControls() {
  if (!('Notification' in window)) {
    elements.notificationEnable.disabled = true
    elements.notificationEnable.textContent = '不支持通知'
    showNotificationStatus('这个浏览器不支持桌面通知；页面内仍会显示新消息。')
    return
  }
  switch (Notification.permission) {
    case 'granted':
      elements.notificationEnable.disabled = true
      elements.notificationEnable.textContent = '通知已开启'
      showNotificationStatus('页面在后台时，她主动发来的新消息会弹出桌面通知。')
      break
    case 'denied':
      elements.notificationEnable.disabled = true
      elements.notificationEnable.textContent = '通知被阻止'
      showNotificationStatus('浏览器已阻止通知，请在站点权限中恢复。')
      break
    default:
      elements.notificationEnable.disabled = false
      elements.notificationEnable.textContent = '开启通知'
      showNotificationStatus('开启后，页面在后台时也能收到她的主动消息提醒。')
  }
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) return
  try {
    await Notification.requestPermission()
  } finally {
    updateNotificationControls()
  }
}

function showNotificationStatus(message) {
  elements.notificationStatus.textContent = message
  elements.notificationStatus.hidden = false
}

function notifyProactiveMessage(message) {
  if (!('Notification' in window)) return
  if (Notification.permission !== 'granted') return
  if (document.visibilityState === 'visible') return
  const text = String(message.text ?? '').replace(/\s+/g, ' ').trim()
  const body = Array.from(text).slice(0, 120).join('')
  const notification = new Notification('她发来一条消息', {
    body: body === '' ? '打开 Rinkobot 看看。' : body,
    tag: `kanobot-${message.id}`,
  })
  notification.onclick = () => {
    window.focus()
    switchTab('status')
    notification.close()
  }
}

async function runInitiativeAction(action, id, label) {
  let path = ''
  let confirmation = ''
  if (action === 'confirm-reminder') {
    path =
      `/kanobot/api/initiative/reminder-candidates/${encodeURIComponent(id)}/confirm`
    confirmation = `确认这条提醒？\n${label}`
  } else if (action === 'reject-reminder') {
    path =
      `/kanobot/api/initiative/reminder-candidates/${encodeURIComponent(id)}/reject`
  } else if (action === 'cancel-reminder') {
    path = `/kanobot/api/initiative/reminders/${encodeURIComponent(id)}`
    confirmation = '取消这条提醒？'
  } else if (action === 'reset-circuit') {
    path = '/kanobot/api/initiative/circuit/reset'
    confirmation = '恢复主动消息？之后的间隔仍受冷却和安静时段限制。'
  } else {
    return
  }
  if (confirmation !== '' && !window.confirm(confirmation)) return
  elements.initiativeError.hidden = true
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ confirm: true }),
  })
  if (!response.ok) {
    throw new Error(await responseMessage(response, '主动性操作失败'))
  }
  const payload = await response.json()
  if (payload?.initiative && typeof payload.initiative === 'object') {
    applyInitiative(payload.initiative)
  } else {
    await loadInitiative()
  }
  hideInitiativeError()
}

function showInitiativeError(message) {
  elements.initiativeError.textContent = message
  elements.initiativeError.hidden = false
}

function hideInitiativeError() {
  elements.initiativeError.hidden = true
}

async function loadControl() {
  const response = await fetch('/kanobot/api/control', {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (response.status === 404) {
    elements.controlBadge.textContent = '控制未启用'
    elements.emergencyState.textContent = '当前插件没有提供紧急控制接口。'
    elements.emergencyNote.textContent = '请联系维护者检查插件版本。'
    elements.emergencyButton.disabled = true
    return
  }
  if (!response.ok) {
    throw new Error(await responseMessage(response, '读取控制状态失败'))
  }
  const payload = await response.json()
  applyControl(payload?.emergency)
}

function applyControl(emergency) {
  if (!emergency || typeof emergency !== 'object') return
  state.emergency = emergency
  const stopped = emergency.stopped === true
  elements.controlBadge.textContent = stopped ? '已停止' : '运行中'
  elements.controlBadge.classList.toggle('control-stopped', stopped)
  elements.controlBadge.classList.toggle('control-running', !stopped)
  elements.emergencyState.textContent = stopped
    ? `自主活动已停止（${emergency.reasonCode}）`
    : '运行中：自主活动开关未触发'
  elements.emergencyNote.textContent = stopped
    ? '你主动发来的消息仍会得到回复；恢复必须由你手动操作。'
    : '停止会阻止未来的自主活动；你主动发来的消息仍然可以回复。'
  elements.emergencyButton.disabled = false
  elements.emergencyButton.textContent = stopped ? '恢复运行' : '紧急停止'
  elements.emergencyButton.classList.toggle('danger-button--resume', stopped)
}

async function toggleEmergency() {
  const stopped = state.emergency?.stopped === true
  const question = stopped
    ? '恢复自主活动？请确认 STOP 文件或停止原因已经处理。'
    : '紧急停止所有自主活动？你主动发来的聊天仍可继续。'
  if (!window.confirm(question)) return

  elements.emergencyButton.disabled = true
  try {
    const response = await fetch(
      stopped
        ? '/kanobot/api/emergency/resume'
        : '/kanobot/api/emergency/stop',
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ confirm: true }),
      },
    )
    if (!response.ok) {
      throw new Error(await responseMessage(response, '切换紧急停止失败'))
    }
    const payload = await response.json()
    applyControl(payload?.emergency)
    await loadAudit()
  } finally {
    elements.emergencyButton.disabled = false
  }
}

async function loadAudit() {
  const params = new URLSearchParams({
    limit: '100',
    source: state.auditSource,
  })
  const response = await fetch(`/kanobot/api/audit?${params}`, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (response.status === 404) {
    elements.auditList.replaceChildren()
    elements.auditEmpty.hidden = false
    elements.auditEmpty.textContent = '当前插件没有提供审计接口。'
    elements.auditMore.hidden = true
    return
  }
  if (!response.ok) {
    throw new Error(await responseMessage(response, '读取审计记录失败'))
  }
  const payload = await response.json()
  state.auditEntries = Array.isArray(payload.timeline) ? payload.timeline : []
  state.auditVisible = 50
  renderAudit()
  hideAuditError()
}

function renderAudit() {
  elements.auditList.replaceChildren()
  elements.auditBadge.textContent = String(state.auditEntries.length)
  if (state.auditEntries.length === 0) {
    elements.auditMore.hidden = true
    elements.auditEmpty.hidden = false
    elements.auditEmpty.textContent = state.auditSource === 'all'
      ? '还没有审计记录。'
      : '这个来源还没有审计记录。'
    return
  }
  elements.auditEmpty.hidden = true
  const fragment = document.createDocumentFragment()
  const visible = state.auditEntries.slice(0, state.auditVisible)
  for (const entry of visible) {
    const article = document.createElement('article')
    article.className = 'audit-item'

    const heading = document.createElement('p')
    heading.className = 'audit-action'
    heading.textContent = auditEntryTitle(entry)
    article.append(heading)

    const meta = document.createElement('div')
    meta.className = 'audit-meta'
    meta.append(
      chip(auditSourceLabel(entry.source), `audit-source-${entry.source}`),
      chip(auditOutcomeLabel(entry.outcome), `audit-${entry.outcome}`),
      chip(formatDateTime(entry.occurredAt)),
    )
    article.append(meta)

    const target = document.createElement('p')
    target.className = 'audit-target'
    target.textContent = auditEntryDetail(entry)
    article.append(target)
    fragment.append(article)
  }
  elements.auditList.append(fragment)
  elements.auditMore.hidden = state.auditVisible >= state.auditEntries.length
}

function auditEntryTitle(entry) {
  if (entry.source === 'owner') return auditActionLabel(entry.kind)
  if (entry.source === 'memory') {
    return entry.kind === 'memory.decision' ? '记忆边界决策' : '记忆记录'
  }
  if (entry.source === 'model') return '模型调用'
  if (entry.source === 'style') return '回复风格检查'
  if (entry.source === 'chat') return '聊天回合'
  if (entry.source === 'channel') {
    return entry.channel?.direction === 'outbound'
      ? '渠道发送'
      : '渠道接收'
  }
  return String(entry.kind ?? '审计事件')
}

function auditSourceLabel(value) {
  switch (value) {
    case 'owner':
      return '所有者'
    case 'memory':
      return '记忆'
    case 'model':
      return '模型'
    case 'style':
      return '风格'
    case 'chat':
      return '聊天'
    case 'channel':
      return '渠道'
    default:
      return '未知来源'
  }
}

function auditEntryDetail(entry) {
  if (entry.source === 'owner') {
    return `对象：${entry.targetId ?? '—'}` +
      (entry.detailCode ? ` · ${entry.detailCode}` : '')
  }
  if (entry.source === 'memory') {
    if (entry.memoryDecision) {
      const decision = entry.memoryDecision
      return `动作 ${memoryDecisionActionLabel(decision.action)}` +
        ` · 原因 ${decision.reasonCode}` +
        ` · 来源 ${memoryDecisionSourceLabel(decision.source)}` +
        ` · 对象 ${entry.targetId ?? '—'}`
    }
    const memory = entry.memory
    if (!memory) return `记忆：${entry.targetId ?? '—'}`
    return `记忆：${memory.memoryId} · ${kindLabel(memory.kind)}` +
      ` · ${importanceLabel(memory.importance)}` +
      ` · ${sensitivityLabel(memory.sensitivity)}` +
      ` · ${sourceLabel(memory.source)} · 状态 ${memory.status}`
  }
  if (entry.source === 'model') {
    const call = entry.modelCall
    if (!call) return `调用：${entry.targetId ?? '—'}`
    const tokens = call.inputTokens === null || call.outputTokens === null
      ? 'Token —'
      : `Token 入 ${formatCount(call.inputTokens)} / 出 ${formatCount(call.outputTokens)}`
    const cost = typeof call.estimatedCost === 'number'
      ? ` · ${formatCost(call.estimatedCost)}（未标币种）`
      : ''
    return `${call.provider} · ${call.model} · ${call.purpose}` +
      ` · ${call.attempts} 次请求 · ${tokens}${cost}` +
      (entry.detailCode ? ` · ${entry.detailCode}` : '')
  }
  if (entry.source === 'style') {
    const style = entry.style
    if (!style) return `消息：${entry.targetId ?? '—'}`
    const retry = style.retryCount === 1
      ? ` · 自动重写 1 次（初次：${style.initialViolationCodes.join('、') || '—'}）`
      : ''
    const violations = style.violationCodes.length > 0
      ? ` · 最终违规：${style.violationCodes.join('、')}`
      : ' · 通过'
    return `助手消息：${style.assistantMessageId}${violations}${retry}`
  }
  if (entry.source === 'chat') {
    const turn = entry.chat
    if (!turn) return `助手消息：${entry.targetId ?? '—'}`
    const style = turn.styleOk === null
      ? '风格未记录'
      : turn.styleOk ? '风格通过' : `风格未通过：${turn.violationCodes.join('、')}`
    const retry = turn.retryCount === 1 ? ' · 自动重写 1 次' : ''
    return `会话 ${turn.conversationId} · 助手消息 ${entry.targetId}` +
      ` · ${turn.succeededModelCallCount}/${turn.modelCallCount} 次调用成功` +
      ` · ${style}${retry}`
  }
  if (entry.source === 'channel') {
    const kind = entry.channel?.kind ?? entry.kind
    return `渠道事件 ${kind}` +
      (entry.targetId ? ` · 对象 ${entry.targetId}` : '') +
      (entry.detailCode ? ` · ${entry.detailCode}` : '')
  }
  return entry.targetId === null
    ? String(entry.kind ?? '')
    : `对象：${entry.targetId}`
}

function memoryDecisionActionLabel(value) {
  switch (value) {
    case 'retained':
      return '保留'
    case 'suppressed':
      return '抑制'
    case 'extracted':
      return '抽取稳定事实'
    case 'archived':
      return '冷却归档'
    case 'restored':
      return '恢复'
    default:
      return String(value ?? '未知')
  }
}

function memoryDecisionSourceLabel(value) {
  switch (value) {
    case 'chat_candidate':
      return '聊天候选'
    case 'explicit_fallback':
      return '明确记住兜底'
    case 'cooling':
      return '记忆冷却'
    case 'owner':
      return '所有者'
    default:
      return String(value ?? '未知')
  }
}

function auditActionLabel(value) {
  switch (value) {
    case 'memory.create':
      return '新增记忆'
    case 'memory.correct':
      return '纠正记忆'
    case 'memory.promote':
      return '候选转正'
    case 'memory.trash':
      return '移入回收站'
    case 'memory.restore':
      return '恢复记忆'
    case 'memory.purge':
      return '彻底清除记忆'
    case 'emergency.stop':
      return '紧急停止'
    case 'emergency.resume':
      return '恢复运行'
    default:
      return String(value ?? '未知操作')
  }
}

function auditTargetLabel(value) {
  return value === 'system' ? '系统' : '记忆'
}

function auditOutcomeLabel(value) {
  switch (value) {
    case 'failed':
      return '失败'
    case 'aborted':
      return '已中止'
    case 'unknown':
      return '结果未知'
    case 'running':
      return '进行中'
    case 'info':
      return '记录'
    default:
      return '成功'
  }
}

function formatDateTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function showAuditError(message) {
  elements.auditError.textContent = message
  elements.auditError.hidden = false
}

function hideAuditError() {
  elements.auditError.hidden = true
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

/* ------------------------------ 模型设置 ------------------------------ */

async function loadModelSettings() {
  const response = await fetch('/kanobot/api/settings/models', {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (response.status === 404) {
    state.modelSettings = null
    updateSettingsButtons()
    showSettingsError('当前安装没有启用模型设置接口。')
    return null
  }
  if (!response.ok) {
    throw new Error(await responseMessage(response, '读取模型设置失败'))
  }
  const view = await response.json()
  applyModelSettings(view)
  hideSettingsError()
  return view
}

function applyModelSettings(view) {
  if (!view || typeof view !== 'object') {
    throw new Error('模型设置响应格式不正确')
  }
  state.modelSettings = view
  clearDiscovery()
  const chat = view.chat ?? {}
  const vision = view.vision ?? {}

  setSelectValue(elements.settingsChatProvider, chat.provider ?? 'mock')
  elements.settingsChatName.value = chat.name ?? ''
  elements.settingsChatBaseUrl.value = chat.baseUrl ?? ''
  elements.settingsChatTimeout.value = String(chat.timeoutMs ?? 120_000)
  elements.settingsChatRetries.value = String(chat.maxRetries ?? 2)
  elements.settingsChatMaxOutput.value =
    chat.maxOutputTokens === null || chat.maxOutputTokens === undefined
      ? ''
      : String(chat.maxOutputTokens)
  elements.settingsChatReasoning.value = chat.reasoningEffort ?? ''
  elements.settingsChatPrivate.checked = chat.allowPrivateNetwork === true
  elements.settingsChatCredentialMode.value = 'keep'
  elements.settingsChatEnv.value = ''
  elements.settingsChatSecret.value = ''
  elements.settingsChatCredentialStatus.textContent =
    credentialStatusText(chat.credential)

  elements.settingsVisionEnabled.checked = vision.enabled === true
  setSelectValue(
    elements.settingsVisionProvider,
    vision.provider ?? 'magpie',
  )
  elements.settingsVisionName.value = vision.name ?? ''
  elements.settingsVisionBaseUrl.value = vision.baseUrl ?? ''
  elements.settingsVisionTimeout.value = String(vision.timeoutMs ?? 120_000)
  elements.settingsVisionRetries.value = String(vision.maxRetries ?? 2)
  elements.settingsVisionMaxOutput.value =
    vision.maxOutputTokens === null || vision.maxOutputTokens === undefined
      ? ''
      : String(vision.maxOutputTokens)
  elements.settingsVisionImageBytes.value = String(
    vision.maxImageBytes ?? 5 * 1024 * 1024,
  )
  elements.settingsVisionDescriptionChars.value = String(
    vision.maxDescriptionChars ?? 2_000,
  )
  elements.settingsVisionPrivate.checked =
    vision.allowPrivateNetwork === true
  elements.settingsVisionCredentialMode.value = 'keep'
  elements.settingsVisionEnv.value = ''
  elements.settingsVisionSecret.value = ''
  elements.settingsVisionCredentialStatus.textContent =
    credentialStatusText(vision.credential)

  elements.settingsReadOnly.hidden = view.readOnly !== true
  elements.settingsStatus.hidden = true
  syncSettingsForm()
  updateSettingsButtons()
}

function syncSettingsForm() {
  const chatProvider = elements.settingsChatProvider.value
  const chatIsMock = chatProvider === 'mock'
  const chatNeedsEndpoint = !chatIsMock
  const chatUsesProjectCredential = !chatIsMock

  elements.settingsChatBaseField.hidden = !chatNeedsEndpoint
  elements.settingsChatBaseUrl.disabled = !chatNeedsEndpoint
  elements.settingsChatBaseUrl.required = chatNeedsEndpoint
  elements.settingsChatMaxOutput.required = !chatIsMock
  elements.settingsChatReasoning.disabled = chatIsMock
  elements.settingsChatPrivate.disabled = chatProvider !== 'openai-compatible'
  elements.settingsChatCredentialMode.disabled = !chatUsesProjectCredential
  if (!chatUsesProjectCredential) {
    elements.settingsChatCredentialMode.value = 'none'
  }

  const visionEnabled = elements.settingsVisionEnabled.checked
  elements.settingsVisionFields.hidden = !visionEnabled
  for (const element of [
    elements.settingsVisionProvider,
    elements.settingsVisionName,
    elements.settingsVisionBaseUrl,
    elements.settingsVisionTimeout,
    elements.settingsVisionRetries,
    elements.settingsVisionMaxOutput,
    elements.settingsVisionImageBytes,
    elements.settingsVisionDescriptionChars,
    elements.settingsVisionPrivate,
  ]) {
    element.disabled = !visionEnabled
  }
  elements.settingsVisionName.required = visionEnabled
  elements.settingsVisionBaseUrl.required = visionEnabled
  elements.settingsVisionMaxOutput.required = visionEnabled
  elements.settingsVisionTimeout.required = visionEnabled
  elements.settingsVisionRetries.required = visionEnabled
  elements.settingsVisionImageBytes.required = visionEnabled
  elements.settingsVisionDescriptionChars.required = visionEnabled
  elements.settingsVisionCredentialMode.disabled = !visionEnabled
  if (!visionEnabled) {
    elements.settingsVisionCredentialMode.value = 'keep'
  } else if (elements.settingsVisionProvider.value === '') {
    elements.settingsVisionProvider.value = 'magpie'
  }

  syncCredentialFields('chat')
  syncCredentialFields('vision')
  renderDiscoveryOptions()
  updateSettingsButtons()
}

function syncCredentialFields(prefix) {
  const mode = elements[`settings${capitalize(prefix)}CredentialMode`]
  const envField = elements[`settings${capitalize(prefix)}EnvField`]
  const env = elements[`settings${capitalize(prefix)}Env`]
  const secretField = elements[`settings${capitalize(prefix)}SecretField`]
  const secret = elements[`settings${capitalize(prefix)}Secret`]
  const disabled = mode.disabled
  const environmentMode = !disabled && mode.value === 'environment'
  const secretMode = !disabled && mode.value === 'new'
  envField.hidden = !environmentMode
  env.disabled = !environmentMode
  env.required = environmentMode
  secretField.hidden = !secretMode
  secret.disabled = !secretMode
  secret.required = secretMode
}

function credentialStatusText(credential) {
  if (!credential || typeof credential !== 'object') {
    return '凭据状态未知'
  }
  if (credential.mode === 'environment') {
    return `使用环境变量：${credential.environmentName ?? '（未命名）'}`
  }
  if (credential.mode === 'local-secret') {
    return credential.configured === true
      ? `使用本地加密密钥：${credential.label ?? '已保存'}`
      : '本地密钥不可用，请重新填写或改用环境变量'
  }
  return '未配置 API key'
}

async function discoverModels() {
  if (state.settingsBusy) return
  setSettingsBusy(true)
  hideSettingsError()
  try {
    const result = await modelSettingsRequest(
      'POST',
      '/kanobot/api/settings/models/discover',
      buildModelDiscoveryDraft(),
    )
    state.discovery = result
    state.chatModelsExpanded = false
    state.visionSupportedExpanded = false
    state.visionUnknownExpanded = false
    renderDiscoveryOptions()
    const chatCount = Array.isArray(result.chat?.models)
      ? result.chat.models.length
      : 0
    const visionCount =
      (Array.isArray(result.vision?.supported)
        ? result.vision.supported.length
        : 0) +
      (Array.isArray(result.vision?.unknown)
        ? result.vision.unknown.length
        : 0)
    const mockHint =
      result.chat?.provider === 'mock'
        ? '；mock 是本地测试模型，不使用远程模型列表'
        : ''
    showSettingsStatus(
      `模型发现完成：聊天 ${chatCount} 个` +
      `${result.vision?.enabled === true ? `，视觉 ${visionCount} 个` : ''}` +
      `${mockHint}。发现结果不会保存配置。`,
    )
  } catch (error) {
    showSettingsError(errorMessage(error))
  } finally {
    setSettingsBusy(false)
  }
}

function renderDiscoveryOptions() {
  const discovery = state.discovery
  const chatProvider = elements.settingsChatProvider.value
  const chatDiscovery =
    discovery?.chat?.provider === chatProvider ? discovery.chat : null
  const chatModels = Array.isArray(chatDiscovery?.models)
    ? chatDiscovery.models
    : []
  const visionEnabled = elements.settingsVisionEnabled.checked
  const visionDiscovery =
    visionEnabled &&
    discovery?.vision?.enabled === true &&
    discovery.vision.provider === elements.settingsVisionProvider.value
      ? discovery.vision
      : null
  const visionSupported = Array.isArray(visionDiscovery?.supported)
    ? visionDiscovery.supported
    : []
  const visionUnknown = Array.isArray(visionDiscovery?.unknown)
    ? visionDiscovery.unknown
    : []

  elements.settingsChatDiscovery.hidden = chatDiscovery === null
  if (chatDiscovery === null) {
    elements.settingsChatModelSection.hidden = true
    elements.settingsChatModelChips.replaceChildren()
  } else {
    elements.settingsChatDiscoverySummary.textContent = [
      `Provider：${chatProvider}`,
      chatModels.length > 0 ? `${chatModels.length} 个模型` : null,
    ].filter(Boolean).join(' · ')

    elements.settingsChatModelSection.hidden = false
    const visible = renderModelChoices(
      elements.settingsChatModelChips,
      chatModels,
      {
        selectedId: elements.settingsChatName.value.trim(),
        includeImage: false,
        group: 'chat',
        expanded: state.chatModelsExpanded,
      },
    )
    elements.settingsChatModelCount.textContent = `${chatModels.length} 个`
    updateMoreButton(
      elements.settingsChatModelMore,
      chatModels.length,
      visible,
      state.chatModelsExpanded,
      '个模型',
    )
    elements.settingsChatModelNote.hidden = false
    elements.settingsChatModelNote.textContent =
      chatModels.length > 0
        ? '点选模型会填入上方“精确模型名”；也可以手动修改。'
        : chatProvider === 'mock'
          ? 'mock 是本地测试模型，不需要获取远程模型列表。'
          : '没有发现模型；请检查 Base URL、凭据，或手动输入精确模型名。'
  }

  elements.settingsVisionDiscovery.hidden = visionDiscovery === null
  if (visionDiscovery === null) {
    elements.settingsVisionSupportedSection.hidden = true
    elements.settingsVisionUnknownSection.hidden = true
    elements.settingsVisionSupportedChips.replaceChildren()
    elements.settingsVisionUnknownChips.replaceChildren()
    elements.settingsVisionSupportedMore.hidden = true
    elements.settingsVisionUnknownMore.hidden = true
    elements.settingsVisionEmptyNote.hidden = true
  } else {
    const visionTotal = visionSupported.length + visionUnknown.length
    elements.settingsVisionDiscoverySummary.textContent =
      `Provider：${visionDiscovery.provider ?? elements.settingsVisionProvider.value}` +
      ` · 明确支持 ${visionSupported.length} 个` +
      ` · 能力未知 ${visionUnknown.length} 个`

    elements.settingsVisionSupportedSection.hidden =
      visionSupported.length === 0
    elements.settingsVisionSupportedCount.textContent =
      visionSupported.length === 0 ? '' : `${visionSupported.length} 个`
    const supportedVisible = renderModelChoices(
      elements.settingsVisionSupportedChips,
      visionSupported,
      {
        selectedId: elements.settingsVisionName.value.trim(),
        includeImage: true,
        group: 'supported',
        expanded: state.visionSupportedExpanded,
      },
    )
    updateMoreButton(
      elements.settingsVisionSupportedMore,
      visionSupported.length,
      supportedVisible,
      state.visionSupportedExpanded,
      '个模型',
    )

    elements.settingsVisionUnknownSection.hidden = visionUnknown.length === 0
    elements.settingsVisionUnknownCount.textContent =
      visionUnknown.length === 0 ? '' : `${visionUnknown.length} 个`
    const unknownVisible = renderModelChoices(
      elements.settingsVisionUnknownChips,
      visionUnknown,
      {
        selectedId: elements.settingsVisionName.value.trim(),
        includeImage: true,
        group: 'unknown',
        expanded: state.visionUnknownExpanded,
      },
    )
    updateMoreButton(
      elements.settingsVisionUnknownMore,
      visionUnknown.length,
      unknownVisible,
      state.visionUnknownExpanded,
      '个模型',
    )

    elements.settingsVisionEmptyNote.hidden = visionTotal !== 0
    elements.settingsVisionEmptyNote.textContent =
      visionTotal === 0
        ? '没有发现可用的视觉模型；可以手动输入精确模型名，保存前仍会测试图片能力。'
        : ''
  }
}

function renderModelChoices(container, models, options) {
  container.replaceChildren()
  const visibleCount = options.expanded
    ? models.length
    : Math.min(models.length, MODEL_CHOICE_LIMIT)
  for (const model of models.slice(0, visibleCount)) {
    const button = createModelChoiceButton({
      label: model.id,
      meta: discoveredModelMeta(model, options.includeImage, options.group),
      selected: model.id === options.selectedId,
      dataName: 'modelId',
      value: model.id,
    })
    button.dataset.modelGroup = options.group
    container.append(button)
  }
  return visibleCount
}

function createModelChoiceButton({ label, meta, selected, dataName, value }) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'model-choice'
  button.setAttribute('aria-pressed', selected ? 'true' : 'false')
  button.title = value
  button.dataset[dataName] = value

  const mark = document.createElement('span')
  mark.className = 'model-choice-mark'
  mark.setAttribute('aria-hidden', 'true')
  mark.textContent = '✓'

  const text = document.createElement('span')
  text.className = 'model-choice-text'
  const id = document.createElement('span')
  id.className = 'model-choice-id'
  id.textContent = label
  text.append(id)
  if (meta !== '') {
    const detail = document.createElement('span')
    detail.className = 'model-choice-meta'
    detail.textContent = meta
    text.append(detail)
  }

  button.append(mark, text)
  return button
}

function updateMoreButton(button, total, visible, expanded, suffix) {
  const remaining = Math.max(0, total - visible)
  button.hidden = expanded || remaining === 0
  button.textContent = `显示其余 ${remaining} ${suffix}`
}

function discoveredModelMeta(model, includeImage, group) {
  const details = []
  if (typeof model.maxOutputTokens === 'number') {
    details.push(`最多 ${formatCount(model.maxOutputTokens)} 输出`)
  }
  if (
    Array.isArray(model.reasoningEfforts) &&
    model.reasoningEfforts.length > 0
  ) {
    details.push(`推理 ${model.reasoningEfforts.join(' / ')}`)
  }
  if (includeImage) {
    details.push(
      group === 'supported' || model.imageInput === 'supported'
        ? '声明支持图片'
        : '图片能力未知',
    )
  }
  return details.join(' · ')
}

function clearDiscovery() {
  state.discovery = null
  state.chatModelsExpanded = false
  state.visionSupportedExpanded = false
  state.visionUnknownExpanded = false
  elements.settingsChatDiscovery.hidden = true
  elements.settingsChatDiscoverySummary.textContent = ''
  elements.settingsChatModelSection.hidden = true
  elements.settingsChatModelChips.replaceChildren()
  elements.settingsChatModelMore.hidden = true
  elements.settingsChatModelNote.hidden = true
  elements.settingsVisionDiscovery.hidden = true
  elements.settingsVisionDiscoverySummary.textContent = ''
  elements.settingsVisionSupportedSection.hidden = true
  elements.settingsVisionUnknownSection.hidden = true
  elements.settingsVisionSupportedChips.replaceChildren()
  elements.settingsVisionUnknownChips.replaceChildren()
  elements.settingsVisionSupportedMore.hidden = true
  elements.settingsVisionUnknownMore.hidden = true
  elements.settingsVisionEmptyNote.hidden = true
}

function refreshModelChoiceSelection() {
  const chatModel = elements.settingsChatName.value.trim()
  for (const button of elements.settingsChatModelChips.querySelectorAll(
    'button[data-model-id]',
  )) {
    button.setAttribute(
      'aria-pressed',
      button.dataset.modelId === chatModel ? 'true' : 'false',
    )
  }

  const visionModel = elements.settingsVisionName.value.trim()
  for (const container of [
    elements.settingsVisionSupportedChips,
    elements.settingsVisionUnknownChips,
  ]) {
    for (const button of container.querySelectorAll(
      'button[data-model-id]',
    )) {
      button.setAttribute(
        'aria-pressed',
        button.dataset.modelId === visionModel ? 'true' : 'false',
      )
    }
  }
}

function selectChatModelFromChoice(modelId) {
  const models = state.discovery?.chat?.models
  if (!Array.isArray(models)) return
  const model = models.find(item => item.id === modelId)
  if (model === undefined) return
  elements.settingsChatName.value = model.id
  applyModelDiscoveryDefaults('chat', model)
  refreshModelChoiceSelection()
  showSettingsStatus(
    `已选择聊天模型 ${model.id}；发现结果尚未保存，请先测试再保存。`,
  )
}

function selectVisionModelFromChoice(modelId, group) {
  const vision = state.discovery?.vision
  const models = group === 'supported'
    ? vision?.supported
    : vision?.unknown
  if (!Array.isArray(models)) return
  const model = models.find(item => item.id === modelId)
  if (model === undefined) return
  elements.settingsVisionName.value = model.id
  applyModelDiscoveryDefaults('vision', model)
  refreshModelChoiceSelection()
  showSettingsStatus(
    group === 'unknown'
      ? `已选择视觉模型 ${model.id}；该模型没有声明图片能力，保存前会执行图片能力测试。`
      : `已选择视觉模型 ${model.id}；发现结果尚未保存，请先测试再保存。`,
  )
}

function applyModelDiscoveryDefaults(prefix, model) {
  const maxOutput = prefix === 'chat'
    ? elements.settingsChatMaxOutput
    : elements.settingsVisionMaxOutput
  if (
    maxOutput.value.trim() === '' &&
    Number.isSafeInteger(model.maxOutputTokens) &&
    model.maxOutputTokens > 0
  ) {
    maxOutput.value = String(model.maxOutputTokens)
  }

  if (
    prefix === 'chat' &&
    !elements.settingsChatReasoning.disabled &&
    elements.settingsChatReasoning.value.trim() === '' &&
    Array.isArray(model.reasoningEfforts) &&
    model.reasoningEfforts.length > 0
  ) {
    const preferred = model.reasoningEfforts.includes('low')
      ? 'low'
      : model.reasoningEfforts.find(level => level !== 'none')
    if (preferred !== undefined) {
      elements.settingsChatReasoning.value = preferred
    }
  }
}

function buildModelDiscoveryDraft() {
  const chatProvider = elements.settingsChatProvider.value
  const chatNeedsEndpoint =
    chatProvider === 'magpie' || chatProvider === 'openai-compatible'
  const visionEnabled = elements.settingsVisionEnabled.checked
  return {
    chat: {
      provider: chatProvider,
      baseUrl: chatNeedsEndpoint
        ? requiredSettingText(elements.settingsChatBaseUrl, '聊天 Base URL')
        : null,
      timeoutMs: settingInteger(elements.settingsChatTimeout, '聊天超时'),
      allowPrivateNetwork: elements.settingsChatPrivate.checked,
      credential: settingCredential('chat'),
    },
    vision: {
      enabled: visionEnabled,
      provider: visionEnabled ? elements.settingsVisionProvider.value : null,
      baseUrl: visionEnabled
        ? requiredSettingText(elements.settingsVisionBaseUrl, '视觉 Base URL')
        : null,
      timeoutMs: settingInteger(elements.settingsVisionTimeout, '视觉超时'),
      allowPrivateNetwork: elements.settingsVisionPrivate.checked,
      credential: visionEnabled
        ? settingCredential('vision')
        : { mode: 'none' },
    },
  }
}

async function testModelSettings() {
  if (state.settingsBusy) return
  if (!elements.settingsForm.reportValidity()) return
  setSettingsBusy(true)
  hideSettingsError()
  try {
    const result = await modelSettingsRequest(
      'POST',
      '/kanobot/api/settings/models/test',
      buildModelSettingsDraft(),
    )
    const vision = result.vision?.enabled === true
      ? `${result.vision.provider} / ${result.vision.model}`
      : '未启用'
    showSettingsStatus(
      `连接测试通过：${result.chat.provider} / ${result.chat.model}；视觉：${vision}`,
    )
  } catch (error) {
    showSettingsError(errorMessage(error))
  } finally {
    setSettingsBusy(false)
  }
}

async function saveModelSettings() {
  if (state.settingsBusy) return
  if (state.modelSettings?.readOnly === true) {
    showSettingsError('示例配置是只读的，不能保存模型设置。')
    return
  }
  if (!elements.settingsForm.reportValidity()) return
  setSettingsBusy(true)
  hideSettingsError()
  try {
    const view = await modelSettingsRequest(
      'PUT',
      '/kanobot/api/settings/models',
      buildModelSettingsDraft(),
    )
    applyModelSettings(view)
    elements.settingsChatSecret.value = ''
    elements.settingsVisionSecret.value = ''
    showSettingsStatus(
      '模型设置已保存。请重启 Rinkobot；运行中的对话不会热切换模型。',
    )
  } catch (error) {
    showSettingsError(errorMessage(error))
  } finally {
    setSettingsBusy(false)
  }
}

function buildModelSettingsDraft() {
  const chatProvider = elements.settingsChatProvider.value
  const chatNeedsEndpoint =
    chatProvider === 'magpie' || chatProvider === 'openai-compatible'
  const visionEnabled = elements.settingsVisionEnabled.checked
  return {
    chat: {
      provider: chatProvider,
      name: requiredSettingText(elements.settingsChatName, '聊天模型名'),
      baseUrl: chatNeedsEndpoint
        ? requiredSettingText(elements.settingsChatBaseUrl, '聊天 Base URL')
        : null,
      timeoutMs: settingInteger(elements.settingsChatTimeout, '聊天超时'),
      maxRetries: settingInteger(elements.settingsChatRetries, '聊天重试次数'),
      maxOutputTokens:
        chatProvider === 'mock'
          ? nullableSettingInteger(
              elements.settingsChatMaxOutput,
              '聊天最大输出 Token',
            )
          : settingInteger(
              elements.settingsChatMaxOutput,
              '聊天最大输出 Token',
            ),
      reasoningEffort:
        chatProvider === 'mock'
          ? null
          : nullableSettingText(elements.settingsChatReasoning),
      allowPrivateNetwork: elements.settingsChatPrivate.checked,
      credential: settingCredential('chat'),
    },
    vision: {
      enabled: visionEnabled,
      provider: visionEnabled ? elements.settingsVisionProvider.value : null,
      name: visionEnabled
        ? requiredSettingText(elements.settingsVisionName, '视觉模型名')
        : null,
      baseUrl: visionEnabled
        ? requiredSettingText(elements.settingsVisionBaseUrl, '视觉 Base URL')
        : null,
      timeoutMs: settingInteger(elements.settingsVisionTimeout, '视觉超时'),
      maxRetries: settingInteger(
        elements.settingsVisionRetries,
        '视觉重试次数',
      ),
      maxOutputTokens: visionEnabled
        ? settingInteger(
            elements.settingsVisionMaxOutput,
            '视觉最大输出 Token',
          )
        : null,
      allowPrivateNetwork: elements.settingsVisionPrivate.checked,
      maxImageBytes: settingInteger(
        elements.settingsVisionImageBytes,
        '最大图片字节',
      ),
      maxDescriptionChars: settingInteger(
        elements.settingsVisionDescriptionChars,
        '最大转述字数',
      ),
      credential: settingCredential('vision'),
    },
  }
}

function settingCredential(prefix) {
  const modeElement =
    elements[`settings${capitalize(prefix)}CredentialMode`]
  const mode = modeElement.value
  if (mode === 'environment') {
    return {
      mode,
      environmentName: requiredSettingText(
        elements[`settings${capitalize(prefix)}Env`],
        '环境变量名',
      ),
    }
  }
  if (mode === 'new') {
    const value = elements[`settings${capitalize(prefix)}Secret`].value
    if (value.trim() === '') {
      throw new Error('新 API key 不能为空')
    }
    return { mode, value }
  }
  return { mode }
}

function requiredSettingText(element, label) {
  const value = element.value.trim()
  if (value === '') throw new Error(`${label}不能为空`)
  return value
}

function nullableSettingText(element) {
  const value = element.value.trim()
  return value === '' ? null : value
}

function settingInteger(element, label) {
  const raw = element.value.trim()
  const value = Number(raw)
  if (raw === '' || !Number.isSafeInteger(value)) {
    throw new Error(`${label}必须是整数`)
  }
  return value
}

function nullableSettingInteger(element, label) {
  if (element.value.trim() === '') return null
  return settingInteger(element, label)
}

async function modelSettingsRequest(method, path, body) {
  const headers = { accept: 'application/json' }
  const init = {
    method,
    credentials: 'same-origin',
    headers,
  }
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const response = await fetch(path, init)
  if (!response.ok) {
    throw new Error(await responseMessage(response, '模型设置操作失败'))
  }
  return response.json()
}

function setSettingsBusy(busy) {
  state.settingsBusy = busy
  updateSettingsButtons()
}

function updateSettingsButtons() {
  const readOnly = state.modelSettings?.readOnly === true
  elements.settingsDiscover.disabled =
    state.settingsBusy || state.modelSettings === null
  elements.settingsChatRediscover.disabled =
    state.settingsBusy || state.modelSettings === null
  elements.settingsVisionRediscover.disabled =
    state.settingsBusy ||
    state.modelSettings === null ||
    !elements.settingsVisionEnabled.checked
  elements.settingsTest.disabled =
    state.settingsBusy || state.modelSettings === null
  elements.settingsSave.disabled =
    state.settingsBusy || state.modelSettings === null || readOnly
}

function showSettingsError(message) {
  elements.settingsError.textContent = message
  elements.settingsError.hidden = false
  elements.settingsStatus.hidden = true
}

function hideSettingsError() {
  elements.settingsError.hidden = true
}

function showSettingsStatus(message) {
  elements.settingsStatus.textContent = message
  elements.settingsStatus.hidden = false
}

function capitalize(value) {
  return value.slice(0, 1).toUpperCase() + value.slice(1)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

async function responseMessage(response, fallback) {
  try {
    const payload = await response.json()
    if (response.status === 401) {
      return payload?.error?.message || '需要重新登录 Rinkobot。'
    }
    return payload?.error?.message || fallback
  } catch {
    return `${fallback}（HTTP ${response.status}）`
  }
}

/* ------------------------------ 设置弹窗与 QQ 渠道 ------------------------------ */

function openSettingsDialog() {
  if (!elements.settingsDialog.open) {
    elements.settingsDialog.showModal()
  }
  switchSettingsPage(state.settingsPage)
  void loadModelSettings().catch(error =>
    showSettingsError(errorMessage(error)),
  )
  void loadChannelSettings().catch(error =>
    showChannelSettingsError(errorMessage(error)),
  )
}

function closeSettingsDialog() {
  if (elements.settingsDialog.open) elements.settingsDialog.close()
}

function switchSettingsPage(page) {
  if (page !== 'model' && page !== 'qq') return
  state.settingsPage = page
  for (const button of elements.settingsNavButtons) {
    const active = button.dataset.settingsPage === page
    button.classList.toggle('active', active)
    if (active) {
      button.setAttribute('aria-current', 'page')
    } else {
      button.removeAttribute('aria-current')
    }
  }
  elements.settingsPageModel.hidden = page !== 'model'
  elements.settingsPageQq.hidden = page !== 'qq'
  if (page === 'qq') {
    void loadChannelStatus().catch(() => {
      elements.channelConnectionState.textContent = 'QQ 状态读取失败'
    })
  }
}

async function loadChannelStatus() {
  const response = await fetch('/kanobot/api/settings/channels/status', {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (response.status === 404) {
    applyChannelStatus({
      state: 'disabled',
      label: 'QQ 未配置',
      configured: false,
      enabled: false,
      ownerQqSaved: false,
      selfId: null,
    })
    return null
  }
  if (!response.ok) {
    throw new Error(await responseMessage(response, '读取 QQ 状态失败'))
  }
  const payload = await response.json()
  const status = payload?.qq
  if (!status || typeof status !== 'object') {
    throw new Error('QQ 状态响应格式不正确')
  }
  applyChannelStatus(status)
  return status
}

function applyChannelStatus(status) {
  state.channelStatus = status
  const label = typeof status.label === 'string'
    ? status.label
    : 'QQ 状态未知'
  elements.qqBadge.textContent = label
  elements.qqBadge.dataset.state =
    typeof status.state === 'string' ? status.state : 'disabled'
  elements.channelConnectionState.textContent = label
  elements.channelConnectionState.dataset.state =
    typeof status.state === 'string' ? status.state : 'disabled'
  const missingOwner =
    status.enabled === true && status.ownerQqConfigured !== true
  elements.ownerQqWarning.hidden = !missingOwner
  if (!missingOwner) {
    elements.ownerQqWarning.textContent = ''
  } else if (status.ownerQqSaved === true) {
    elements.ownerQqWarning.textContent =
      '所有者 QQ 已保存，但当前实例尚未重启；QQ 私聊仍只会出现在“全部对话”。' +
      '请重启当前实例，重启后已有的对应私聊会合并到“我们的对话”。'
  } else {
    elements.ownerQqWarning.textContent =
      'QQ 已启用，但还没有设置所有者 QQ；QQ 私聊目前只会出现在“全部对话”。' +
      '请在“设置 → QQ → 所有者 QQ”中填写，并重启当前实例；' +
      '重启后已有的对应私聊会合并到“我们的对话”。'
  }
}

async function loadChannelSettings() {
  const response = await fetch('/kanobot/api/settings/channels', {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (response.status === 404) {
    state.channelSettings = null
    updateChannelButtons()
    showChannelSettingsError('当前安装没有启用 QQ 设置接口。')
    return null
  }
  if (!response.ok) {
    throw new Error(await responseMessage(response, '读取 QQ 设置失败'))
  }
  const view = await response.json()
  applyChannelSettings(view)
  hideChannelSettingsError()
  return view
}

function applyChannelSettings(view) {
  if (!view || typeof view !== 'object' || !view.qq) {
    throw new Error('QQ 设置响应格式不正确')
  }
  state.channelSettings = view
  const qq = view.qq
  elements.channelEnabled.checked = qq.enabled === true
  elements.channelWsUrl.value = String(qq.wsUrl ?? '')
  elements.channelAllowRemote.checked = qq.allowRemote === true
  elements.channelOwnerQq.value =
    typeof qq.ownerQqId === 'string' ? qq.ownerQqId : ''
  elements.channelCredentialMode.value = 'keep'
  elements.channelCredentialEnv.value =
    typeof qq.credential?.environmentName === 'string'
      ? qq.credential.environmentName
      : ''
  elements.channelCredentialSecret.value = ''
  elements.channelCredentialStatus.textContent =
    channelCredentialStatusText(qq.credential)
  elements.channelPrivateAllow.value = Array.isArray(qq.privateAllow)
    ? qq.privateAllow.join('\n')
    : ''
  elements.channelGroupAllow.value = Array.isArray(qq.groupAllow)
    ? qq.groupAllow.join('\n')
    : ''
  elements.channelGroupRequireMention.checked =
    qq.groupRequireMention === true
  renderAutonomousTargetOptions(qq.autonomousTarget ?? '')
  elements.channelConnectTimeout.value = String(qq.connectTimeoutMs ?? '')
  elements.channelActionTimeout.value = String(qq.actionTimeoutMs ?? '')
  elements.channelTurnTimeout.value = String(qq.turnTimeoutMs ?? '')
  elements.channelReconnectMin.value = String(qq.reconnectMinMs ?? '')
  elements.channelReconnectMax.value = String(qq.reconnectMaxMs ?? '')
  elements.channelPingInterval.value = String(qq.pingIntervalMs ?? '')
  elements.channelDedupeRetention.value = String(
    qq.dedupeRetentionHours ?? '',
  )
  elements.channelCoalesceQuiet.value = String(qq.coalesce?.quietMs ?? '')
  elements.channelCoalesceMaxWait.value = String(qq.coalesce?.maxWaitMs ?? '')
  elements.channelCoalesceMaxImages.value = String(
    qq.coalesce?.maxImages ?? '',
  )
  elements.channelCoalesceMaxTotalImageBytes.value = String(
    qq.coalesce?.maxTotalImageBytes ?? '',
  )
  elements.channelImagesDownloadTimeout.value = String(
    qq.images?.downloadTimeoutMs ?? '',
  )
  elements.channelOutboundSplitChars.value = String(
    qq.outbound?.splitChars ?? '',
  )
  elements.channelOutboundMaxParts.value = String(
    qq.outbound?.maxParts ?? '',
  )
  elements.channelOutboundMinInterval.value = String(
    qq.outbound?.minIntervalMs ?? '',
  )
  elements.channelLimitsMaxInbound.value = String(
    qq.limits?.maxInboundTurnsPerMinute ?? '',
  )
  elements.channelLimitsMaxOutbound.value = String(
    qq.limits?.maxOutboundPartsPerMinute ?? '',
  )
  elements.channelReadOnly.hidden = view.readOnly !== true
  elements.channelStatus.hidden = true
  syncChannelCredentialFields()
  updateChannelButtons()
}

function channelCredentialStatusText(credential) {
  if (!credential || typeof credential !== 'object') {
    return '凭据状态未知'
  }
  if (credential.mode === 'environment') {
    const name = credential.environmentName
    return typeof name === 'string' && name !== ''
      ? `环境变量 ${name}`
      : '环境变量（未命名）'
  }
  if (credential.mode === 'local-secret') {
    return credential.configured === true
      ? '本地密钥已保存'
      : '本地密钥不可用'
  }
  return '未配置'
}

function syncChannelCredentialFields() {
  const mode = elements.channelCredentialMode.value
  elements.channelCredentialEnvField.hidden = mode !== 'environment'
  elements.channelCredentialSecretField.hidden = mode !== 'new'
  updateChannelButtons()
}

function updateChannelButtons() {
  const unavailable = state.channelSettings === null
  const readOnly =
    unavailable || state.channelSettings?.readOnly === true
  const controls = elements.channelForm.querySelectorAll(
    'input, select, textarea',
  )
  for (const control of controls) {
    control.disabled = readOnly
  }
  if (!readOnly) {
    const mode = elements.channelCredentialMode.value
    elements.channelCredentialEnv.disabled = mode !== 'environment'
    elements.channelCredentialEnv.required = mode === 'environment'
    elements.channelCredentialSecret.disabled = mode !== 'new'
    elements.channelCredentialSecret.required = mode === 'new'
  }
  elements.channelRefresh.disabled = state.channelBusy
  elements.channelTest.disabled = state.channelBusy || unavailable
  elements.channelSave.disabled =
    state.channelBusy || unavailable || readOnly
}

function renderAutonomousTargetOptions(preferred = null) {
  const previous = preferred ??
    elements.channelAutonomousTarget.value
  const privateIds = looseQqIds(elements.channelPrivateAllow.value)
  const groupIds = looseQqIds(elements.channelGroupAllow.value)
  const options = []
  for (const id of privateIds) {
    options.push({
      value: `private:${id}`,
      label: `私聊 · ${id}`,
    })
  }
  for (const id of groupIds) {
    options.push({
      value: `group:${id}`,
      label: `群聊 · ${id}`,
    })
  }
  elements.channelAutonomousTarget.replaceChildren()
  const empty = document.createElement('option')
  empty.value = ''
  empty.textContent = '不投递到 QQ'
  elements.channelAutonomousTarget.append(empty)
  for (const option of options) {
    const element = document.createElement('option')
    element.value = option.value
    element.textContent = option.label
    elements.channelAutonomousTarget.append(element)
  }
  if (options.some(option => option.value === previous)) {
    elements.channelAutonomousTarget.value = previous
  }
}

function looseQqIds(value) {
  return [...new Set(
    String(value)
      .split(/[\s,，;；]+/)
      .map(item => item.trim())
      .filter(item => /^[1-9]\d{4,19}$/.test(item)),
  )]
}

async function testChannelSettings() {
  if (state.channelBusy || state.channelSettings === null) return
  hideChannelSettingsError()
  elements.channelStatus.hidden = true
  let draft
  try {
    draft = buildChannelSettingsDraft()
  } catch (error) {
    showChannelSettingsError(errorMessage(error))
    return
  }
  state.channelBusy = true
  elements.channelTest.textContent = '测试中…'
  updateChannelButtons()
  try {
    const result = await channelSettingsRequest(
      'POST',
      '/kanobot/api/settings/channels/test',
      draft,
    )
    showChannelSettingsStatus(
      `连接测试通过：selfId ${result.selfId}，耗时 ${result.durationMs} ms。` +
        '配置尚未保存。',
    )
  } catch (error) {
    showChannelSettingsError(errorMessage(error))
  } finally {
    state.channelBusy = false
    elements.channelTest.textContent = '测试连接'
    updateChannelButtons()
  }
}

async function saveChannelSettings() {
  if (state.channelBusy || state.channelSettings === null) return
  if (state.channelSettings.readOnly === true) {
    showChannelSettingsError('示例配置是只读的，不能保存 QQ 设置。')
    return
  }
  let draft
  try {
    if (!elements.channelForm.reportValidity()) return
    draft = buildChannelSettingsDraft()
  } catch (error) {
    showChannelSettingsError(errorMessage(error))
    return
  }
  state.channelBusy = true
  elements.channelSave.textContent = '保存中…'
  updateChannelButtons()
  try {
    const view = await channelSettingsRequest(
      'PUT',
      '/kanobot/api/settings/channels',
      draft,
    )
    applyChannelSettings(view)
    elements.channelCredentialSecret.value = ''
    showChannelSettingsStatus(
      '配置已保存；重启 Rinkobot 后 QQ 渠道生效。',
    )
    await loadChannelStatus().catch(() => {
      elements.channelConnectionState.textContent =
        '配置已保存；QQ 状态暂时无法读取。'
    })
  } catch (error) {
    showChannelSettingsError(errorMessage(error))
  } finally {
    state.channelBusy = false
    elements.channelSave.textContent = '保存配置'
    updateChannelButtons()
  }
}

function buildChannelSettingsDraft() {
  const credentialMode = elements.channelCredentialMode.value
  let credential
  if (credentialMode === 'environment') {
    credential = {
      mode: credentialMode,
      environmentName: requiredSettingText(
        elements.channelCredentialEnv,
        'QQ 环境变量名',
      ),
    }
  } else if (credentialMode === 'new') {
    const value = elements.channelCredentialSecret.value
    if (value.trim() === '') {
      throw new Error('新 QQ access token 不能为空')
    }
    credential = { mode: credentialMode, value }
  } else {
    credential = { mode: credentialMode }
  }

  return {
    qq: {
      enabled: elements.channelEnabled.checked,
      wsUrl: requiredSettingText(elements.channelWsUrl, 'QQ WebSocket URL'),
      allowRemote: elements.channelAllowRemote.checked,
      credential,
      ownerQqId: parseOwnerQqId(elements.channelOwnerQq.value),
      privateAllow: parseQqIdList(
        elements.channelPrivateAllow.value,
        '私聊白名单',
      ),
      groupAllow: parseQqIdList(
        elements.channelGroupAllow.value,
        '群白名单',
      ),
      groupRequireMention:
        elements.channelGroupRequireMention.checked,
      autonomousTarget:
        elements.channelAutonomousTarget.value === ''
          ? null
          : elements.channelAutonomousTarget.value,
      connectTimeoutMs: settingInteger(
        elements.channelConnectTimeout,
        'QQ 连接超时',
      ),
      actionTimeoutMs: settingInteger(
        elements.channelActionTimeout,
        'QQ 动作超时',
      ),
      turnTimeoutMs: settingInteger(
        elements.channelTurnTimeout,
        'QQ 回合超时',
      ),
      reconnectMinMs: settingInteger(
        elements.channelReconnectMin,
        'QQ 最短重连间隔',
      ),
      reconnectMaxMs: settingInteger(
        elements.channelReconnectMax,
        'QQ 最长重连间隔',
      ),
      pingIntervalMs: settingInteger(
        elements.channelPingInterval,
        'QQ Ping 间隔',
      ),
      dedupeRetentionHours: settingInteger(
        elements.channelDedupeRetention,
        'QQ 入站去重保留小时数',
      ),
      coalesce: {
        quietMs: settingInteger(
          elements.channelCoalesceQuiet,
          'QQ 连发静默窗口',
        ),
        maxWaitMs: settingInteger(
          elements.channelCoalesceMaxWait,
          'QQ 连发最大等待',
        ),
        maxImages: settingInteger(
          elements.channelCoalesceMaxImages,
          'QQ 单回合最多图片',
        ),
        maxTotalImageBytes: settingInteger(
          elements.channelCoalesceMaxTotalImageBytes,
          'QQ 单回合图片总字节',
        ),
      },
      images: {
        downloadTimeoutMs: settingInteger(
          elements.channelImagesDownloadTimeout,
          'QQ 图片下载超时',
        ),
      },
      outbound: {
        splitChars: settingInteger(
          elements.channelOutboundSplitChars,
          'QQ 单条最大字符',
        ),
        maxParts: settingInteger(
          elements.channelOutboundMaxParts,
          'QQ 最多发送分片',
        ),
        minIntervalMs: settingInteger(
          elements.channelOutboundMinInterval,
          'QQ 分片最短间隔',
        ),
      },
      limits: {
        maxInboundTurnsPerMinute: settingInteger(
          elements.channelLimitsMaxInbound,
          'QQ 每分钟最多入站回合',
        ),
        maxOutboundPartsPerMinute: settingInteger(
          elements.channelLimitsMaxOutbound,
          'QQ 每分钟最多出站分片',
        ),
      },
    },
  }
}

function parseQqIdList(value, label) {
  const items = String(value)
    .split(/[\s,，;；]+/)
    .map(item => item.trim())
    .filter(item => item !== '')
  for (const item of items) {
    if (!/^[1-9]\d{4,19}$/.test(item)) {
      throw new Error(`${label}必须是 5–20 位数字，且不能以 0 开头`)
    }
  }
  return [...new Set(items)]
}

function parseOwnerQqId(value) {
  const trimmed = String(value).trim()
  if (trimmed === '') return null
  if (!/^[1-9]\d{4,19}$/.test(trimmed)) {
    throw new Error('所有者 QQ 必须是 5–20 位数字，且不能以 0 开头')
  }
  return trimmed
}

async function channelSettingsRequest(method, path, body) {
  const headers = { accept: 'application/json' }
  const init = {
    method,
    credentials: 'same-origin',
    headers,
  }
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const response = await fetch(path, init)
  if (!response.ok) {
    throw new Error(await responseMessage(response, 'QQ 设置操作失败'))
  }
  return response.json()
}

function showChannelSettingsError(message) {
  elements.channelError.textContent = message
  elements.channelError.hidden = false
  elements.channelStatus.hidden = true
}

function hideChannelSettingsError() {
  elements.channelError.hidden = true
}

function showChannelSettingsStatus(message) {
  elements.channelStatus.textContent = message
  elements.channelStatus.hidden = false
  elements.channelError.hidden = true
}

/* ------------------------------ 所有者面板 ------------------------------ */

for (const button of elements.tabButtons) {
  button.addEventListener('click', () => switchTab(button.dataset.tab))
}

function switchTab(tab) {
  if (
    tab !== 'status' &&
    tab !== 'initiative' &&
    tab !== 'memory' &&
    tab !== 'audit'
  ) {
    return
  }
  state.activeTab = tab
  for (const button of elements.tabButtons) {
    const active = button.dataset.tab === tab
    button.classList.toggle('active', active)
    button.setAttribute('aria-selected', active ? 'true' : 'false')
  }
  elements.tabStatus.hidden = tab !== 'status'
  elements.tabInitiative.hidden = tab !== 'initiative'
  elements.tabMemory.hidden = tab !== 'memory'
  elements.tabAudit.hidden = tab !== 'audit'
  if (tab === 'initiative') {
    void loadInitiative().catch(error =>
      showInitiativeError(errorMessage(error)),
    )
  } else if (tab === 'memory') {
    void loadMemories().catch(error => showMemoryError(errorMessage(error)))
  } else if (tab === 'audit') {
    void loadAudit().catch(error => showAuditError(errorMessage(error)))
  }
}

for (const list of [
  elements.reminderCandidateList,
  elements.reminderList,
]) {
  list.addEventListener('click', event => {
    const button = event.target.closest('button[data-action]')
    if (!(button instanceof HTMLButtonElement)) return
    const id = button.dataset.id
    const action = button.dataset.action
    if (!id || !action) return
    const item = button.closest('.initiative-item')
    const label =
      item?.querySelector('.initiative-item-text')?.textContent ?? ''
    void runInitiativeAction(action, id, label).catch(error =>
      showInitiativeError(errorMessage(error)),
    )
  })
}

elements.initiativeRefresh.addEventListener('click', () => {
  void loadInitiative().catch(error =>
    showInitiativeError(errorMessage(error)),
  )
})

elements.circuitReset.addEventListener('click', () => {
  const label = '恢复主动消息'
  void runInitiativeAction('reset-circuit', 'circuit', label).catch(error =>
    showInitiativeError(errorMessage(error)),
  )
})

elements.settingsOpen.addEventListener('click', openSettingsDialog)
elements.settingsDialogClose.addEventListener('click', closeSettingsDialog)
elements.settingsDialog.addEventListener('click', event => {
  if (event.target === elements.settingsDialog) closeSettingsDialog()
})
elements.settingsDialog.addEventListener('close', () => {
  elements.settingsOpen.focus({ preventScroll: true })
})
for (const button of elements.settingsNavButtons) {
  button.addEventListener('click', () => {
    switchSettingsPage(button.dataset.settingsPage)
  })
}

elements.channelRefresh.addEventListener('click', () => {
  void loadChannelSettings().catch(error =>
    showChannelSettingsError(errorMessage(error)),
  )
})

elements.channelForm.addEventListener('submit', event => {
  event.preventDefault()
  void saveChannelSettings()
})

elements.channelTest.addEventListener('click', () => {
  void testChannelSettings()
})

elements.channelCredentialMode.addEventListener('change', () => {
  syncChannelCredentialFields()
})

for (const element of [
  elements.channelPrivateAllow,
  elements.channelGroupAllow,
]) {
  element.addEventListener('input', () => {
    renderAutonomousTargetOptions()
  })
}

elements.settingsRefresh.addEventListener('click', () => {
  void loadModelSettings().catch(error =>
    showSettingsError(errorMessage(error)),
  )
})

elements.settingsDiscover.addEventListener('click', () => {
  void discoverModels()
})

elements.settingsChatRediscover.addEventListener('click', () => {
  void discoverModels()
})

elements.settingsVisionRediscover.addEventListener('click', () => {
  void discoverModels()
})

elements.settingsForm.addEventListener('submit', event => {
  event.preventDefault()
  void saveModelSettings()
})

elements.settingsTest.addEventListener('click', () => {
  void testModelSettings()
})

for (const element of [
  elements.settingsChatProvider,
  elements.settingsChatCredentialMode,
  elements.settingsVisionEnabled,
  elements.settingsVisionProvider,
  elements.settingsVisionCredentialMode,
]) {
  element.addEventListener('change', () => {
    clearDiscovery()
    syncSettingsForm()
  })
}

for (const element of [
  elements.settingsChatBaseUrl,
  elements.settingsVisionBaseUrl,
]) {
  element.addEventListener('change', () => {
    clearDiscovery()
    syncSettingsForm()
  })
}

elements.settingsChatModelChips.addEventListener('click', event => {
  const button = event.target.closest('button[data-model-id]')
  if (!(button instanceof HTMLButtonElement)) return
  const modelId = button.dataset.modelId
  if (modelId === undefined || modelId === '') return
  selectChatModelFromChoice(modelId)
})

for (const container of [
  elements.settingsVisionSupportedChips,
  elements.settingsVisionUnknownChips,
]) {
  container.addEventListener('click', event => {
    const button = event.target.closest('button[data-model-id]')
    if (!(button instanceof HTMLButtonElement)) return
    const modelId = button.dataset.modelId
    const group = button.dataset.modelGroup
    if (modelId === undefined || modelId === '') return
    if (group !== 'supported' && group !== 'unknown') return
    selectVisionModelFromChoice(modelId, group)
  })
}

elements.settingsChatModelMore.addEventListener('click', () => {
  state.chatModelsExpanded = true
  renderDiscoveryOptions()
})

elements.settingsVisionSupportedMore.addEventListener('click', () => {
  state.visionSupportedExpanded = true
  renderDiscoveryOptions()
})

elements.settingsVisionUnknownMore.addEventListener('click', () => {
  state.visionUnknownExpanded = true
  renderDiscoveryOptions()
})

for (const element of [
  elements.settingsChatName,
  elements.settingsVisionName,
]) {
  element.addEventListener('input', () => {
    refreshModelChoiceSelection()
  })
}

elements.notificationEnable.addEventListener('click', () => {
  void requestNotificationPermission().catch(error =>
    showInitiativeError(errorMessage(error)),
  )
})

for (const button of elements.memoryFilters) {
  button.addEventListener('click', () => {
    const status = button.dataset.status
    if (
      status !== 'active' &&
      status !== 'candidate' &&
      status !== 'archived' &&
      status !== 'trash'
    ) {
      return
    }
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
elements.auditRefresh.addEventListener('click', () => {
  void loadAudit().catch(error => showAuditError(errorMessage(error)))
})
elements.auditMore.addEventListener('click', () => {
  state.auditVisible += 50
  renderAudit()
})
elements.auditSource.addEventListener('change', () => {
  const source = elements.auditSource.value
  if (!['all', 'owner', 'memory', 'model', 'style', 'chat', 'channel'].includes(source)) {
    return
  }
  state.auditSource = source
  void loadAudit().catch(error => showAuditError(errorMessage(error)))
})
elements.emergencyButton.addEventListener('click', () => {
  void toggleEmergency().catch(error => showNotice(errorMessage(error)))
})
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
      archived: Number(payload.counts.archived) || 0,
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
  elements.countArchived.textContent = String(state.counts.archived)
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
  if (memory.status === 'archived') {
    meta.append(chip('已归档 · 不参与召回'))
  }
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
  } else if (memory.status === 'archived') {
    actions.append(
      actionButton('恢复为候选', 'restore', memory.id, false),
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
