import { describe, expect, it } from 'vitest'
import { createClaudeStreamState, mapClaudeMessage } from '../src/claude/stream.js'
import { jsonSchemaToZod } from '../src/claude/tools.js'
import { compatibleClaudeCodeVersion, resolveClaudeExecutable } from '../src/claude/provider.js'

describe('Claude adapter', () => {
  it('requires a compatible Claude Code release', () => {
    expect(compatibleClaudeCodeVersion('2.1.220')).toBe(true)
    expect(compatibleClaudeCodeVersion('2.2.0')).toBe(true)
    expect(compatibleClaudeCodeVersion('2.1.219')).toBe(false)
    expect(compatibleClaudeCodeVersion('3.0.0')).toBe(false)
  })

  it('honors an explicit Claude Code executable', () => {
    expect(resolveClaudeExecutable('claude-test')).toBe('claude-test')
  })
  it('converts host JSON schemas to strict Zod input validation', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: { sql: { type: 'string' }, limit: { type: 'integer' } },
      required: ['sql'],
      additionalProperties: false,
    })

    expect(schema.safeParse({ sql: 'select 1', limit: 10 }).success).toBe(true)
    expect(schema.safeParse({ limit: 10 }).success).toBe(false)
    expect(schema.safeParse({ sql: 'select 1', extra: true }).success).toBe(false)
  })

  it('normalizes partial text and does not duplicate the final assistant frame', () => {
    const state = createClaudeStreamState()
    mapClaudeMessage({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } }, state)
    expect(mapClaudeMessage({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
    }, state)).toEqual([{ type: 'text_delta', text: 'hello', partId: 'm1:0' }])
    expect(mapClaudeMessage({
      type: 'assistant',
      message: { id: 'm1', content: [{ type: 'text', text: 'hello' }] },
    }, state)).toEqual([])
  })

  it('normalizes terminal usage', () => {
    expect(mapClaudeMessage({
      type: 'result',
      total_cost_usd: 0.02,
      usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 2 },
    }, createClaudeStreamState())).toEqual([
      { type: 'usage', inputTokens: 20, outputTokens: 5, cacheReadTokens: 2, costUsd: 0.02 },
    ])
  })
})
