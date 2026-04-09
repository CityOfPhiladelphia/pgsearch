// ABOUTME: Tests for the sitemap-based URL discoverer.
// ABOUTME: Validates XML parsing, URL filtering, and the async-iterable contract.

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createSitemapDiscoverer } from '../src/discover/sitemap'

const sitemapXml = readFileSync(join(__dirname, 'fixtures/sitemap-snippet.xml'), 'utf-8')

function fakeFetch(body: string = sitemapXml, status: number = 200): typeof fetch {
  return (async (_url: string) => {
    return new Response(body, { status, headers: { 'content-type': 'application/xml' } })
  }) as unknown as typeof fetch
}

const PHILA_LEAF_FILTER = (url: URL): boolean => {
  const p = url.pathname
  // Services leaves: /services/<category>/<leaf>/ — at least 3 total path segments
  if (p.startsWith('/services/')) {
    const segments = p.split('/').filter(Boolean)
    return segments.length >= 3
  }
  // Programs leaves: /programs/<leaf>/ — exactly 2 total path segments
  if (p.startsWith('/programs/')) {
    const segments = p.split('/').filter(Boolean)
    return segments.length === 2
  }
  return false
}

describe('sitemapDiscoverer', () => {
  let collected: string[] = []

  beforeAll(async () => {
    const discoverer = createSitemapDiscoverer({
      url: 'https://www.phila.gov/sitemap.xml',
      filter: PHILA_LEAF_FILTER,
      fetch: fakeFetch(),
    })
    for await (const url of discoverer.discover()) {
      collected.push(url.toString())
    }
  })

  it('includes leaf service URLs', () => {
    expect(collected).toContain('https://www.phila.gov/services/water-gas-utilities/pay-or-dispute-a-water-bill/pay-a-water-bill/')
    expect(collected).toContain('https://www.phila.gov/services/parking/parking-permits/get-a-residential-parking-permit/')
    expect(collected).toContain('https://www.phila.gov/services/birth-marriage-life-events/get-a-marriage-license/')
  })

  it('includes leaf program URLs', () => {
    expect(collected).toContain('https://www.phila.gov/programs/camp-philly/')
    expect(collected).toContain('https://www.phila.gov/programs/philly-counts/')
  })

  it('excludes the services and programs category roots', () => {
    expect(collected).not.toContain('https://www.phila.gov/services/')
    expect(collected).not.toContain('https://www.phila.gov/programs/')
  })

  it('excludes intermediate services category pages', () => {
    expect(collected).not.toContain('https://www.phila.gov/services/water-gas-utilities/')
  })

  it('excludes unrelated paths (departments, news, root)', () => {
    expect(collected).not.toContain('https://www.phila.gov/')
    expect(collected).not.toContain('https://www.phila.gov/departments/')
    expect(collected).not.toContain('https://www.phila.gov/news/some-press-release/')
  })

  it('yields exactly 5 services leaves + 3 programs leaves', () => {
    expect(collected).toHaveLength(8)
  })

  it('throws on non-200 sitemap response', async () => {
    const discoverer = createSitemapDiscoverer({
      url: 'https://www.phila.gov/sitemap.xml',
      filter: PHILA_LEAF_FILTER,
      fetch: fakeFetch('not found', 404),
    })
    await expect(async () => {
      for await (const _ of discoverer.discover()) { /* consume */ }
    }).rejects.toThrow(/sitemap fetch failed: 404/)
  })
})
