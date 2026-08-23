import type { ChatEvent } from '../types.js'
import { isRecord } from '../types.js'

export interface ClaudeStreamState {
  activeMessageId: string | null
  streamedText: Set<string>
  streamedReasoning: Set<string>
}

export function createClaudeStreamState(): ClaudeStreamState {
  return { activeMessageId: null, streamedText: new Set(), streamedReasoning: new Set() }
}

export function mapClaudeMessage(message: unknown, state: ClaudeStreamState): ChatEvent[] {
  if (!isRecord(message)) return []
  if (message.type === 'stream_event' && isRecord(message.event)) {
    const event = message.event
    if (event.type === 'message_start' && isRecord(event.message)) {
      state.activeMessageId = typeof event.message.id === 'string' ? event.message.id : null
      return []
    }
    if (event.type === 'message_stop') {
      state.activeMessageId = null
      return []
    }
    const index = Number(event.index) || 0
    const partId = `${state.activeMessageId ?? 'stream'}:${index}`
    if (event.type === 'content_block_start' && isRecord(event.content_block)) {
      if (event.content_block.type === 'text' && typeof event.content_block.text === 'string' && event.content_block.text) {
        if (state.activeMessageId) state.streamedText.add(state.activeMessageId)
        return [{ type: 'text_delta', text: event.content_block.text, partId }]
      }
      if (event.content_block.type === 'thinking' && typeof event.content_block.thinking === 'string' && event.content_block.thinking) {
        if (state.activeMessageId) state.streamedReasoning.add(state.activeMessageId)
        return [{ type: 'reasoning_delta', text: event.content_block.thinking, partId }]
      }
    }
    if (event.type === 'content_block_delta' && isRecord(event.delta)) {
      if (event.delta.type === 'text_delta' && typeof event.delta.text === 'string') {
        if (state.activeMessageId) state.streamedText.add(state.activeMessageId)
        return [{ type: 'text_delta', text: event.delta.text, partId }]
      }
      if (event.delta.type === 'thinking_delta' && typeof event.delta.thinking === 'string') {
        if (state.activeMessageId) state.streamedReasoning.add(state.activeMessageId)
        return [{ type: 'reasoning_delta', text: event.delta.thinking, partId }]
      }
    }
    return []
  }
  if (message.type === 'assistant' && isRecord(message.message) && Array.isArray(message.message.content)) {
    const messageId = typeof message.message.id === 'string' ? message.message.id : ''
    const events: ChatEvent[] = []
    for (const [index, block] of message.message.content.entries()) {
      if (!isRecord(block)) continue
      if (block.type === 'text' && typeof block.text === 'string' && !state.streamedText.has(messageId)) {
        events.push({ type: 'text_delta', text: block.text, partId: `${messageId}:${index}` })
      }
      if (block.type === 'thinking' && typeof block.thinking === 'string' && !state.streamedReasoning.has(messageId)) {
        events.push({ type: 'reasoning_delta', text: block.thinking, partId: `${messageId}:${index}` })
      }
    }
    return events
  }
  if (message.type === 'result' && isRecord(message.usage)) {
    return [{
      type: 'usage',
      inputTokens: Number(message.usage.input_tokens) || 0,
      outputTokens: Number(message.usage.output_tokens) || 0,
      ...(Number(message.usage.cache_read_input_tokens) > 0 ? { cacheReadTokens: Number(message.usage.cache_read_input_tokens) } : {}),
      ...(Number(message.usage.cache_creation_input_tokens) > 0 ? { cacheWriteTokens: Number(message.usage.cache_creation_input_tokens) } : {}),
      ...(Number(message.total_cost_usd) >= 0 ? { costUsd: Number(message.total_cost_usd) } : {}),
    }]
  }
  return []
}
