// ABOUTME: Tests for the sitemap-based URL discoverer.
// ABOUTME: Validates XML parsing, URL filtering, and the async-iterable contract.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createSitemapDiscoverer } from '../src/discover/sitemap'

const sitemapXml = readFileSync(join(__dirname, 'fixtures/sitemap-snippet.xml'), 'utf-8')

// The discoverer takes a fetch implementation so tests don't hit the network.
function fakeFetch(): typeof fetch {
  return (async (_url: string) => {
    return new Response(sitemapXml, { status: 200, headers: { 'content-type': 'application/xml' } })
  }) as unknown as typeof fetch
}

const PHILA_LEAF_FILTER = (url: URL): boolean => {
  const p = url.pathname
  // Services leaves: /services/<category>/.../<leaf>/ — at least 3 path segments after /services/
  if (p.startsWith('/services/')) {
    const segments = p.split('/').filter(Boolean) // ['services', ...]
    return segments.length >= 3
  }
  // Programs leaves: /programs/<leaf>/ — exactly 2 path segments
  if (p.startsWith('/programs/')) {
    const segments = p.split('/').filter(Boolean)
    return segments.length === 2
  }
  return false
}

describe('sitemapDiscoverer', () => {
  it('yields URLs from the sitemap that match the filter', async () => {
    const discoverer = createSitemapDiscoverer({
      url: 'https://www.phila.gov/sitemap.xml',
      filter: PHILA_LEAF_FILTER,
      fetch: fakeFetch(),
    })
    const collected: string[] = []
    for await (const url of discoverer.discover()) {
      collected.push(url.toString())
    }
    expect(collected).toContain('https://www.phila.gov/services/water-gas-utilities/pay-or-dispute-a-water-bill/pay-a-water-bill/')
    expect(collected).toContain('https://www.phila.gov/services/parking/parking-permits/get-a-residential-parking-permit/')
    expect(collected).toContain('https://www.phila.gov/programs/camp-philly/')
    expect(collected).toContain('https://www.phila.gov/programs/philly-counts/')
  })

  it('excludes the services and programs category roots', async () => {
    const discoverer = createSitemapDiscoverer({
      url: 'https://www.phila.gov/sitemap.xml',
      filter: PHILA_LEAF_FILTER,
      fetch: fakeFetch(),
    })
    const collected: string[] = []
    for await (const url of discoverer.discover()) {
      collected.push(url.toString())
    }
    expect(collected).not.toContain('https://www.phila.gov/services/')
    expect(collected).not.toContain('https://www.phila.gov/programs/')
  })

  it('excludes intermediate services category pages', async () => {
    const discoverer = createSitemapDiscoverer({
      url: 'https://www.phila.gov/sitemap.xml',
      filter: PHILA_LEAF_FILTER,
      fetch: fakeFetch(),
    })
    const collected: string[] = []
    for await (const url of discoverer.discover()) {
      collected.push(url.toString())
    }
    expect(collected).not.toContain('https://www.phila.gov/services/water-gas-utilities/')
  })

  it('excludes unrelated paths (departments, news, root)', async () => {
    const discoverer = createSitemapDiscoverer({
      url: 'https://www.phila.gov/sitemap.xml',
      filter: PHILA_LEAF_FILTER,
      fetch: fakeFetch(),
    })
    const collected: string[] = []
    for await (const url of discoverer.discover()) {
      collected.push(url.toString())
    }
    expect(collected).not.toContain('https://www.phila.gov/')
    expect(collected).not.toContain('https://www.phila.gov/departments/')
    expect(collected).not.toContain('https://www.phila.gov/news/some-press-release/')
  })

  it('yields exactly the expected count', async () => {
    const discoverer = createSitemapDiscoverer({
      url: 'https://www.phila.gov/sitemap.xml',
      filter: PHILA_LEAF_FILTER,
      fetch: fakeFetch(),
    })
    let count = 0
    for await (const _ of discoverer.discover()) count++
    expect(count).toBe(8) // 5 services leaves + 3 programs leaves
  })
})
