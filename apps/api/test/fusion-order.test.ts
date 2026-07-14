// ABOUTME: Tests for the deterministic ordering of fused search results.
// ABOUTME: Verifies tie-breaking: both-pass evidence, vector presence, raw scores, stable id order.

import { describe, it, expect } from 'vitest'
import { fusionOrder } from '../services/search'

const candidate = (over: Partial<Parameters<typeof fusionOrder>[0]>) => ({
  score: 1 / 61,
  lexicalRank: null as number | null,
  vectorRank: null as number | null,
  lexicalScore: 0,
  vectorScore: 0,
  external_id: 'x',
  ...over,
})

describe('fusionOrder', () => {
  it('higher score wins regardless of everything else', () => {
    const low = candidate({ score: 0.01, lexicalRank: 1, vectorRank: 1 })
    const high = candidate({ score: 0.02 })
    expect([low, high].sort(fusionOrder)[0]).toBe(high)
  })

  it('on tied scores, a both-pass candidate beats a single-pass candidate', () => {
    const both = candidate({ lexicalRank: 62, vectorRank: 62, lexicalScore: 1, vectorScore: 0.5 })
    const single = candidate({ lexicalRank: 1, lexicalScore: 9 })
    expect([single, both].sort(fusionOrder)[0]).toBe(both)
  })

  it('on tied single-pass scores, the vector-side candidate beats the keyword-side one', () => {
    const keywordOnly = candidate({ lexicalRank: 1, lexicalScore: 9, external_id: 'kw' })
    const vectorOnly = candidate({ vectorRank: 1, vectorScore: 0.9, external_id: 'vec' })
    // insertion order favors the keyword side today; the comparator must override it
    expect([keywordOnly, vectorOnly].sort(fusionOrder)[0]).toBe(vectorOnly)
  })

  it('both-pass candidates with mirrored ranks fall back to raw scores', () => {
    const strongerKeyword = candidate({ lexicalRank: 1, vectorRank: 2, lexicalScore: 9, vectorScore: 0.5 })
    const strongerVector = candidate({ lexicalRank: 2, vectorRank: 1, lexicalScore: 5, vectorScore: 0.9 })
    expect([strongerVector, strongerKeyword].sort(fusionOrder)[0]).toBe(strongerKeyword)
  })

  it('fully tied candidates order by external_id for total determinism', () => {
    const a = candidate({ vectorRank: 1, vectorScore: 0.9, external_id: 'a' })
    const b = candidate({ vectorRank: 1, vectorScore: 0.9, external_id: 'b' })
    expect([b, a].sort(fusionOrder)[0]).toBe(a)
  })
})
