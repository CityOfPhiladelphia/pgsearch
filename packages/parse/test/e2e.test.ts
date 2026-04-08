// ABOUTME: End-to-end test of the full pipeline against a cached phila.gov page fixture.
// ABOUTME: Validates that the library produces the expected ParsedDocument shape for real-world HTML.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  pipeline,
  extractMeta,
  extractTitle,
  selectContent,
  remove,
  cleanWhitespace,
  toMarkdown,
} from '../src'

describe('e2e: full pipeline against phila.gov fixture', () => {
  const html = readFileSync(join(__dirname, 'fixtures/phila-pay-water-bill.html'), 'utf-8')

  const parsePhilaService = pipeline(
    extractMeta(),
    extractTitle('.entry-header h2'),
    remove('.breadcrumbs', '.related-content'),
    selectContent('.entry-content'),
    cleanWhitespace(),
    toMarkdown(),
  )

  it('extracts the correct title', async () => {
    const doc = await parsePhilaService(html)
    expect(doc.title).toBe('Pay a water bill')
  })

  it('extracts standard metadata', async () => {
    const doc = await parsePhilaService(html)
    expect(doc.metadata.description).toBe('Instructions and fees for accessing and paying your water and sewer services bill.')
    expect(doc.metadata.og_title).toBe('Pay a water bill | Services')
    expect(doc.metadata.og_description).toBe('Instructions and fees for accessing and paying your water and sewer services bill.')
    expect(doc.metadata.og_type).toBe('website')
    expect(doc.metadata.og_site_name).toBe('City of Philadelphia')
    expect(doc.metadata.canonical_url).toBe('https://www.phila.gov/services/water-gas-utilities/pay-or-dispute-a-water-bill/pay-a-water-bill/')
  })

  it('blocks twitter:* metadata', async () => {
    const doc = await parsePhilaService(html)
    expect(doc.metadata.twitter_title).toBeUndefined()
    expect(doc.metadata.twitter_description).toBeUndefined()
    expect(doc.metadata.twitter_image).toBeUndefined()
  })

  it('produces markdown body with headings and lists', async () => {
    const doc = await parsePhilaService(html)
    expect(doc.body.length).toBeGreaterThan(500)
    expect(doc.body).toMatch(/##\s+/)        // at least one heading
    expect(doc.body).toMatch(/^-\s+/m)       // at least one list item
  })

  it('does not contain navigation, breadcrumbs, or footer text', async () => {
    const doc = await parsePhilaService(html)
    expect(doc.body).not.toContain('Skip to main content')
    expect(doc.body).not.toContain('Elected officials')
    expect(doc.body).not.toContain('Open government')
  })

  it('preserves the substantive content', async () => {
    const doc = await parsePhilaService(html)
    // Content known to be on the page
    expect(doc.body.toLowerCase()).toContain('water bill')
    expect(doc.body.toLowerCase()).toMatch(/echeck|automatic bank/)
  })
})
