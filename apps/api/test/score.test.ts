// ABOUTME: Tests for Reciprocal Rank Fusion scoring.
// ABOUTME: Verifies rank contributions, retriever weights, and absent-retriever behavior.

import { describe, it, expect } from 'vitest'
import { computeRRF } from '../services/score'

describe('computeRRF', () => {
  it('computes score from a single retriever', () => {
    // rank 1, weight 1.0, k=60: 1.0 / (60 + 1) = 0.01639...
    const score = computeRRF({ bm25Rank: 1, k: 60, weights: { bm25: 1.0, vector: 1.0 } })
    expect(score).toBeCloseTo(1.0 / 61, 10)
  })

  it('sums contributions from both retrievers', () => {
    // bm25 rank 1 + vector rank 3: 1/(60+1) + 1/(60+3)
    const score = computeRRF({ bm25Rank: 1, vectorRank: 3, k: 60, weights: { bm25: 1.0, vector: 1.0 } })
    expect(score).toBeCloseTo(1 / 61 + 1 / 63, 10)
  })

  it('applies retriever weights', () => {
    const weighted = computeRRF({ bm25Rank: 1, vectorRank: 1, k: 60, weights: { bm25: 2.0, vector: 1.0 } })
    const equal = computeRRF({ bm25Rank: 1, vectorRank: 1, k: 60, weights: { bm25: 1.0, vector: 1.0 } })
    expect(weighted).toBeGreaterThan(equal)
  })

  it('absent retriever contributes nothing', () => {
    const bm25Only = computeRRF({ bm25Rank: 1, k: 60, weights: { bm25: 1.0, vector: 1.0 } })
    const both = computeRRF({ bm25Rank: 1, vectorRank: 1, k: 60, weights: { bm25: 1.0, vector: 1.0 } })
    expect(both).toBeGreaterThan(bm25Only)
  })

  it('higher rank (worse position) produces lower score', () => {
    const rank1 = computeRRF({ bm25Rank: 1, k: 60, weights: { bm25: 1.0, vector: 1.0 } })
    const rank50 = computeRRF({ bm25Rank: 50, k: 60, weights: { bm25: 1.0, vector: 1.0 } })
    expect(rank1).toBeGreaterThan(rank50)
  })
})
