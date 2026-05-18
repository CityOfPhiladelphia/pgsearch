// ABOUTME: Tests for the region-memoized Bedrock client factory.
// ABOUTME: Covers memoization correctness, region defaulting, and concurrent-construction safety.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stable reference to the mock constructor so tests can inspect call counts.
const MockBedrockRuntimeClient = vi.fn().mockImplementation(function (this: any, opts: any) {
  this._region = opts.region
})

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: MockBedrockRuntimeClient,
  InvokeModelCommand: class InvokeModelCommand {},
}))

// Each test gets a fresh module (and thus a fresh clients Map and invokeModelCommand).
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
    const handle = await getBedrockClient('us-east-1')
    expect(handle).toHaveProperty('client')
    expect(handle).toHaveProperty('InvokeModelCommand')
    expect(handle.client).toBeDefined()
    expect(handle.InvokeModelCommand).toBeDefined()
  })

  it('returns the same client instance for the same region called twice', async () => {
    const { getBedrockClient } = await freshModule()
    const a = await getBedrockClient('us-east-1')
    const b = await getBedrockClient('us-east-1')
    expect(a.client).toBe(b.client)
  })

  it('returns different client instances for different regions', async () => {
    const { getBedrockClient } = await freshModule()
    const east = await getBedrockClient('us-east-1')
    const west = await getBedrockClient('us-west-2')
    expect(east.client).not.toBe(west.client)
  })

  it('defaults to us-east-1 when called with no argument', async () => {
    const { getBedrockClient } = await freshModule()
    const defaultHandle = await getBedrockClient()
    const explicitHandle = await getBedrockClient('us-east-1')
    expect(defaultHandle.client).toBe(explicitHandle.client)
  })

  it('returns the same InvokeModelCommand class reference across calls', async () => {
    const { getBedrockClient } = await freshModule()
    const a = await getBedrockClient('us-east-1')
    const b = await getBedrockClient('us-west-2')
    expect(a.InvokeModelCommand).toBe(b.InvokeModelCommand)
  })

  it('constructs the SDK client exactly once when two concurrent calls race for the same region', async () => {
    const { getBedrockClient } = await freshModule()
    const [a, b] = await Promise.all([
      getBedrockClient('us-east-1'),
      getBedrockClient('us-east-1'),
    ])
    expect(a.client).toBe(b.client)
    expect(MockBedrockRuntimeClient).toHaveBeenCalledTimes(1)
  })
})
