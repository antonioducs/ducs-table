import { createHash } from 'node:crypto'
import {
  createSdkMcpServer,
  tool as claudeTool,
  type HookCallbackMatcher,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { ChatEvent, HostToolCallResult, ProviderContext, ToolSpec } from '../types.js'
import { isRecord } from '../types.js'

export const CLAUDE_NATIVE_TOOLS = [
  'Agent', 'Task', 'Skill', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList',
  'AskUserQuestion', 'ExitPlanMode', 'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'NotebookEdit',
] as const

const MCP_PREFIX = 'mcp__ducs__'

function schemaRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

export function jsonSchemaToZod(raw: unknown): z.ZodType {
  const schema = schemaRecord(raw)
  if (schema.const !== undefined) return z.literal(schema.const as string | number | boolean | null)
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const literals = schema.enum.map((entry) => z.literal(entry as string | number | boolean | null))
    return literals.length === 1
      ? literals[0]!
      : z.union(literals as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]])
  }
  const choices = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : null
  if (choices?.length) {
    const converted = choices.map(jsonSchemaToZod)
    return converted.length === 1 ? converted[0]! : z.union(converted as [z.ZodType, z.ZodType, ...z.ZodType[]])
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  const nullable = types.includes('null') || schema.nullable === true
  const type = types.find((entry) => entry !== 'null')
  let result: z.ZodType
  switch (type) {
    case 'string': result = z.string(); break
    case 'integer': result = z.number().int(); break
    case 'number': result = z.number(); break
    case 'boolean': result = z.boolean(); break
    case 'array': result = z.array(jsonSchemaToZod(schema.items)); break
    case 'object':
    default: {
      const required = new Set(Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === 'string') : [])
      const shape: Record<string, z.ZodType> = {}
      for (const [name, property] of Object.entries(schemaRecord(schema.properties))) {
        const converted = jsonSchemaToZod(property)
        shape[name] = required.has(name) ? converted : converted.optional()
      }
      const object = z.object(shape)
      result = schema.additionalProperties === false ? object.strict() : object.loose()
    }
  }
  return nullable ? result.nullable() : result
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]))
}

function callKey(name: string, input: unknown): string {
  return `${name}\0${createHash('sha256').update(JSON.stringify(canonical(input)) ?? 'undefined').digest('hex')}`
}

export interface ClaudeToolBridge {
  server: McpSdkServerConfigWithInstance
  allowedTools: string[]
  preToolUseHook: HookCallbackMatcher
}

export function createClaudeToolBridge(args: {
  tools: readonly ToolSpec[]
  chatId: string
  sessionId: () => string | null
  context: ProviderContext
  signal: AbortSignal
  emit(event: ChatEvent): void
}): ClaudeToolBridge {
  const idsByCall = new Map<string, string[]>()
  const waiters = new Map<string, Array<(id: string) => void>>()
  const names = new Set(args.tools.map((spec) => spec.name))
  const definitions: SdkMcpToolDefinition<any>[] = []

  const announce = (name: string, input: unknown, id: string): void => {
    const key = callKey(name, input)
    const waiter = waiters.get(key)?.shift()
    if (waiter) waiter(id)
    else idsByCall.set(key, [...(idsByCall.get(key) ?? []), id])
  }
  const claim = (name: string, input: unknown): Promise<string> => {
    const key = callKey(name, input)
    const queued = idsByCall.get(key)?.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Claude tool ${name} did not receive a tool-use id.`)), 10_000)
      timeout.unref()
      const done = (id: string): void => {
        clearTimeout(timeout)
        resolve(id)
      }
      waiters.set(key, [...(waiters.get(key) ?? []), done])
      args.signal.addEventListener('abort', () => {
        clearTimeout(timeout)
        reject(args.signal.reason ?? new Error('Claude tool call aborted.'))
      }, { once: true })
    })
  }

  for (const spec of args.tools) {
    const schema = jsonSchemaToZod(spec.inputSchema)
    const shape = schema instanceof z.ZodObject ? schema.shape : { input: schema }
    definitions.push(claudeTool(spec.name, spec.description, shape, async (rawInput) => {
      args.signal.throwIfAborted()
      const input = 'input' in shape && Object.keys(shape).length === 1
        ? (rawInput as { input: unknown }).input
        : rawInput
      const toolCallId = await claim(spec.name, rawInput)
      args.emit({ type: 'tool_start', toolCallId, name: spec.name, input })
      try {
        const result = await args.context.callHost<HostToolCallResult>('tool.call', {
          provider: 'claude',
          chatId: args.chatId,
          sessionId: args.sessionId(),
          toolCallId,
          name: spec.name,
          input,
        }, { signal: args.signal, timeoutMs: 0 })
        const failed = result.isError === true || Boolean(result.error)
        args.emit(failed
          ? { type: 'tool_result', toolCallId, error: result.error || 'Tool failed.' }
          : { type: 'tool_result', toolCallId, output: result.output })
        const text = result.error || (typeof result.output === 'string' ? result.output : JSON.stringify(result.output ?? null))
        return { content: [{ type: 'text' as const, text }], isError: failed }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        args.emit({ type: 'tool_result', toolCallId, error: message })
        return { content: [{ type: 'text' as const, text: message }], isError: true }
      }
    }, { alwaysLoad: spec.deferLoading !== true }))
  }

  return {
    server: createSdkMcpServer({ name: 'ducs', version: '1.0.0', tools: definitions }),
    allowedTools: [...names].map((name) => `${MCP_PREFIX}${name}`),
    preToolUseHook: {
      hooks: [async (input, toolUseId) => {
        if (input.hook_event_name !== 'PreToolUse') return { continue: true }
        const name = input.tool_name.startsWith(MCP_PREFIX) ? input.tool_name.slice(MCP_PREFIX.length) : input.tool_name
        const id = toolUseId ?? input.tool_use_id
        if (!id || !names.has(name)) return { continue: false, stopReason: 'DUCS rejected an unregistered tool call.' }
        announce(name, input.tool_input, id)
        return { continue: true }
      }],
    },
  }
}
