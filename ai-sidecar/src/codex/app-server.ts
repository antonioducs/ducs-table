import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import { errorMessage, isRecord, type RpcId } from '../types.js'

export interface AppServerRequest {
  id: RpcId
  method: string
  params: unknown
}

export interface AppServerNotification {
  method: string
  params: unknown
}

interface Pending {
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
  cleanup(): void
}

export interface CodexAppServerOptions {
  binaryPath: string
  args?: string[]
  cwd?: string
  env: Record<string, string>
  requestHandler(request: AppServerRequest, signal: AbortSignal): Promise<unknown>
}

export class CodexAppServer {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly lines: readline.Interface
  private readonly pending = new Map<RpcId, Pending>()
  private readonly listeners = new Set<(notification: AppServerNotification) => void>()
  private readonly serverRequests = new AbortController()
  private nextId = 1
  private closed = false
  private stderr = ''

  private constructor(private readonly options: CodexAppServerOptions) {
    this.child = spawn(options.binaryPath, options.args ?? ['app-server'], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Number.POSITIVE_INFINITY })
    this.lines.on('line', (line) => void this.handleLine(line))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-16_384)
    })
    this.child.once('error', (error) => this.fail(error))
    this.child.once('close', (code, signal) => {
      if (!this.closed) this.fail(new Error(`Codex app-server exited (code=${String(code)}, signal=${String(signal)}): ${this.stderr}`))
    })
  }

  static async connect(options: CodexAppServerOptions): Promise<CodexAppServer> {
    const server = new CodexAppServer(options)
    await new Promise<void>((resolve, reject) => {
      server.child.once('spawn', resolve)
      server.child.once('error', reject)
    })
    try {
      await server.rawRequest('initialize', {
        clientInfo: { name: 'ducs-table', title: 'DUCS Table', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      })
      server.write({ method: 'initialized', params: {} })
      return server
    } catch (error) {
      await server.close()
      throw error
    }
  }

  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  request<T>(method: string, params?: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T> {
    return this.rawRequest(method, params, options) as Promise<T>
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.serverRequests.abort(new Error('Codex app-server closed.'))
    this.lines.close()
    this.child.stdin.end()
    const exited = new Promise<void>((resolve) => this.child.once('close', () => resolve()))
    const timer = setTimeout(() => this.child.kill(), 500)
    timer.unref()
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1_000))])
    clearTimeout(timer)
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL')
    this.rejectAll(new Error('Codex app-server closed.'))
  }

  private rawRequest(
    method: string,
    params?: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Codex app-server is closed.'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      const cleanup = (): void => {
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
      }
      const abort = (): void => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        pending.cleanup()
        reject(options.signal?.reason ?? new Error(`Codex request ${method} aborted.`))
      }
      if (options.signal?.aborted) {
        reject(options.signal.reason ?? new Error(`Codex request ${method} aborted.`))
        return
      }
      const timeoutMs = options.timeoutMs ?? 30_000
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const pending = this.pending.get(id)
          if (!pending) return
          this.pending.delete(id)
          pending.cleanup()
          reject(new Error(`Codex request ${method} timed out after ${timeoutMs}ms.`))
        }, timeoutMs)
        timer.unref()
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(id, { method, resolve, reject, cleanup })
      this.write({ id, method, ...(params === undefined ? {} : { params }) })
    })
  }

  private async handleLine(line: string): Promise<void> {
    if (!line.trim()) return
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return
    }
    if (!isRecord(value)) return
    const id = typeof value.id === 'string' || typeof value.id === 'number' ? value.id : null
    if (id !== null && typeof value.method === 'string') {
      try {
        const result = await this.options.requestHandler(
          { id, method: value.method, params: value.params },
          this.serverRequests.signal,
        )
        this.write({ id, result: result ?? null })
      } catch (error) {
        this.write({ id, error: { code: -32603, message: errorMessage(error) } })
      }
      return
    }
    if (typeof value.method === 'string') {
      const notification = { method: value.method, params: value.params }
      for (const listener of this.listeners) listener(notification)
      return
    }
    if (id === null) return
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    pending.cleanup()
    if (isRecord(value.error)) {
      pending.reject(new Error(typeof value.error.message === 'string' ? value.error.message : `${pending.method} failed.`))
    } else {
      pending.resolve(value.result)
    }
  }

  private write(value: unknown): void {
    if (!this.closed && !this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify(value)}\n`)
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    this.serverRequests.abort(error)
    this.rejectAll(error)
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.cleanup()
      pending.reject(error)
    }
  }
}
