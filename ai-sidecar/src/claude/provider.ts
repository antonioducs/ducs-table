import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import {
  deleteSession,
  query,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { claudeEnvironment } from '../environment.js'
import type { AiProvider, ChatEvent, ChatStartParams, ProviderContext, ProviderStatus } from '../types.js'
import { errorMessage, isRecord } from '../types.js'
import { CLAUDE_NATIVE_TOOLS, createClaudeToolBridge } from './tools.js'
import { createClaudeStreamState, mapClaudeMessage } from './stream.js'

interface ActiveClaudeChat {
  chatId: string
  query: Query
  abort: AbortController
  sessionId: string | null
  cwd: string
  terminal: boolean
}

interface ProcessResult {
  code: number | null
  stdout: string
  stderr: string
}

const MINIMUM_CLAUDE_CODE_VERSION = [2, 1, 220] as const

export function compatibleClaudeCodeVersion(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((part) => Number.parseInt(part, 10) || 0)
  if (major !== MINIMUM_CLAUDE_CODE_VERSION[0]) return false
  if (minor !== MINIMUM_CLAUDE_CODE_VERSION[1]) return minor > MINIMUM_CLAUDE_CODE_VERSION[1]
  return patch >= MINIMUM_CLAUDE_CODE_VERSION[2]
}

export function resolveClaudeExecutable(override = process.env.DUCS_CLAUDE_BINARY): string {
  const candidates = [
    override,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
    process.platform === 'win32' ? 'claude.exe' : 'claude',
  ].filter((candidate): candidate is string => Boolean(candidate))
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) return candidate
    try {
      accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
      return candidate
    } catch {
      // Try the next known installation path.
    }
  }
  return process.platform === 'win32' ? 'claude.exe' : 'claude'
}

async function* emptyPrompt(): AsyncIterable<SDKUserMessage> {}

function parseAuth(raw: string): { authenticated: boolean; account: unknown | null } {
  const value: unknown = JSON.parse(raw)
  if (!isRecord(value)) throw new Error('Claude auth status returned invalid JSON.')
  if (value.loggedIn !== true) return { authenticated: false, account: null }
  if (value.apiProvider !== 'firstParty' || value.authMethod !== 'claude.ai' || !value.subscriptionType) {
    throw new Error('Claude CLI is not authenticated with a verifiable Claude.ai subscription.')
  }
  return { authenticated: true, account: value }
}

export class ClaudeProvider implements AiProvider {
  readonly name = 'claude' as const
  private readonly active = new Map<string, ActiveClaudeChat>()
  private readonly sessions = new Map<string, string>()

  constructor(
    private readonly context: ProviderContext,
    private readonly configDirectory: string,
    private readonly executable = resolveClaudeExecutable(),
  ) {}

  async status(): Promise<ProviderStatus> {
    try {
      await this.prepare()
      const versionResult = await this.run(['--version'])
      const version = (versionResult.stdout || versionResult.stderr).match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null
      if (versionResult.code !== 0 || !version) throw new Error(versionResult.stderr || 'Claude CLI is unavailable.')
      if (!compatibleClaudeCodeVersion(version)) throw new Error(`Claude Code ${version} is incompatible; version 2.1.220 or newer in the 2.x line is required.`)
      const authResult = await this.run(['auth', 'status', '--json'])
      if (authResult.code !== 0 && !authResult.stdout.trim()) throw new Error(authResult.stderr || 'Claude auth status failed.')
      const auth = parseAuth(authResult.stdout)
      return { provider: this.name, available: true, authenticated: auth.authenticated, account: auth.account, version, error: null }
    } catch (error) {
      return { provider: this.name, available: false, authenticated: false, account: null, version: null, error: errorMessage(error) }
    }
  }

  async login(signal?: AbortSignal): Promise<unknown> {
    await this.cancelAll()
    await rm(this.configDirectory, { recursive: true, force: true })
    await this.prepare()
    const result = await this.run(['auth', 'login', '--claudeai'], signal, (stream, text) => {
      this.context.emit('provider.login.output', { provider: this.name, stream, text })
    })
    if (result.code !== 0) throw new Error(result.stderr || 'Claude login did not complete.')
    return this.status()
  }

  async logout(): Promise<unknown> {
    await this.cancelAll()
    await rm(this.configDirectory, { recursive: true, force: true })
    await this.prepare()
    return this.status()
  }

  async models(signal?: AbortSignal): Promise<unknown[]> {
    await this.prepare()
    const abort = new AbortController()
    const onAbort = (): void => abort.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    const session = query({
      prompt: emptyPrompt(),
      options: {
        abortController: abort,
        pathToClaudeCodeExecutable: this.executable,
        env: claudeEnvironment(this.configDirectory),
        settingSources: [],
        strictMcpConfig: true,
        tools: [],
        allowedTools: [],
        disallowedTools: [...CLAUDE_NATIVE_TOOLS],
        skills: [],
        plugins: [],
        agents: {},
        mcpServers: {},
        permissionMode: 'dontAsk',
        persistSession: false,
      },
    })
    try {
      await session.initializationResult()
      return await session.supportedModels()
    } finally {
      signal?.removeEventListener('abort', onAbort)
      session.close()
    }
  }

