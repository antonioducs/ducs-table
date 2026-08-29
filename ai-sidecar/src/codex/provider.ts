import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type { ChatEvent, ChatStartParams, HostToolCallResult, ProviderContext, ProviderStatus, ToolSpec } from '../types.js'
import { errorMessage, isRecord, type AiProvider } from '../types.js'
import { codexEnvironment } from '../environment.js'
import { CodexAppServer, type AppServerNotification, type AppServerRequest } from './app-server.js'
import { resolveCodexBinary } from './runtime.js'

const require = createRequire(import.meta.url)
const codexPackage = require('@openai/codex/package.json') as { version: string }

interface ActiveChat {
  chatId: string
  sessionId: string
  turnId: string | null
  abort: AbortController
  unsubscribe: () => void
  terminal: boolean
  streamedText: Set<string>
  streamedReasoning: Set<string>
}

interface ModelPage {
  data?: unknown
  nextCursor?: unknown
}

const LOCKED_THREAD_CONFIG: Record<string, unknown> = {
  'features.shell_tool': false,
  'features.apps': false,
  'features.plugins': false,
  'features.skill_search': false,
  'features.skill_mcp_dependency_install': false,
  'skills.include_instructions': false,
  'features.image_generation': false,
  'features.tool_suggest': false,
  web_search: 'disabled',
}

export function codexDynamicTools(tools: readonly ToolSpec[]): unknown[] {
  const eager = tools.filter((tool) => tool.deferLoading !== true).map((tool) => ({ type: 'function', ...tool }))
  const deferred = tools.filter((tool) => tool.deferLoading === true).map((tool) => ({ type: 'function', ...tool }))
  if (!deferred.length) return eager
  return [
    ...eager,
    {
      type: 'namespace',
      name: 'ducs_deferred',
      description: 'DUCS Table tools loaded on demand.',
      tools: deferred,
    },
  ]
}

export function codexInstructionOverride(systemPrompt?: string): Record<string, string> {
  return systemPrompt ? { developerInstructions: systemPrompt } : {}
}

export function codexFastServiceTier(catalog: readonly unknown[], modelId: string): string | null {
  const model = catalog.find((entry) => {
    if (!isRecord(entry)) return false
    return entry.id === modelId || entry.model === modelId || entry.slug === modelId
  })
  if (!isRecord(model)) return null
  const tiers = Array.isArray(model.serviceTiers)
    ? model.serviceTiers
    : Array.isArray(model.service_tiers)
      ? model.service_tiers
      : []
  const normalized = tiers.filter(isRecord)
  const priority = normalized.find((tier) => String(tier.id ?? tier.name ?? '').toLowerCase() === 'priority')
  if (priority) return String(priority.id ?? priority.name)
  const fast = normalized.find((tier) => String(tier.id ?? tier.name ?? '').toLowerCase() === 'fast')
  return fast ? String(fast.id ?? fast.name) : null
}

export function mapCodexNotification(notification: AppServerNotification): ChatEvent[] {
  const params = isRecord(notification.params) ? notification.params : {}
  if (notification.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
    return [{ type: 'text_delta', text: params.delta, ...(typeof params.itemId === 'string' ? { partId: params.itemId } : {}) }]
  }
  if (notification.method === 'item/plan/delta' && typeof params.delta === 'string') {
    return [{ type: 'text_delta', text: params.delta, ...(typeof params.itemId === 'string' ? { partId: params.itemId } : {}) }]
  }
  if (notification.method === 'item/reasoning/summaryTextDelta' && typeof params.delta === 'string') {
    return [{ type: 'reasoning_delta', text: params.delta, ...(typeof params.itemId === 'string' ? { partId: params.itemId } : {}) }]
  }
  if (notification.method === 'item/completed' && isRecord(params.item)) {
    const item = params.item
    if ((item.type === 'agentMessage' || item.type === 'plan') && typeof item.text === 'string') {
      return [{ type: 'text_delta', text: item.text, ...(typeof item.id === 'string' ? { partId: item.id } : {}) }]
    }
    if (item.type === 'reasoning' && Array.isArray(item.summary)) {
      const text = item.summary.filter((entry): entry is string => typeof entry === 'string').join('\n')
      return text ? [{ type: 'reasoning_delta', text, ...(typeof item.id === 'string' ? { partId: item.id } : {}) }] : []
    }
  }
  if (notification.method === 'thread/tokenUsage/updated' && isRecord(params.tokenUsage)) {
    const total = isRecord(params.tokenUsage.total) ? params.tokenUsage.total : {}
    return [{
      type: 'usage',
      inputTokens: Number(total.inputTokens) || 0,
      outputTokens: Number(total.outputTokens) || 0,
      ...(Number(total.cachedInputTokens) > 0 ? { cacheReadTokens: Number(total.cachedInputTokens) } : {}),
    }]
  }
  return []
}

