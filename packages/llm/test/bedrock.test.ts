// ABOUTME: Tests for the Bedrock LLM adapter request and response shaping.
// ABOUTME: Mocks the Bedrock SDK client at the @phila/bedrock-client boundary.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendMock = vi.fn()

vi.mock('@phila/bedrock-client', () => ({
  getBedrockClient: vi.fn(async () => ({
    client: { send: sendMock },
    InvokeModelCommand: vi.fn((input) => ({ __input: input })),
  })),
}))

import { createBedrockLlmAdapter } from '../src/bedrock'

function encodeResponseBody(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj))
}

describe('createBedrockLlmAdapter', () => {
  beforeEach(() => { sendMock.mockReset() })

  it('sends Anthropic Messages API request shape', async () => {
    sendMock.mockResolvedValueOnce({
      body: encodeResponseBody({
        content: [{ type: 'text', text: 'hello' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    })

    const adapter = createBedrockLlmAdapter({ model: 'anthropic.claude-haiku-4-5' })
    await adapter.complete({
      system: 'you are terse',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      temperature: 0.2,
    })

    expect(sendMock).toHaveBeenCalledTimes(1)
    const sentCommand = sendMock.mock.calls[0][0]
    const body = JSON.parse(sentCommand.__input.body)
    expect(sentCommand.__input.modelId).toBe('anthropic.claude-haiku-4-5')
    expect(body.anthropic_version).toBe('bedrock-2023-05-31')
    expect(body.system).toBe('you are terse')
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(body.max_tokens).toBe(100)
    expect(body.temperature).toBe(0.2)
  })

  it('parses text content and usage from response', async () => {
    sendMock.mockResolvedValueOnce({
      body: encodeResponseBody({
        content: [{ type: 'text', text: 'hello world' }],
        usage: { input_tokens: 12, output_tokens: 3 },
      }),
    })

    const adapter = createBedrockLlmAdapter({ model: 'anthropic.claude-haiku-4-5' })
    const result = await adapter.complete({
      system: '', messages: [{ role: 'user', content: 'q' }], max_tokens: 10, temperature: 0,
    })

    expect(result.text).toBe('hello world')
    expect(result.usage).toEqual({ input_tokens: 12, output_tokens: 3 })
    expect(result.model).toBe('anthropic.claude-haiku-4-5')
  })

  it('concatenates multiple text content blocks', async () => {
    sendMock.mockResolvedValueOnce({
      body: encodeResponseBody({
        content: [
          { type: 'text', text: 'part one ' },
          { type: 'text', text: 'part two' },
        ],
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    })

    const adapter = createBedrockLlmAdapter({ model: 'anthropic.claude-haiku-4-5' })
    const result = await adapter.complete({
      system: '', messages: [{ role: 'user', content: 'q' }], max_tokens: 10, temperature: 0,
    })

    expect(result.text).toBe('part one part two')
  })

  it('rejects non-anthropic model IDs with a clear error', async () => {
    const adapter = createBedrockLlmAdapter({ model: 'amazon.titan-text-v1' })
    await expect(adapter.complete({
      system: '', messages: [{ role: 'user', content: 'q' }], max_tokens: 10, temperature: 0,
    })).rejects.toThrow(/only anthropic\..*/i)
  })
})
