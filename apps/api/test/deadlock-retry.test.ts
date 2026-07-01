// ABOUTME: Unit tests for the ingest transaction's deadlock/serialization retry helper.
import { describe, it, expect } from 'vitest'
import { withDeadlockRetry } from '../services/ingest'

function pgError(code: string): Error & { code: string } {
  return Object.assign(new Error(`pg ${code}`), { code })
}

describe('withDeadlockRetry', () => {
  it('returns the result when fn succeeds first try', async () => {
    let calls = 0
    const r = await withDeadlockRetry(async () => { calls++; return 'ok' })
    expect(r).toBe('ok')
    expect(calls).toBe(1)
  })

  it('retries on 40P01 deadlock then succeeds', async () => {
    let calls = 0
    const r = await withDeadlockRetry(async () => {
      calls++
      if (calls === 1) throw pgError('40P01')
      return 'ok'
    })
    expect(r).toBe('ok')
    expect(calls).toBe(2)
  })

  it('retries on 40001 serialization_failure', async () => {
    let calls = 0
    const r = await withDeadlockRetry(async () => {
      calls++
      if (calls === 1) throw pgError('40001')
      return 'ok'
    })
    expect(r).toBe('ok')
    expect(calls).toBe(2)
  })

  it('gives up after the attempt limit and rethrows the deadlock', async () => {
    let calls = 0
    await expect(withDeadlockRetry(async () => { calls++; throw pgError('40P01') }, 3))
      .rejects.toMatchObject({ code: '40P01' })
    expect(calls).toBe(3)
  })

  it('does not retry a non-deadlock error', async () => {
    let calls = 0
    await expect(withDeadlockRetry(async () => { calls++; throw pgError('23505') }))
      .rejects.toMatchObject({ code: '23505' })
    expect(calls).toBe(1)
  })
})
