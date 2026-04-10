// ABOUTME: Tests for BM25F scoring functions used in keyword relevance ranking.
// ABOUTME: Verifies IDF computation, field-weighted term frequency, and RRF fusion scoring.

import { describe, it, expect } from 'vitest'
import { computeIDF, computeBM25F, computeRRF } from '../services/score'

describe('BM25F scoring', () => {
  describe('computeIDF', () => {
    it('computes IDF correctly', () => {
      const idf = computeIDF(100, 10)
      const expected = Math.log((100 - 10 + 0.5) / (10 + 0.5) + 1)
      expect(idf).toBeCloseTo(expected)
    })
    it('returns positive for rare terms', () => { expect(computeIDF(1000, 1)).toBeGreaterThan(0) })
    it('returns near-zero for ubiquitous terms', () => { expect(computeIDF(100, 99)).toBeLessThan(0.1) })
    it('handles df=0', () => { expect(Number.isFinite(computeIDF(100, 0))).toBe(true) })
    it('handles N=0', () => { expect(Number.isFinite(computeIDF(0, 0))).toBe(true) })
  })

  describe('computeBM25F', () => {
    const p = { k1: 1.2, b: 0.75, fieldWeights: { title: 3.0, body: 1.0 }, avgTitleLength: 5, avgBodyLength: 100, totalDocuments: 1000 }

    it('scores higher for title matches', () => {
      const title = computeBM25F({ termFreqs: [{ term: 'parking', titleTf: 1, bodyTf: 0, df: 50 }], titleLength: 5, bodyLength: 100, ...p })
      const body = computeBM25F({ termFreqs: [{ term: 'parking', titleTf: 0, bodyTf: 1, df: 50 }], titleLength: 5, bodyLength: 100, ...p })
      expect(title).toBeGreaterThan(body)
    })
    it('scores higher for rarer terms', () => {
      const rare = computeBM25F({ termFreqs: [{ term: 'x', titleTf: 0, bodyTf: 1, df: 1 }], titleLength: 5, bodyLength: 100, ...p })
      const common = computeBM25F({ termFreqs: [{ term: 'the', titleTf: 0, bodyTf: 1, df: 900 }], titleLength: 5, bodyLength: 100, ...p })
      expect(rare).toBeGreaterThan(common)
    })
    it('accumulates across terms', () => {
      const one = computeBM25F({ termFreqs: [{ term: 'a', titleTf: 0, bodyTf: 1, df: 50 }], titleLength: 5, bodyLength: 100, ...p })
      const two = computeBM25F({ termFreqs: [{ term: 'a', titleTf: 0, bodyTf: 1, df: 50 }, { term: 'b', titleTf: 0, bodyTf: 1, df: 30 }], titleLength: 5, bodyLength: 100, ...p })
      expect(two).toBeGreaterThan(one)
    })
    it('returns 0 for no terms', () => {
      expect(computeBM25F({ termFreqs: [], titleLength: 5, bodyLength: 100, ...p })).toBe(0)
    })
    it('applies length normalization', () => {
      const short = computeBM25F({ termFreqs: [{ term: 'a', titleTf: 0, bodyTf: 1, df: 50 }], titleLength: 5, bodyLength: 50, ...p })
      const long = computeBM25F({ termFreqs: [{ term: 'a', titleTf: 0, bodyTf: 1, df: 50 }], titleLength: 5, bodyLength: 500, ...p })
      expect(short).toBeGreaterThan(long)
    })
  })

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
})
