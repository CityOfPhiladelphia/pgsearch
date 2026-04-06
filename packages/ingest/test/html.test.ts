// ABOUTME: Tests for HTML content parser.
// ABOUTME: Verifies title extraction, body text extraction, custom selectors, and metadata merging.

import { describe, it, expect } from 'vitest'
import { parseHtml } from '../src/html'

describe('parseHtml', () => {
  it('extracts title from h1', () => {
    const doc = parseHtml('<html><body><h1>My Title</h1><p>Content here.</p></body></html>')
    expect(doc.title).toBe('My Title')
  })

  it('extracts body text without HTML tags', () => {
    const doc = parseHtml('<html><body><h1>Title</h1><p>Paragraph one.</p><p>Paragraph two.</p></body></html>')
    expect(doc.body).toContain('Paragraph one')
    expect(doc.body).toContain('Paragraph two')
    expect(doc.body).not.toContain('<p>')
  })

  it('uses custom title selector', () => {
    const html = '<html><body><div class="page-title">Custom Title</div><main>Main content.</main></body></html>'
    const doc = parseHtml(html, { titleSelector: '.page-title' })
    expect(doc.title).toBe('Custom Title')
  })

  it('uses custom content selector', () => {
    const html = '<html><body><nav>Nav stuff</nav><main>Main content only.</main><footer>Footer</footer></body></html>'
    const doc = parseHtml(html, { contentSelector: 'main' })
    expect(doc.body).toBe('Main content only.')
    expect(doc.body).not.toContain('Nav stuff')
    expect(doc.body).not.toContain('Footer')
  })

  it('merges provided metadata', () => {
    const doc = parseHtml('<html><body><h1>T</h1><p>B</p></body></html>', {
      metadata: { source: 'phila.gov', url: 'https://phila.gov/page' }
    })
    expect(doc.metadata?.source).toBe('phila.gov')
    expect(doc.metadata?.url).toBe('https://phila.gov/page')
  })

  it('falls back to title tag if no h1', () => {
    const doc = parseHtml('<html><head><title>Page Title</title></head><body><p>Content.</p></body></html>')
    expect(doc.title).toBe('Page Title')
  })

  it('uses empty string for title if none found', () => {
    const doc = parseHtml('<html><body><p>Just content.</p></body></html>')
    expect(doc.title).toBe('')
  })
})
