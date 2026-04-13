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

  it('collapses consecutive <br> into a paragraph break for nested articles', async () => {
    const raw = loadFixture('nested.json')
    const doc = await transform(raw)
    expect(doc).not.toBeNull()
    // A paragraph break in markdown is a blank line (two consecutive newlines).
    // The nested fixture has <br><br> in its source; verify it survived as a break.
    expect(doc!.body).toMatch(/\n\n/)
    expect(doc!.body).not.toMatch(/<br/i)
  })

  it('returns null for articles whose body is empty after strip', async () => {
    const raw = loadFixture('malformed.json')
    const doc = await transform(raw)
    expect(doc).toBeNull()
  })
})
