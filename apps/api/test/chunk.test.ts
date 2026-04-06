// ABOUTME: Tests for text chunking logic used in document ingestion.
// ABOUTME: Verifies paragraph splitting, sentence fallback, token counting, and segment merging.

import { describe, it, expect } from 'vitest'
import { chunkText, countTokens } from '../services/chunk'

describe('countTokens', () => {
  it('counts whitespace-delimited tokens', () => {
    expect(countTokens('hello world')).toBe(2)
    expect(countTokens('one two three four five')).toBe(5)
  })

  it('returns 0 for empty string', () => {
    expect(countTokens('')).toBe(0)
  })

  it('handles multiple spaces', () => {
    expect(countTokens('hello   world')).toBe(2)
  })
})

describe('chunkText', () => {
  it('returns single segment for short text', () => {
    const segments = chunkText('Short paragraph.', { maxTokens: 500, minTokens: 50 })
    expect(segments).toHaveLength(1)
    expect(segments[0]).toBe('Short paragraph.')
  })

  it('splits on paragraph boundaries', () => {
    const text = 'First paragraph with enough words to be meaningful and pass the minimum.\n\nSecond paragraph also with enough words to be meaningful and pass the minimum.'
    const segments = chunkText(text, { maxTokens: 15, minTokens: 3 })
    expect(segments).toHaveLength(2)
    expect(segments[0]).toContain('First paragraph')
    expect(segments[1]).toContain('Second paragraph')
  })

  it('splits long paragraphs on sentence boundaries', () => {
    const longParagraph = 'Sentence one about something important. Sentence two about another thing entirely. Sentence three is here with more words. Sentence four follows with content. Sentence five ends it all.'
    const segments = chunkText(longParagraph, { maxTokens: 12, minTokens: 3 })
    expect(segments.length).toBeGreaterThan(1)
    // Each segment should be a complete sentence or group of sentences
    segments.forEach(s => expect(s.trim().length).toBeGreaterThan(0))
  })

  it('merges short trailing segments into previous', () => {
    const text = 'A substantial first paragraph with many words filling the space adequately for testing purposes.\n\nTiny.'
    const segments = chunkText(text, { maxTokens: 500, minTokens: 50 })
    expect(segments).toHaveLength(1) // "Tiny." merges into first
  })

  it('handles empty text', () => {
    const segments = chunkText('', { maxTokens: 500, minTokens: 50 })
    expect(segments).toHaveLength(0)
  })

  it('handles text with only whitespace', () => {
    const segments = chunkText('   \n\n   ', { maxTokens: 500, minTokens: 50 })
    expect(segments).toHaveLength(0)
  })

  it('handles single paragraph that exceeds maxTokens', () => {
    const longText = Array(100).fill('word').join(' ')
    const segments = chunkText(longText, { maxTokens: 20, minTokens: 3 })
    expect(segments.length).toBeGreaterThan(1)
    // No segment should massively exceed maxTokens
    segments.forEach(s => {
      expect(countTokens(s)).toBeLessThanOrEqual(25) // some tolerance for sentence boundaries
    })
  })

  it('preserves all content across segments', () => {
    const text = 'First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.'
    const segments = chunkText(text, { maxTokens: 5, minTokens: 2 })
    const rejoined = segments.join(' ')
    expect(rejoined).toContain('First paragraph')
    expect(rejoined).toContain('Second paragraph')
    expect(rejoined).toContain('Third paragraph')
  })
})
