import readline from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { errorMessage, isRecord, type RpcErrorBody, type RpcId, type RpcRequest } from './types.js'

export class RpcRemoteError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'RpcRemoteError'
  }
}

type RequestHandler = (request: RpcRequest) => unknown | Promise<unknown>

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  cleanup(): void
}

export class JsonlPeer {
  private readonly lines: readline.Interface
  private readonly pending = new Map<RpcId, PendingRequest>()
  private nextId = 1
  private handler: RequestHandler | null = null
  private closed = false

  constructor(
    input: Readable,
    private readonly output: Writable,
  ) {
    this.lines = readline.createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
    this.lines.on('line', (line) => void this.handleLine(line))
    this.lines.once('close', () => this.close(new Error('RPC input closed.')))
    input.once('error', (error) => this.close(error))
    output.once('error', (error) => this.close(error))
  }

  onRequest(handler: RequestHandler): void {
    this.handler = handler
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) })
  }

  request<T>(
    method: string,
    params?: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('RPC peer is closed.'))
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new Error('RPC request aborted.'))
    const id = `sidecar:${this.nextId++}`
    return new Promise<T>((resolve, reject) => {
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
        reject(options.signal?.reason ?? new Error('RPC request aborted.'))
      }
      const timeoutMs = options.timeoutMs ?? 120_000
      if (timeoutMs > 0) {
        timer = setTimeout(() => abort(), timeoutMs)
        timer.unref()
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, cleanup })
      this.write({ id, method, ...(params === undefined ? {} : { params }) })
    })
  }

  close(reason: Error = new Error('RPC peer closed.')): void {
    if (this.closed) return
    this.closed = true
    this.lines.close()
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.cleanup()
      pending.reject(reason)
    }
  }

  private async handleLine(line: string): Promise<void> {
    if (!line.trim()) return
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      this.notify('protocol.error', { message: 'Invalid JSON.', line })
      return
    }
    if (!isRecord(value)) {
      this.notify('protocol.error', { message: 'RPC message must be an object.' })
      return
    }
    const id = typeof value.id === 'string' || typeof value.id === 'number' ? value.id : null
    if (id !== null && typeof value.method !== 'string') {
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      pending.cleanup()
      if (isRecord(value.error) && typeof value.error.message === 'string') {
        pending.reject(
          new RpcRemoteError(
            value.error.message,
            typeof value.error.code === 'number' ? value.error.code : -32000,
            value.error.data,
          ),
        )
      } else {
        pending.resolve(value.result)
      }
      return
    }
    if (id === null || typeof value.method !== 'string') return
    if (!this.handler) {
      this.respondError(id, { code: -32601, message: 'No RPC request handler is registered.' })
      return
    }
    try {
      const result = await this.handler({ id, method: value.method, params: value.params })
      this.write({ id, result: result === undefined ? null : result })
    } catch (error) {
      const code = isRecord(error) && typeof error.code === 'number' ? error.code : -32000
      this.respondError(id, { code, message: errorMessage(error) })
    }
  }

  private respondError(id: RpcId, error: RpcErrorBody): void {
    this.write({ id, error })
  }

  private write(value: unknown): void {
    if (this.closed) return
    this.output.write(`${JSON.stringify(value)}\n`)
  }
}