export class CodexProvider implements AiProvider {
  readonly name = 'codex' as const
  private client: CodexAppServer | null = null
  private connecting: Promise<CodexAppServer> | null = null
  private readonly active = new Map<string, ActiveChat>()
  private readonly sessionChats = new Map<string, string>()
  private modelCatalog: unknown[] = []

  constructor(
    private readonly context: ProviderContext,
    private readonly codexHome: string,
    private readonly binaryOverride?: string,
  ) {}

  async status(refresh = false): Promise<ProviderStatus> {
    try {
      const account = await (await this.getClient()).request<Record<string, unknown>>('account/read', { refreshToken: refresh })
      const current = isRecord(account.account) ? account.account : null
      return {
        provider: this.name,
        available: true,
        authenticated: current?.type === 'chatgpt',
        account: current,
        version: codexPackage.version,
        error: null,
      }
    } catch (error) {
      return { provider: this.name, available: false, authenticated: false, account: null, version: codexPackage.version, error: errorMessage(error) }
    }
  }

  async login(signal?: AbortSignal): Promise<unknown> {
    return (await this.getClient()).request('account/login/start', {
      type: 'chatgpt',
      codexStreamlinedLogin: true,
      useHostedLoginSuccessPage: true,
      appBrand: 'chatgpt',
    }, { ...(signal ? { signal } : {}), timeoutMs: 0 })
  }

  async logout(): Promise<unknown> {
    await this.cancelAll()
    return (await this.getClient()).request('account/logout')
  }

  async models(signal?: AbortSignal): Promise<unknown[]> {
    const client = await this.getClient()
    const result: unknown[] = []
    const seen = new Set<string>()
    let cursor: string | null = null
    for (let index = 0; index < 100; index += 1) {
      const page: ModelPage = await client.request<ModelPage>(
        'model/list',
        { cursor, limit: 100, includeHidden: false },
        signal ? { signal } : {},
      )
      if (!Array.isArray(page.data)) throw new Error('Codex model/list returned invalid data.')
      result.push(...page.data)
      if (page.nextCursor == null) {
        this.modelCatalog = result
        return result
      }
      if (typeof page.nextCursor !== 'string' || !page.nextCursor || seen.has(page.nextCursor)) {
        throw new Error('Codex model/list returned an invalid cursor.')
      }
      seen.add(page.nextCursor)
      cursor = page.nextCursor
    }
    throw new Error('Codex model/list exceeded the pagination limit.')
  }

