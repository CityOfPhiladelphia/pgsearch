// ABOUTME: Tests for text chunking logic used in document ingestion.
// ABOUTME: Verifies token-budgeted segmentation, content preservation, and hard splitting of unbreakable tokens.

import { describe, it, expect } from 'vitest'
import { chunkText, estimateTokens, wordCount } from '../services/chunk'

// Non-whitespace content, in order, must survive chunking — whitespace at segment
// boundaries is not significant for embedding or tsvector.
const stripWs = (s: string) => s.replace(/\s+/g, '')

describe('estimateTokens', () => {
  it('estimates one token per three characters, rounding up', () => {
    expect(estimateTokens('abc')).toBe(1)
    expect(estimateTokens('abcd')).toBe(2)
    expect(estimateTokens('abcdefg')).toBe(3)
  })

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })
})

describe('wordCount', () => {
  it('counts whitespace-delimited words', () => {
    expect(wordCount('hello world')).toBe(2)
    expect(wordCount('one two three four five')).toBe(5)
  })

  it('returns 0 for empty string', () => {
    expect(wordCount('')).toBe(0)
  })

  it('collapses runs of whitespace', () => {
    expect(wordCount('hello   world')).toBe(2)
  })
})

describe('chunkText', () => {
  it('returns a single segment for text within budget', () => {
    expect(chunkText('Short paragraph.', 500)).toEqual(['Short paragraph.'])
  })

  it('returns no segments for empty or whitespace-only text', () => {
    expect(chunkText('', 500)).toEqual([])
    expect(chunkText('   \n\n   ', 500)).toEqual([])
  })

  it('keeps every segment within the token budget', () => {
    const text = Array(80).fill(
      'Residents can pay their water bill online through the city portal.',
    ).join('\n\n')
    const segs = chunkText(text, 50)
    expect(segs.length).toBeGreaterThan(1)
    segs.forEach((s) => expect(estimateTokens(s)).toBeLessThanOrEqual(50))
  })

  it('preserves all non-whitespace content in order', () => {
    const text = 'First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.'
    const segs = chunkText(text, 5)
    expect(stripWs(segs.join(''))).toBe(stripWs(text))
  })

  it('prefers paragraph boundaries when splitting', () => {
    const text = 'Alpha beta gamma delta epsilon.\n\nZeta eta theta iota kappa.'
    // Budget fits one paragraph but not both -> split on the blank line.
    const segs = chunkText(text, 12)
    expect(segs).toEqual(['Alpha beta gamma delta epsilon.', 'Zeta eta theta iota kappa.'])
  })

  it('hard-splits a single unbroken token that exceeds the budget', () => {
    // A 30k-char token with no whitespace: the regression behind pgsearch-a6j,
    // where the old word-count chunker emitted it as one oversized segment.
    const giant = 'x'.repeat(30_000)
    const segs = chunkText(`Intro text.\n\n${giant}`, 500)
    expect(segs.length).toBeGreaterThan(1)
    segs.forEach((s) => expect(estimateTokens(s)).toBeLessThanOrEqual(500))
    expect(stripWs(segs.join(''))).toBe(stripWs(`Intro text.\n\n${giant}`))
  })
})
