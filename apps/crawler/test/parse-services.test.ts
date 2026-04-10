// ABOUTME: End-to-end test of the services parse pipeline against a cached phila.gov fixture.
// ABOUTME: Validates title, metadata, and body content for a real services page.

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { ParsedDocument } from '@phila/search-parse'
import { parseService } from '../src/parse/services'

describe('parseService', () => {
  const html = readFileSync(join(__dirname, 'fixtures/pay-water-bill.html'), 'utf-8')
  let doc: ParsedDocument

  beforeAll(async () => {
    doc = await parseService(html)
  })

  it('extracts the title', () => {
    expect(doc.title).toBe('Pay a water bill')
  })

  it('extracts standard metadata', () => {
    expect(doc.metadata.description).toBe('Instructions and fees for accessing and paying your water and sewer services bill.')
    expect(doc.metadata.canonical_url).toBe('https://www.phila.gov/services/water-gas-utilities/pay-or-dispute-a-water-bill/pay-a-water-bill/')
    expect(doc.metadata.og_site_name).toBe('City of Philadelphia')
  })

  it('extracts content_type from the swiftype meta tag', () => {
    expect(doc.metadata.content_type).toBe('service_page')
  })

  it('produces markdown body with substantive content', () => {
    expect(doc.body.length).toBeGreaterThan(500)
    expect(doc.body.toLowerCase()).toContain('water bill')
  })

  it('strips navigation and footer text', () => {
    expect(doc.body).not.toContain('Skip to main content')
    expect(doc.body).not.toContain('Open government')
  })
})
