export type ProviderName = 'codex' | 'claude'
export type RpcId = string | number

export interface RpcRequest {
  id: RpcId
  method: string
  params?: unknown
}

export interface RpcNotification {
  method: string
  params?: unknown
}

export interface RpcErrorBody {
  code: number
  message: string
  data?: unknown
}

export interface ToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  deferLoading?: boolean
}

export interface ChatStartParams {
  provider: ProviderName
  chatId?: string
  sessionId?: string
  prompt: string
  model: string
  cwd: string
  systemPrompt?: string
  reasoningEffort?: string
  fastMode?: boolean
  tools?: ToolSpec[]
}

export type ChatEvent =
  | { type: 'started'; sessionId: string | null }
  | { type: 'text_delta'; text: string; partId?: string }
  | { type: 'reasoning_delta'; text: string; partId?: string }
  | { type: 'tool_start'; toolCallId: string; name: string; input: unknown }
  | { type: 'tool_result'; toolCallId: string; output?: unknown; error?: string }
  | {
      type: 'usage'
      inputTokens: number
      outputTokens: number
      cacheReadTokens?: number
      cacheWriteTokens?: number
      costUsd?: number
    }
  | { type: 'completed'; sessionId: string | null }
  | { type: 'cancelled'; sessionId: string | null }
  | { type: 'error'; message: string; code?: string }

export interface HostToolCallParams {
  provider: ProviderName
  chatId: string
  sessionId: string | null
  toolCallId: string
  name: string
  input: unknown
}

export interface HostToolCallResult {
  output?: unknown
  error?: string
  isError?: boolean
}

export interface ProviderStatus {
  provider: ProviderName
  available: boolean
  authenticated: boolean
  account: unknown | null
  version: string | null
  error: string | null
}

export interface ProviderContext {
  emit(method: string, params?: unknown): void
  callHost<T>(method: string, params?: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T>
}

export interface AiProvider {
  readonly name: ProviderName
  status(refresh?: boolean): Promise<ProviderStatus>
  login(signal?: AbortSignal): Promise<unknown>
  logout(): Promise<unknown>
  models(signal?: AbortSignal): Promise<unknown[]>
  startChat(params: ChatStartParams): Promise<{ chatId: string; sessionId: string | null }>
  cancelChat(chatId: string): Promise<{ cancelled: boolean }>
  disposeSession(sessionId: string): Promise<{ disposed: boolean }>
  dispose(): Promise<void>
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
