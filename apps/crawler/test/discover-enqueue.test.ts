// ABOUTME: Tests for the recursive enqueueLinks-based URL discoverer.
// ABOUTME: Uses an injected fetch with a fake site graph; verifies traversal, filter, and dedup.

import { describe, it, expect, beforeAll } from 'vitest'
import { createEnqueueDiscoverer } from '../src/discover/enqueue'

// Fake site:
//   /services/                       (seed; category index page; not a leaf)
//   /services/water/                  (sub-category; not a leaf)
//   /services/water/pay-bill/         (leaf — matches filter)
//   /services/water/repair/           (leaf — matches filter)
//   /services/parking/                (sub-category; not a leaf)
//   /services/parking/permit/         (leaf — matches filter)
//   /departments/random/              (off-pattern; should NOT be walked)
//   external.example.com/something    (off-host; should NOT be walked)

const PAGES: Record<string, string> = {
  'https://example.org/services/': `
    <html><body>
      <a href="/services/water/">Water</a>
      <a href="/services/parking/">Parking</a>
      <a href="/departments/random/">Departments</a>
      <a href="https://external.example.com/something">External</a>
    </body></html>
  `,
  'https://example.org/services/water/': `
    <html><body>
      <a href="/services/water/pay-bill/">Pay bill</a>
      <a href="/services/water/repair/">Repair</a>
    </body></html>
  `,
  'https://example.org/services/water/pay-bill/': '<html><body><h1>Pay water bill</h1></body></html>',
  'https://example.org/services/water/repair/': '<html><body><h1>Repair</h1></body></html>',
  'https://example.org/services/parking/': `
    <html><body>
      <a href="/services/parking/permit/">Permit</a>
    </body></html>
  `,
  'https://example.org/services/parking/permit/': '<html><body><h1>Permit</h1></body></html>',
  'https://example.org/departments/random/': '<html><body><h1>Should not visit</h1></body></html>',
}

function fakeFetch(): typeof fetch {
  return (async (url: string) => {
    const body = PAGES[url]
    if (body == null) {
      return new Response('not found', { status: 404 })
    }
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })
  }) as unknown as typeof fetch
}

const LEAF_FILTER = (url: URL): boolean => {
  // Match /services/<category>/<leaf>/ — at least 3 segments.
  if (!url.pathname.startsWith('/services/')) return false
  const segments = url.pathname.split('/').filter(Boolean)
  return segments.length >= 3
}

describe('createEnqueueDiscoverer', () => {
  let collected: string[] = []

  beforeAll(async () => {
    const discoverer = createEnqueueDiscoverer({
      seeds: ['https://example.org/services/'],
      filter: LEAF_FILTER,
      userAgent: 'test-agent',
      fetch: fakeFetch(),
    })
    for await (const url of discoverer.discover()) {
      collected.push(url.toString())
    }
  })

  it('yields all leaf URLs reachable from the seed', () => {
    expect(collected).toContain('https://example.org/services/water/pay-bill/')
    expect(collected).toContain('https://example.org/services/water/repair/')
    expect(collected).toContain('https://example.org/services/parking/permit/')
  })

  it('does not yield category index pages (filtered out)', () => {
    expect(collected).not.toContain('https://example.org/services/')
    expect(collected).not.toContain('https://example.org/services/water/')
    expect(collected).not.toContain('https://example.org/services/parking/')
  })

  it('does not walk off-pattern paths', () => {
    expect(collected).not.toContain('https://example.org/departments/random/')
  })

  it('does not walk off-host links', () => {
    expect(collected).not.toContain('https://external.example.com/something')
  })

  it('yields exactly the expected leaf count', () => {
    expect(collected).toHaveLength(3)
  })

  it('deduplicates if a URL is reachable from multiple paths', async () => {
    // Graph where /services/water/ also links to /services/parking/permit/,
    // making permit reachable from both /services/parking/ AND /services/water/.
    const dupePages: Record<string, string> = {
      ...PAGES,
      'https://example.org/services/water/': `
        <html><body>
          <a href="/services/water/pay-bill/">Pay bill</a>
          <a href="/services/parking/permit/">Permit (dup link)</a>
        </body></html>
      `,
    }
    const dupeFetch = (async (url: string) => {
      const body = dupePages[url]
      if (body == null) return new Response('not found', { status: 404 })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })
    }) as unknown as typeof fetch

    const discoverer = createEnqueueDiscoverer({
      seeds: ['https://example.org/services/'],
      filter: LEAF_FILTER,
      userAgent: 'test-agent',
      fetch: dupeFetch,
    })
    const dupCollected: string[] = []
    for await (const url of discoverer.discover()) {
      dupCollected.push(url.toString())
    }
    // Permit should appear exactly once even though linked twice
    const permitCount = dupCollected.filter(u => u === 'https://example.org/services/parking/permit/').length
    expect(permitCount).toBe(1)
  })
})
