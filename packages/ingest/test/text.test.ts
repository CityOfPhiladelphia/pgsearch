// ABOUTME: Tests for plain text content parser.
// ABOUTME: Verifies title extraction from first line and explicit title override.

import { describe, it, expect } from 'vitest'
import { parseText } from '../src/text'

describe('parseText', () => {
  it('uses first line as title if not provided', () => {
    const doc = parseText('First Line\n\nBody content here.')
    expect(doc.title).toBe('First Line')
    expect(doc.body).toBe('Body content here.')
  })

  it('uses provided title', () => {
    const doc = parseText('Full text here.', { title: 'Custom Title' })
    expect(doc.title).toBe('Custom Title')
    expect(doc.body).toBe('Full text here.')
  })

  it('merges metadata', () => {
    const doc = parseText('Text.', { title: 'T', metadata: { source: 'manual' } })
    expect(doc.metadata?.source).toBe('manual')
  })

  it('handles text with no paragraph breaks', () => {
    const doc = parseText('Single line of text.')
    expect(doc.title).toBe('Single line of text.')
    expect(doc.body).toBe('')
  })
})