  async startChat(params: ChatStartParams): Promise<{ chatId: string; sessionId: string | null }> {
    await this.prepare()
    const chatId = params.chatId || randomUUID()
    if (this.active.has(chatId)) throw new Error(`Chat ${chatId} is already active.`)
    const abort = new AbortController()
    let active!: ActiveClaudeChat
    const emit = (event: ChatEvent): void => this.emit(chatId, event)
    const bridge = createClaudeToolBridge({
      tools: params.tools ?? [],
      chatId,
      sessionId: () => active?.sessionId ?? params.sessionId ?? null,
      context: this.context,
      signal: abort.signal,
      emit,
    })
    const effort = params.reasoningEffort
    const validEffort = effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh' || effort === 'max'
    const options: Options = {
      abortController: abort,
      pathToClaudeCodeExecutable: this.executable,
      env: claudeEnvironment(this.configDirectory),
      cwd: params.cwd,
      model: params.model,
      ...(validEffort ? { effort } : {}),
      ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
      ...(params.sessionId ? { resume: params.sessionId } : {}),
      settingSources: [],
      settings: {
        fastMode: Boolean(params.fastMode),
        fastModePerSessionOptIn: true,
        promptSuggestionEnabled: false,
        autoMemoryEnabled: false,
        autoCompactEnabled: false,
        precomputeCompactionEnabled: false,
      },
      strictMcpConfig: true,
      mcpServers: { ducs: bridge.server },
      tools: [],
      allowedTools: bridge.allowedTools,
      disallowedTools: [...CLAUDE_NATIVE_TOOLS],
      skills: [],
      plugins: [],
      agents: {},
      hooks: { PreToolUse: [bridge.preToolUseHook] },
      permissionMode: 'dontAsk',
      includePartialMessages: true,
      promptSuggestions: false,
      persistSession: true,
    }
    const sdkQuery = query({ prompt: params.prompt, options })
    active = { chatId, query: sdkQuery, abort, sessionId: params.sessionId ?? null, cwd: params.cwd, terminal: false }
    this.active.set(chatId, active)
    if (active.sessionId) {
      this.sessions.set(active.sessionId, params.cwd)
      this.emit(chatId, { type: 'started', sessionId: active.sessionId })
    }
    void this.consume(active)
    return { chatId, sessionId: active.sessionId }
  }

  async cancelChat(chatId: string): Promise<{ cancelled: boolean }> {
    const active = this.active.get(chatId)
    if (!active) return { cancelled: false }
    active.abort.abort(new Error('Chat cancelled by host.'))
    await active.query.interrupt().catch(() => undefined)
    active.query.close()
    this.finish(active, { type: 'cancelled', sessionId: active.sessionId })
    return { cancelled: true }
  }

  async disposeSession(sessionId: string): Promise<{ disposed: boolean }> {
    const active = [...this.active.values()].find((entry) => entry.sessionId === sessionId)
    if (active) await this.cancelChat(active.chatId)
    await deleteSession(sessionId, { dir: this.sessions.get(sessionId) ?? process.cwd() })
    this.sessions.delete(sessionId)
    return { disposed: true }
  }

  async dispose(): Promise<void> {
    await this.cancelAll()
  }

  private async consume(active: ActiveClaudeChat): Promise<void> {
    const streamState = createClaudeStreamState()
    try {
      for await (const message of active.query as AsyncIterable<SDKMessage>) {
        if (active.terminal) break
        if ('session_id' in message && typeof message.session_id === 'string' && !active.sessionId) {
          active.sessionId = message.session_id
          this.sessions.set(message.session_id, active.cwd)
          this.emit(active.chatId, { type: 'started', sessionId: message.session_id })
        }
        for (const event of mapClaudeMessage(message, streamState)) this.emit(active.chatId, event)
        if (message.type === 'result') {
          if (message.subtype === 'success') this.finish(active, { type: 'completed', sessionId: active.sessionId })
          else this.finish(active, { type: 'error', message: message.errors.join('\n') || `Claude ended with ${message.subtype}.` })
        }
      }
      if (!active.terminal) this.finish(active, { type: 'error', message: 'Claude ended without a result.' })
    } catch (error) {
      this.finish(active, active.abort.signal.aborted
        ? { type: 'cancelled', sessionId: active.sessionId }
        : { type: 'error', message: errorMessage(error) })
    } finally {
      active.query.close()
    }
  }

  private emit(chatId: string, event: ChatEvent): void {
    this.context.emit('chat.event', { chatId, provider: this.name, event })
  }

  private finish(active: ActiveClaudeChat, event: ChatEvent): void {
    if (active.terminal) return
    active.terminal = true
    this.active.delete(active.chatId)
    this.emit(active.chatId, event)
  }

  private async prepare(): Promise<void> {
    await mkdir(this.configDirectory, { recursive: true, mode: 0o700 })
  }

  private run(
    args: string[],
    signal?: AbortSignal,
    output?: (stream: 'stdout' | 'stderr', text: string) => void,
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, args, {
        env: claudeEnvironment(this.configDirectory),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        signal,
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { stdout += chunk; output?.('stdout', chunk) })
      child.stderr.on('data', (chunk: string) => { stderr += chunk; output?.('stderr', chunk) })
      child.once('error', reject)
      child.once('close', (code) => resolve({ code, stdout, stderr }))
    })
  }

  private async cancelAll(): Promise<void> {
    await Promise.all([...this.active].map(([chatId]) => this.cancelChat(chatId)))
  }
}