  async startChat(params: ChatStartParams): Promise<{ chatId: string; sessionId: string | null }> {
    const client = await this.getClient()
    if (params.fastMode && this.modelCatalog.length === 0) await this.models().catch(() => [])
    const serviceTier = params.fastMode ? codexFastServiceTier(this.modelCatalog, params.model) : null
    const chatId = params.chatId || randomUUID()
    if (this.active.has(chatId)) throw new Error(`Chat ${chatId} is already active.`)
    const abort = new AbortController()
    const thread = params.sessionId
      ? await client.request<Record<string, unknown>>('thread/resume', {
          threadId: params.sessionId,
          model: params.model,
          cwd: params.cwd,
          approvalPolicy: 'never',
          sandbox: 'read-only',
          environments: [],
          config: LOCKED_THREAD_CONFIG,
          ...(serviceTier ? { serviceTier } : {}),
          // Dynamic tools are persisted by app-server on the original thread.
          // The host only resumes sessions whose tool signature still matches.
          ...codexInstructionOverride(params.systemPrompt),
        }, { signal: abort.signal, timeoutMs: 0 })
      : await client.request<Record<string, unknown>>('thread/start', {
          model: params.model,
          cwd: params.cwd,
          approvalPolicy: 'never',
          sandbox: 'read-only',
          environments: [],
          config: LOCKED_THREAD_CONFIG,
          ...(serviceTier ? { serviceTier } : {}),
          dynamicTools: codexDynamicTools(params.tools ?? []),
          ...codexInstructionOverride(params.systemPrompt),
        }, { signal: abort.signal, timeoutMs: 0 })
    const threadObject = isRecord(thread.thread) ? thread.thread : null
    const sessionId = typeof threadObject?.id === 'string' ? threadObject.id : params.sessionId
    if (!sessionId) throw new Error('Codex did not return a thread id.')
    const active: ActiveChat = {
      chatId,
      sessionId,
      turnId: null,
      abort,
      terminal: false,
      streamedText: new Set(),
      streamedReasoning: new Set(),
      unsubscribe: () => undefined,
    }
    active.unsubscribe = client.onNotification((notification) => this.handleNotification(active, notification))
    this.active.set(chatId, active)
    this.sessionChats.set(sessionId, chatId)
    this.emit(chatId, { type: 'started', sessionId })
    try {
      const started = await client.request<Record<string, unknown>>('turn/start', {
        threadId: sessionId,
        input: [{ type: 'text', text: params.prompt, text_elements: [] }],
        model: params.model,
        ...(serviceTier ? { serviceTier } : {}),
        ...(params.reasoningEffort ? { effort: params.reasoningEffort } : {}),
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      }, { signal: abort.signal, timeoutMs: 0 })
      active.turnId = isRecord(started.turn) && typeof started.turn.id === 'string' ? started.turn.id : null
    } catch (error) {
      this.finish(active, abort.signal.aborted ? { type: 'cancelled', sessionId } : { type: 'error', message: errorMessage(error) })
    }
    return { chatId, sessionId }
  }

  async cancelChat(chatId: string): Promise<{ cancelled: boolean }> {
    const active = this.active.get(chatId)
    if (!active) return { cancelled: false }
    active.abort.abort(new Error('Chat cancelled by host.'))
    if (active.turnId) {
      await (await this.getClient()).request('turn/interrupt', { threadId: active.sessionId, turnId: active.turnId }).catch(() => undefined)
    }
    this.finish(active, { type: 'cancelled', sessionId: active.sessionId })
    return { cancelled: true }
  }

  async disposeSession(sessionId: string): Promise<{ disposed: boolean }> {
    const chatId = this.sessionChats.get(sessionId)
    if (chatId) await this.cancelChat(chatId)
    await (await this.getClient()).request('thread/delete', { threadId: sessionId })
    this.sessionChats.delete(sessionId)
    return { disposed: true }
  }

  async dispose(): Promise<void> {
    await this.cancelAll()
    await this.client?.close()
    this.client = null
  }

