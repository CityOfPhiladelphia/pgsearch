// ABOUTME: Unit tests for the 311 KB transform — HTML→markdown and metadata mapping.
// ABOUTME: Uses real captured API responses from test/fixtures/311-kb/ as inputs.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { transform, ARTICLE_URL_BASE, type RawArticle } from '../scripts/ingest-311-kb'

const loadFixture = (name: string): RawArticle =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures/311-kb', name), 'utf8')) as RawArticle

describe('transform', () => {
  it('maps a simple article to a clean IngestDocument', async () => {
    const raw = loadFixture('simple.json')
    const doc = await transform(raw)
    expect(doc).not.toBeNull()
    expect(doc!.external_id).toBe(raw.id)
    expect(doc!.title).toBe(raw.title)
    expect(doc!.metadata.source).toBe('phila-311-kb')
    expect(doc!.metadata.source_slug).toBe(raw.url)
    expect(doc!.metadata.source_url).toBe(`${ARTICLE_URL_BASE}${raw.url}`)
    expect(doc!.metadata.last_published_at).toBe(raw.lastPublishedAt)

    // Body is clean markdown: no raw HTML artifacts, no nbsp entities.
    expect(doc!.body).not.toMatch(/<span/i)
    expect(doc!.body).not.toMatch(/<div/i)
    expect(doc!.body).not.toMatch(/style=/i)
    expect(doc!.body).not.toMatch(/&nbsp;/i)
    expect(doc!.body.trim().length).toBeGreaterThan(0)
  })

  it('converts a nested article to clean markdown with no surviving HTML', async () => {
    const raw = loadFixture('nested.json')
    const doc = await transform(raw)
    expect(doc).not.toBeNull()

    // No surviving HTML of any kind — including table structure, which we
    // strip explicitly via remove('table') because Turndown's GFM fallback
    // emits raw HTML for tables with block-level content in cells.
    expect(doc!.body).not.toMatch(/<span/i)
    expect(doc!.body).not.toMatch(/<div/i)
    expect(doc!.body).not.toMatch(/<table/i)
    expect(doc!.body).not.toMatch(/<tr/i)
    expect(doc!.body).not.toMatch(/<td/i)
    expect(doc!.body).not.toMatch(/<th/i)
    expect(doc!.body).not.toMatch(/<br/i)
    expect(doc!.body).not.toMatch(/style=/i)
    expect(doc!.body).not.toMatch(/&nbsp;/i)

    // The body is non-empty after table removal — nested.json has meaningful
    // non-table content too.
    expect(doc!.body.trim().length).toBeGreaterThan(0)
  })

  it('returns null for articles whose body is empty after strip', async () => {
    const raw = loadFixture('malformed.json')
    const doc = await transform(raw)
    expect(doc).toBeNull()
  })
})
