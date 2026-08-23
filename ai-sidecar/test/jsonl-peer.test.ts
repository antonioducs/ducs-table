import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { JsonlPeer } from '../src/jsonl-peer.js'

function nextLine(stream: PassThrough): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    stream.once('data', (chunk: Buffer) => resolve(JSON.parse(chunk.toString('utf8').trim())))
  })
}

describe('JsonlPeer', () => {
  it('serves host requests and writes JSONL responses', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const peer = new JsonlPeer(input, output)
    peer.onRequest((request) => ({ method: request.method, params: request.params }))

    const responsePromise = nextLine(output)
    input.write('{"id":7,"method":"ping","params":{"x":1}}\n')

    await expect(responsePromise).resolves.toEqual({ id: 7, result: { method: 'ping', params: { x: 1 } } })
    peer.close()
  })

  it('supports reverse tool.call requests to the host', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const peer = new JsonlPeer(input, output)

    const outgoingPromise = nextLine(output)
    const resultPromise = peer.request<{ output: string }>('tool.call', { name: 'query' })
    const outgoing = await outgoingPromise
    expect(outgoing).toMatchObject({ method: 'tool.call', params: { name: 'query' } })
    input.write(`${JSON.stringify({ id: outgoing.id, result: { output: 'ok' } })}\n`)

    await expect(resultPromise).resolves.toEqual({ output: 'ok' })
    peer.close()
  })
})
