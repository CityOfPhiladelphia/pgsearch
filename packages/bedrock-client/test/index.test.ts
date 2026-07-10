// ABOUTME: Tests for the lazy Bedrock client factory.
// ABOUTME: Covers memoization correctness, the us-east-1 region, and concurrent-construction safety.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stable reference to the mock constructor so tests can inspect call counts.
const MockBedrockRuntimeClient = vi.fn().mockImplementation(function (this: any, opts: any) {
  this._region = opts.region
})

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: MockBedrockRuntimeClient,
  InvokeModelCommand: class InvokeModelCommand {},
}))

// Each test gets a fresh module (and thus a fresh memoized client).
beforeEach(() => {
  vi.resetModules()
  MockBedrockRuntimeClient.mockClear()
})

async function freshModule() {
  return import('../src/index.ts')
}

describe('getBedrockClient', () => {
  it('returns a handle with client and InvokeModelCommand properties', async () => {
    const { getBedrockClient } = await freshModule()
    const handle = await getBedrockClient()
    expect(handle).toHaveProperty('client')
    expect(handle).toHaveProperty('InvokeModelCommand')
    expect(handle.client).toBeDefined()
    expect(handle.InvokeModelCommand).toBeDefined()
  })

  it('returns the same client instance across calls', async () => {
    const { getBedrockClient } = await freshModule()
    const a = await getBedrockClient()
    const b = await getBedrockClient()
    expect(a.client).toBe(b.client)
    expect(a.InvokeModelCommand).toBe(b.InvokeModelCommand)
  })

  it('constructs the client in us-east-1', async () => {
    const { getBedrockClient } = await freshModule()
    const handle = await getBedrockClient()
    expect((handle.client as any)._region).toBe('us-east-1')
  })

  it('constructs the SDK client exactly once when two concurrent calls race', async () => {
    const { getBedrockClient } = await freshModule()
    const [a, b] = await Promise.all([getBedrockClient(), getBedrockClient()])
    expect(a.client).toBe(b.client)
    expect(MockBedrockRuntimeClient).toHaveBeenCalledTimes(1)
  })
})
