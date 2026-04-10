// ABOUTME: End-to-end test of the programs parse pipeline against a cached phila.gov fixture.
// ABOUTME: Validates title, metadata, and body content for a real programs page.

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { ParsedDocument } from '@phila/search-parse'
import { parseProgram } from '../src/parse/programs'

describe('parseProgram', () => {
  const html = readFileSync(join(__dirname, 'fixtures/camp-philly.html'), 'utf-8')
  let doc: ParsedDocument

  beforeAll(async () => {
    doc = await parseProgram(html)
  })

  it('extracts the title from the hero header', () => {
    expect(doc.title).toBe('Camp Philly')
  })

  it('extracts content_type from the swiftype meta tag', () => {
    expect(doc.metadata.content_type).toBe('programs')
  })

  it('extracts the canonical URL', () => {
    expect(doc.metadata.canonical_url).toBe('https://www.phila.gov/programs/camp-philly/')
  })

  it('produces markdown body with substantive content', () => {
    expect(doc.body.length).toBeGreaterThan(2500)
    expect(doc.body.toLowerCase()).toMatch(/sleep[- ]away|camp speers|recreation/)
  })

  it('strips global navigation and footer text', () => {
    expect(doc.body).not.toContain('Skip to main content')
    expect(doc.body).not.toContain('Open government')
  })
})
