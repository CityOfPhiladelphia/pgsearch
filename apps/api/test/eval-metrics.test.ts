// ABOUTME: Tests for eval ranking-comparison metrics (overlap@k, Spearman rank correlation).
// ABOUTME: Validates the math used to compare captured search rankings across runs.

import { describe, it, expect } from 'vitest'
import { overlapAtK, spearmanShared } from '../scripts/eval/metrics'

describe('overlapAtK', () => {
  it('returns 1 for identical lists', () => {
    expect(overlapAtK(['a', 'b', 'c'], ['a', 'b', 'c'], 10)).toBe(1)
  })

  it('returns 1 for same members in different order', () => {
    expect(overlapAtK(['a', 'b', 'c'], ['c', 'a', 'b'], 10)).toBe(1)
  })

  it('returns 0 for disjoint lists', () => {
    expect(overlapAtK(['a', 'b'], ['c', 'd'], 10)).toBe(0)
  })

  it('normalizes by the longer list when both are shorter than k', () => {
    // shared {a,b,c} of max(4,4) comparable positions
    expect(overlapAtK(['a', 'b', 'c', 'd'], ['b', 'a', 'c', 'e'], 10)).toBe(0.75)
  })

  it('only considers the top k of each list', () => {
    // top-2: [a,b] vs [b,x] share only b
    expect(overlapAtK(['a', 'b', 'z'], ['b', 'x', 'a'], 2)).toBe(0.5)
  })

  it('penalizes length mismatch: a short list against a deep one', () => {
    // shared 3 of max-length 10
    const deep = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
    expect(overlapAtK(['a', 'b', 'c'], deep, 10)).toBe(0.3)
  })

  it('returns null when both lists are empty', () => {
    expect(overlapAtK([], [], 10)).toBeNull()
  })
})

describe('spearmanShared', () => {
  it('returns 1 for identical rankings', () => {
    expect(spearmanShared(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd'])).toBe(1)
  })

  it('returns -1 for exactly reversed rankings', () => {
    expect(spearmanShared(['a', 'b', 'c'], ['c', 'b', 'a'])).toBe(-1)
  })

  it('computes rho over shared items re-ranked within the intersection', () => {
    // shared {a,b,c}: ranks in first list a=1,b=2,c=3; in second b=1,a=2,c=3
    // d^2 = 1+1+0 = 2, rho = 1 - 6*2/(3*8) = 0.5
    expect(spearmanShared(['a', 'b', 'c', 'd'], ['b', 'a', 'c', 'e'])).toBe(0.5)
  })

  it('ignores items missing from either list', () => {
    // only {a,b} shared, same relative order
    expect(spearmanShared(['x', 'a', 'y', 'b'], ['a', 'q', 'b'])).toBe(1)
  })

  it('returns null with fewer than two shared items', () => {
    expect(spearmanShared(['a', 'b'], ['a', 'c'])).toBeNull()
    expect(spearmanShared([], [])).toBeNull()
  })
})
