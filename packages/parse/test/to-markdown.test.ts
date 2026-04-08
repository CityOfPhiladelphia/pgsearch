// ABOUTME: Tests for toMarkdown transform — terminal step that serializes the working DOM to markdown.
// ABOUTME: Verifies headings, lists, links, table support, and empty paragraph stripping.

import { describe, it, expect } from 'vitest'
import { pipeline } from '../src/pipeline'
import { toMarkdown } from '../src/transforms/to-markdown'

describe('toMarkdown', () => {
  it('converts h1 to ATX heading', async () => {
    const parse = pipeline(toMarkdown())
    const doc = await parse('<html><body><h1>Heading</h1></body></html>')
    expect(doc.body).toContain('# Heading')
  })

  it('converts h2 and h3', async () => {
    const parse = pipeline(toMarkdown())
    const doc = await parse('<html><body><h2>Two</h2><h3>Three</h3></body></html>')
    expect(doc.body).toContain('## Two')
    expect(doc.body).toContain('### Three')
  })

  it('converts unordered lists with dash bullets', async () => {
    const parse = pipeline(toMarkdown())
    const doc = await parse('<html><body><ul><li>one</li><li>two</li></ul></body></html>')
    expect(doc.body).toContain('- one')
    expect(doc.body).toContain('- two')
  })

  it('converts ordered lists', async () => {
    const parse = pipeline(toMarkdown())
    const doc = await parse('<html><body><ol><li>first</li><li>second</li></ol></body></html>')
    expect(doc.body).toContain('1. first')
    expect(doc.body).toContain('2. second')
  })

  it('converts links with inline style', async () => {
    const parse = pipeline(toMarkdown())
    const doc = await parse('<html><body><p>see <a href="https://example.com">example</a></p></body></html>')
    expect(doc.body).toContain('[example](https://example.com)')
  })

  it('converts strong and em', async () => {
    const parse = pipeline(toMarkdown())
    const doc = await parse('<html><body><p><strong>bold</strong> and <em>italic</em></p></body></html>')
    expect(doc.body).toContain('**bold**')
    expect(doc.body).toContain('_italic_')
  })

  it('converts GFM tables', async () => {
    const parse = pipeline(toMarkdown())
    const doc = await parse(`
      <html><body>
        <table>
          <thead><tr><th>Col1</th><th>Col2</th></tr></thead>
          <tbody><tr><td>A</td><td>B</td></tr></tbody>
        </table>
      </body></html>
    `)
    expect(doc.body).toContain('| Col1')
    expect(doc.body).toContain('| Col2')
    expect(doc.body).toContain('| A')
    expect(doc.body).toContain('| B')
  })

  it('strips empty paragraphs', async () => {
    const parse = pipeline(toMarkdown())
    const doc = await parse('<html><body><p>kept</p><p></p><p>   </p></body></html>')
    // Should have "kept" but no orphan blank lines from empty paragraphs
    expect(doc.body).toContain('kept')
    // The body should not have more than two consecutive newlines from the empties
    expect(doc.body).not.toMatch(/\n\n\n\n/)
  })

  it('sets ctx.body and the final document body matches', async () => {
    const parse = pipeline(toMarkdown())
    const doc = await parse('<html><body><h1>Title</h1><p>para</p></body></html>')
    expect(doc.body).toContain('# Title')
    expect(doc.body).toContain('para')
  })
})