  private async getClient(): Promise<CodexAppServer> {
    if (this.client) return this.client
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      await mkdir(this.codexHome, { recursive: true, mode: 0o700 })
      const binaryPath = await resolveCodexBinary(this.binaryOverride)
      const client = await CodexAppServer.connect({
        binaryPath,
        args: ['app-server'],
        env: codexEnvironment(this.codexHome),
        requestHandler: (request, signal) => this.handleServerRequest(request, signal),
      })
      client.onNotification((notification) => {
        if (notification.method === 'account/login/completed') {
          this.context.emit('provider.login.completed', { provider: this.name, result: notification.params })
        }
      })
      this.client = client
      return client
    })().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async handleServerRequest(request: AppServerRequest, signal: AbortSignal): Promise<unknown> {
    if (request.method !== 'item/tool/call') throw new Error(`Unsupported Codex server request: ${request.method}.`)
    const params = isRecord(request.params) ? request.params : {}
    const sessionId = typeof params.threadId === 'string' ? params.threadId : null
    const chatId = sessionId ? this.sessionChats.get(sessionId) : undefined
    if (!chatId) throw new Error('Codex tool call does not belong to an active chat.')
    const name = typeof params.tool === 'string' ? params.tool : ''
    const toolCallId = typeof params.callId === 'string' ? params.callId : typeof params.itemId === 'string' ? params.itemId : String(request.id)
    const input = params.arguments ?? {}
    this.emit(chatId, { type: 'tool_start', toolCallId, name, input })
    try {
      const result = await this.context.callHost<HostToolCallResult>('tool.call', {
        provider: this.name,
        chatId,
        sessionId,
        toolCallId,
        name,
        input,
      }, { signal, timeoutMs: 0 })
      const failed = result.isError === true || Boolean(result.error)
      this.emit(chatId, failed
        ? { type: 'tool_result', toolCallId, error: result.error || 'Tool failed.' }
        : { type: 'tool_result', toolCallId, output: result.output })
      const text = typeof result.output === 'string' ? result.output : result.output === undefined ? '' : JSON.stringify(result.output)
      return { contentItems: [{ type: 'inputText', text: result.error || text }], success: !failed }
    } catch (error) {
      const message = errorMessage(error)
      this.emit(chatId, { type: 'tool_result', toolCallId, error: message })
      return { contentItems: [{ type: 'inputText', text: message }], success: false }
    }
  }

  private handleNotification(active: ActiveChat, notification: AppServerNotification): void {
    if (active.terminal) return
    const params = isRecord(notification.params) ? notification.params : {}
    const threadId = typeof params.threadId === 'string' ? params.threadId : null
    if (threadId && threadId !== active.sessionId) return
    if (notification.method === 'turn/started' && isRecord(params.turn) && typeof params.turn.id === 'string') {
      active.turnId = params.turn.id
    }
    if (notification.method === 'item/agentMessage/delta' || notification.method === 'item/plan/delta') {
      if (typeof params.itemId === 'string') active.streamedText.add(params.itemId)
    }
    if (notification.method === 'item/reasoning/summaryTextDelta' && typeof params.itemId === 'string') {
      active.streamedReasoning.add(params.itemId)
    }
    const completedItem = notification.method === 'item/completed' && isRecord(params.item) ? params.item : null
    const completedId = typeof completedItem?.id === 'string' ? completedItem.id : null
    const skipCompleted = completedId && (
      ((completedItem?.type === 'agentMessage' || completedItem?.type === 'plan') && active.streamedText.has(completedId))
      || (completedItem?.type === 'reasoning' && active.streamedReasoning.has(completedId))
    )
    if (!skipCompleted) {
      for (const event of mapCodexNotification(notification)) this.emit(active.chatId, event)
    }
    if (notification.method === 'turn/completed') {
      const turn = isRecord(params.turn) ? params.turn : {}
      const status = typeof turn.status === 'string' ? turn.status : 'completed'
      if (status === 'completed') this.finish(active, { type: 'completed', sessionId: active.sessionId })
      else this.finish(active, { type: 'error', message: `Codex turn ended with status ${status}.` })
    }
  }

  private emit(chatId: string, event: ChatEvent): void {
    this.context.emit('chat.event', { chatId, provider: this.name, event })
  }

  private finish(active: ActiveChat, event: ChatEvent): void {
    if (active.terminal) return
    active.terminal = true
    active.unsubscribe()
    this.active.delete(active.chatId)
    this.emit(active.chatId, event)
  }

  private async cancelAll(): Promise<void> {
    await Promise.all([...this.active].map(([chatId]) => this.cancelChat(chatId)))
  }
}
