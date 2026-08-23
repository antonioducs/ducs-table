import { describe, expect, it } from 'vitest'
import { codexDynamicTools, codexFastServiceTier, codexInstructionOverride, mapCodexNotification } from '../src/codex/provider.js'

describe('Codex adapter', () => {
  it('selects the provider-advertised priority tier for Fast mode', () => {
    expect(codexFastServiceTier([{ id: 'gpt-test', serviceTiers: [{ id: 'standard' }, { id: 'priority' }] }], 'gpt-test')).toBe('priority')
    expect(codexFastServiceTier([{ id: 'gpt-test', serviceTiers: [{ id: 'standard' }] }], 'gpt-test')).toBeNull()
  })
  it('registers deferred tools inside a namespace', () => {
    expect(codexDynamicTools([
      { name: 'query', description: 'Run query', inputSchema: { type: 'object' } },
      { name: 'catalog', description: 'Browse catalog', inputSchema: { type: 'object' }, deferLoading: true },
    ])).toEqual([
      { type: 'function', name: 'query', description: 'Run query', inputSchema: { type: 'object' } },
      {
        type: 'namespace',
        name: 'ducs_deferred',
        description: 'DUCS Table tools loaded on demand.',
        tools: [{ type: 'function', name: 'catalog', description: 'Browse catalog', inputSchema: { type: 'object' }, deferLoading: true }],
      },
    ])
  })

  it('reapplies developer instructions when a Codex thread is resumed', () => {
    expect(codexInstructionOverride('Use DUCS tools')).toEqual({ developerInstructions: 'Use DUCS tools' })
    expect(codexInstructionOverride()).toEqual({})
  })

  it('normalizes text, reasoning and usage notifications', () => {
    expect(mapCodexNotification({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'hello' } }))
      .toEqual([{ type: 'text_delta', text: 'hello', partId: 'a' }])
    expect(mapCodexNotification({ method: 'item/reasoning/summaryTextDelta', params: { delta: 'why' } }))
      .toEqual([{ type: 'reasoning_delta', text: 'why' }])
    expect(mapCodexNotification({
      method: 'thread/tokenUsage/updated',
      params: { tokenUsage: { total: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 3 } } },
    })).toEqual([{ type: 'usage', inputTokens: 12, outputTokens: 4, cacheReadTokens: 3 }])
  })
})
