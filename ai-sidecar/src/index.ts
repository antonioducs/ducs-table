#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { SidecarServer } from './server.js'

export * from './types.js'
export * from './jsonl-peer.js'
export * from './environment.js'
export * from './codex/provider.js'
export * from './claude/stream.js'
export { SidecarServer } from './server.js'

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = new SidecarServer({ input: process.stdin, output: process.stdout })
  const shutdown = (): void => {
    void server.dispose().finally(() => {
      process.stdin.pause()
      process.exitCode = 0
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  process.stdin.resume()
}
