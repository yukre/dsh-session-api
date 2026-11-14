/**
 * dsh-session-api — Markdown presentation.
 *
 * A JSON body is precise but unreadable in a terminal or a chat window, and
 * the API is meant to be consumed by a person ("show me the sessions and what
 * this one is doing") as well as by a program. Every read endpoint therefore
 * offers the same data as Markdown through `?format=md`.
 *
 * Only reads have a Markdown form: a write returns a receipt, and rendering a
 * receipt as prose adds nothing. `GET /capabilities` publishes which endpoints
 * support which formats, so a caller never has to guess.
 *
 * @module dsh-session-api/markdown
 */

/** Escape the pipe so a value cannot break a table cell. */
function cell(value) {
  if (value === undefined || value === null) return '—'
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** Render a relative age from an epoch-millisecond timestamp. */
function age(updatedAt, now) {
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return '—'
  const seconds = Math.max(0, Math.round((now - updatedAt) / 1000))
  if (seconds < 60) return '刚刚'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

/** Format a token count compactly. */
function tokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

/**
 * Render the session list.
 * @param sessions - list items from the controller.
 * @param now - reference time for the age column.
 * @returns Markdown document.
 */
export function renderSessionList(sessions, now = Date.now()) {
  const rows = Array.isArray(sessions) ? sessions : []
  const lines = [`# 会话列表（${rows.length} 个）`, '']
  if (rows.length === 0) {
    lines.push('_当前没有会话。_', '')
    return lines.join('\n')
  }
  lines.push('| 状态 | 标题 | 工作目录 | 最后活动 | 会话 ID |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const item of rows) {
    const state = item?.running === true ? '🟢 运行中' : '⚪ 空闲'
    const projected = item?.projections?.values ?? {}
    const title = cell(projected.title ?? item?.title ?? item?.displayTitle ?? '(无标题)')
    const cwd = cell(item?.cwd ?? '—')
    const when = age(item?.updatedAt, now)
    const id = cell(item?.sessionId ?? item?.id ?? '?')
    lines.push(`| ${state} | ${title} | ${cwd} | ${when} | \`${id}\` |`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Render one session's detail plus its live state.
 * @param session - the list item for this session.
 * @param state - the state read, when available.
 * @returns Markdown document.
 */
export function renderSessionDetail(session, state) {
  const projected = session?.projections?.values ?? {}
  const title = projected.title ?? session?.title ?? session?.displayTitle ?? '(无标题)'
  const lines = [`# ${title}`, '']
  const push = (label, value) => lines.push(`- **${label}**：${value}`)

  push('会话 ID', `\`${session?.sessionId ?? session?.id ?? '?'}\``)
  push('状态', session?.running === true ? '🟢 运行中' : '⚪ 空闲')
  if (session?.cwd !== undefined) push('工作目录', `\`${session.cwd}\``)
  if (session?.blank === true) push('内容', '空会话')

  const values = projected
  if (values !== undefined && values !== null) {
    if (typeof values.title === 'string' && values.title.length > 0) push('会话标题', values.title)
    const model = values.modelSelection?.lastUsed
    if (model !== undefined) push('当前模型', `${model.provider} / ${model.model}`)
    if (typeof values.agentPreset === 'string') push('Agent 预设', values.agentPreset)
    const usage = values.tokenUsage
    if (usage !== undefined) {
      push('Token 用量',
        `输入 ${tokens(usage.uncachedInputTokens)} · 输出 ${tokens(usage.outputTokens)} · 缓存读 ${tokens(usage.cacheReadTokens)}`)
    }
    if (typeof values.permissions?.currentValue === 'string') {
      push('当前权限', `\`${values.permissions.currentValue}\``)
    }
    const inbound = values.inbox
    if (inbound !== undefined && Array.isArray(inbound?.queue)) {
      push('收件箱排队', `${inbound.queue.length} 条`)
    }
    const goal = values.goal
    if (goal !== null && goal !== undefined && typeof goal.objective === 'string') {
      push('目标', goal.objective)
    }
  }

  if (state !== undefined && state !== null) {
    lines.push('', '## 运行状态', '')
    lines.push(`- 当前轮进行中：${state.running === true ? '是' : '否'}`)
    lines.push(`- 活动状态：${state.active === true ? '有活动' : '无活动'}`)
    const queue = Array.isArray(state.queue) ? state.queue : []
    lines.push(`- 排队消息：${queue.length} 条`)
    if (queue.length > 0) {
      lines.push('')
      lines.push('| # | 内容预览 |')
      lines.push('| --- | --- |')
      queue.forEach((entry, index) => {
        const text = entry?.text ?? entry?.preview ?? entry?.content ?? ''
        lines.push(`| ${index + 1} | ${cell(String(text).slice(0, 80))} |`)
      })
    }
    const pending = Array.isArray(state.pendingInput) ? state.pendingInput : []
    if (pending.length > 0) lines.push(`- 待处理输入：${pending.length} 条`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Render the model catalog.
 * @param catalog - the catalog value from the controller.
 * @returns Markdown document.
 */
export function renderModelCatalog(catalog) {
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
  const lines = ['# 可选模型', '']
  if (groups.length === 0) {
    lines.push('_没有可用的模型提供方。_', '')
    return lines.join('\n')
  }
  for (const group of groups) {
    const provider = group?.id ?? group?.provider ?? '?'
    lines.push(`## ${provider}`, '')
    const models = Array.isArray(group?.models) ? group.models : []
    if (models.length === 0) {
      lines.push('_无模型。_', '')
      continue
    }
    lines.push('| 模型 | 名称 | 上下文窗口 | 推理档位 |')
    lines.push('| --- | --- | --- | --- |')
    for (const model of models) {
      const efforts = Array.isArray(model?.reasoningEfforts)
        ? model.reasoningEfforts.map(entry => entry?.id ?? entry).filter(Boolean).join(', ')
        : (model?.reasoningEfforts !== undefined && typeof model.reasoningEfforts === 'object'
          ? Object.keys(model.reasoningEfforts).join(', ')
          : '—')
      lines.push(`| \`${cell(model?.id)}\` | ${cell(model?.name ?? model?.id)} | ${cell(model?.contextWindow)} | ${cell(efforts)} |`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Render the permission catalog.
 * @param catalog - the preset catalog value.
 * @returns Markdown document.
 */
export function renderPermissionCatalog(catalog) {
  const options = Array.isArray(catalog?.options) ? catalog.options : []
  const defaults = new Set(
    Array.isArray(catalog?.defaultOptions)
      ? catalog.defaultOptions.map(entry => entry?.value ?? entry)
      : [],
  )
  const lines = ['# 权限预设', '']
  if (typeof catalog?.defaultPreset === 'string') {
    lines.push(`默认预设：**${catalog.defaultPreset}**`, '')
  }
  if (options.length === 0) {
    lines.push('_没有可选的权限预设。_', '')
    return lines.join('\n')
  }
  lines.push('| 预设 | 名称 | 可设为默认 |')
  lines.push('| --- | --- | --- |')
  for (const option of options) {
    const value = option?.value ?? option?.id ?? '?'
    lines.push(`| \`${cell(value)}\` | ${cell(option?.name ?? value)} | ${defaults.has(value) ? '是' : '否'} |`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Render the queue of one session.
 * @param sessionId - the addressed session.
 * @param queue - queued items.
 * @returns Markdown document.
 */
export function renderQueue(sessionId, queue) {
  const rows = Array.isArray(queue) ? queue : []
  const lines = [`# 排队消息 · \`${sessionId}\``, '', `共 ${rows.length} 条。`, '']
  if (rows.length === 0) return lines.join('\n')
  lines.push('| # | 条目 ID | 内容预览 |')
  lines.push('| --- | --- | --- |')
  rows.forEach((entry, index) => {
    const id = entry?.itemId ?? entry?.messageId ?? entry?.id ?? '?'
    const text = String(entry?.text ?? entry?.preview ?? entry?.content ?? '')
    lines.push(`| ${index + 1} | \`${cell(id)}\` | ${cell(text.slice(0, 120))} |`)
  })
  lines.push('')
  return lines.join('\n')
}

/**
 * Render a conversation page as Markdown.
 *
 * `controller.page` returns the raw event stream, not a message list: the
 * durable log carries tool calls, step boundaries and job bookkeeping beside
 * the conversation itself. Only `user/message` and `assistant/message` are
 * dialogue, so the renderer selects those and leaves the rest out — dumping
 * every event would bury the conversation in machinery.
 *
 * Message bodies are emitted verbatim, so whichever Markdown the model
 * produced (lists, tables, code fences) survives into the document instead of
 * being flattened.
 * @param sessionId - the addressed session.
 * @param page - the page value from `controller.page`.
 * @returns Markdown document.
 */
export function renderConversation(sessionId, page) {
  const records = Array.isArray(page?.records) ? page.records : []
  const turns = []
  for (const record of records) {
    const event = record?.event ?? record
    const type = event?.type
    if (type !== 'user/message' && type !== 'assistant/message') continue
    const message = event?.data?.message ?? event?.data ?? {}
    const role = String(message?.role ?? (type === 'user/message' ? 'user' : 'assistant'))
    const content = Array.isArray(message?.content) ? message.content : []
    const texts = content
      .filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
    const body = texts.join('\n\n').trim()
    if (body.length === 0) continue
    turns.push({ role, body })
  }

  const lines = [`# 会话内容 · \`${sessionId}\``, '']
  if (turns.length === 0) {
    lines.push('_这段范围内没有可读的对话消息。_', '')
    return lines.join('\n')
  }
  lines.push(`共 ${turns.length} 条消息。`, '')
  for (const turn of turns) {
    const heading = turn.role === 'user' ? '👤 用户' : turn.role === 'assistant' ? '🤖 助手' : turn.role
    lines.push(`## ${heading}`, '', turn.body, '')
  }
  return lines.join('\n')
}

/**
 * Render the workspace list.
 * @param workspaces - workspace views from the API.
 * @returns Markdown document.
 */
export function renderWorkspaceList(workspaces) {
  const rows = Array.isArray(workspaces) ? workspaces : []
  const lines = [`# 工作区（${rows.length} 个）`, '']
  if (rows.length === 0) {
    lines.push('_当前没有登记的工作区。_', '')
    return lines.join('\n')
  }
  lines.push('| 标题 | 路径 | 会话数 | 工作区 ID |')
  lines.push('| --- | --- | --- | --- |')
  for (const item of rows) {
    lines.push(`| ${cell(item?.title)} | \`${cell(item?.path)}\` | ${cell(item?.sessionCount)} | \`${cell(item?.workspaceId)}\` |`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Render the pending approvals of one session.
 * @param sessionId - the addressed session.
 * @param pending - approvals this plugin is holding.
 * @param pendingInput - the session's durable pending-input kinds.
 * @returns Markdown document.
 */
export function renderApprovals(sessionId, pending, pendingInput) {
  const rows = Array.isArray(pending) ? pending : []
  const kinds = Array.isArray(pendingInput) ? pendingInput : []
  const lines = [`# 待决审批 · \`${sessionId}\``, '']
  if (rows.length === 0) {
    lines.push('_本插件当前没有持有待决审批。_', '')
    if (kinds.length > 0) {
      lines.push(
        `会话记录的待处理输入为：${kinds.map(k => `\`${k}\``).join('、')}。`,
        '',
        '这可能意味着该审批由界面持有，或已裁决但投影尚未更新。',
        '',
      )
    }
    return lines.join('\n')
  }
  lines.push('| 工具 | 原因 | 等待 | 裁决 ID |', '| --- | --- | --- | --- |')
  for (const entry of rows) {
    const waited = age(entry?.askedAt, Date.now())
    lines.push(`| \`${cell(entry?.toolName)}\` | ${cell(entry?.reason)} | ${waited} | \`${cell(entry?.decisionId)}\` |`)
  }
  lines.push('')
  return lines.join('\n')
}
