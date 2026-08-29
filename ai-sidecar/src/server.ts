import os from 'node:os'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { ClaudeProvider } from './claude/provider.js'
import { CodexProvider } from './codex/provider.js'
import { JsonlPeer } from './jsonl-peer.js'
import type { AiProvider, ChatStartParams, ProviderContext, ProviderName, RpcRequest } from './types.js'
import { isRecord } from './types.js'
import { APP_VERSION } from './version.js'

function providerName(value: unknown): ProviderName {
  if (value === 'codex' || value === 'claude') return value
  throw Object.assign(new Error('params.provider must be "codex" or "claude".'), { code: -32602 })
}

function requestParams(request: RpcRequest): Record<string, unknown> {
  if (!isRecord(request.params)) throw Object.assign(new Error('RPC params must be an object.'), { code: -32602 })
  return request.params
}

export interface SidecarServerOptions {
  input: Readable
  output: Writable
  dataDirectory?: string
  codexBinary?: string
  claudeBinary?: string
}

export class SidecarServer {
  readonly peer: JsonlPeer
  private readonly providers: Record<ProviderName, AiProvider>
  private readonly chatProviders = new Map<string, ProviderName>()
  private disposed = false

  constructor(options: SidecarServerOptions) {
    this.peer = new JsonlPeer(options.input, options.output)
    const dataDirectory = options.dataDirectory ?? process.env.DUCS_AI_HOME ?? path.join(os.homedir(), '.ducs-table', 'ai-sidecar')
    const context: ProviderContext = {
      emit: (method, params) => this.peer.notify(method, params),
      callHost: (method, params, callOptions) => this.peer.request(method, params, callOptions),
    }
    this.providers = {
      codex: new CodexProvider(context, path.join(dataDirectory, 'codex'), options.codexBinary),
      claude: new ClaudeProvider(context, path.join(dataDirectory, 'claude'), options.claudeBinary),
    }
    this.peer.onRequest((request) => this.handle(request))
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await Promise.all(Object.values(this.providers).map((provider) => provider.dispose()))
    this.peer.close()
  }

  private async handle(request: RpcRequest): Promise<unknown> {
    if (this.disposed) throw new Error('Sidecar is shutting down.')
    if (request.method === 'ping') return { ok: true, version: APP_VERSION }
    if (request.method === 'status') {
      const params = isRecord(request.params) ? request.params : {}
      if (params.provider === undefined) return Promise.all(Object.values(this.providers).map((provider) => provider.status(params.refresh === true)))
      return this.providers[providerName(params.provider)].status(params.refresh === true)
    }
    if (request.method === 'login' || request.method === 'provider.login') {
      const params = requestParams(request)
      return this.providers[providerName(params.provider)].login()
    }
    if (request.method === 'logout' || request.method === 'provider.logout') {
      const params = requestParams(request)
      return this.providers[providerName(params.provider)].logout()
    }
    if (request.method === 'models' || request.method === 'provider.models') {
      const params = requestParams(request)
      return this.providers[providerName(params.provider)].models()
    }
    if (request.method === 'provider.status') {
      const params = requestParams(request)
      return this.providers[providerName(params.provider)].status(params.refresh === true)
    }
    if (request.method === 'chat.start') {
      const params = requestParams(request)
      const name = providerName(params.provider)
      if (typeof params.prompt !== 'string' || typeof params.model !== 'string' || typeof params.cwd !== 'string') {
        throw Object.assign(new Error('chat.start requires prompt, model, and cwd strings.'), { code: -32602 })
      }
      const result = await this.providers[name].startChat(params as unknown as ChatStartParams)
      this.chatProviders.set(result.chatId, name)
      return result
    }
    if (request.method === 'chat.cancel') {
      const params = requestParams(request)
      if (typeof params.chatId !== 'string') throw Object.assign(new Error('chat.cancel requires chatId.'), { code: -32602 })
      const name = params.provider === undefined ? this.chatProviders.get(params.chatId) : providerName(params.provider)
      if (!name) return { cancelled: false }
      const result = await this.providers[name].cancelChat(params.chatId)
      this.chatProviders.delete(params.chatId)
      return result
    }
    if (request.method === 'chat.disposeSession') {
      const params = requestParams(request)
      if (typeof params.sessionId !== 'string') throw Object.assign(new Error('chat.disposeSession requires sessionId.'), { code: -32602 })
      return this.providers[providerName(params.provider)].disposeSession(params.sessionId)
    }
    if (request.method === 'shutdown') {
      setTimeout(() => void this.dispose(), 0)
      return { ok: true }
    }
    throw Object.assign(new Error(`Unknown RPC method: ${request.method}.`), { code: -32601 })
  }
}
