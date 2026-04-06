// ABOUTME: Tests for BM25F scoring functions used in keyword relevance ranking.
// ABOUTME: Verifies IDF computation, field-weighted term frequency, and score normalization.

import { describe, it, expect } from 'vitest'
import { computeIDF, computeBM25F, normalizeScores } from '../services/score'

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

  describe('normalizeScores', () => {
    it('normalizes to 0-1 range', () => {
      const n = normalizeScores([1, 3, 5])
      expect(n[0]).toBe(0); expect(n[1]).toBe(0.5); expect(n[2]).toBe(1)
    })
    it('handles single element', () => { expect(normalizeScores([5])).toEqual([1]) })
    it('handles all equal', () => { expect(normalizeScores([3, 3, 3])).toEqual([1, 1, 1]) })
    it('handles empty', () => { expect(normalizeScores([])).toEqual([]) })
  })
})
