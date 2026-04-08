// ABOUTME: Tests for injectIntoBody transform — injects metadata fields as paragraphs into the working DOM.
// ABOUTME: Used pre-toMarkdown to add publisher descriptions or other metadata into the embedded body.

import { describe, it, expect } from 'vitest'
import { pipeline } from '../src/pipeline'
import { extractMeta } from '../src/transforms/extract-meta'
import { injectIntoBody } from '../src/transforms/inject-into-body'
import { toMarkdown } from '../src/transforms/to-markdown'

describe('injectIntoBody', () => {
  it('prepends metadata field as a paragraph', async () => {
    const parse = pipeline(
      extractMeta(),
      injectIntoBody({ from: 'description', position: 'prepend' }),
      toMarkdown(),
    )
    const doc = await parse(`
      <html>
        <head><meta name="description" content="A great summary"></head>
        <body><p>Original content</p></body>
      </html>
    `)
    const lines = doc.body.split('\n').filter((l) => l.trim())
    expect(lines[0]).toContain('A great summary')
    expect(doc.body).toContain('Original content')
  })

  it('appends metadata field as a paragraph', async () => {
    const parse = pipeline(
      extractMeta(),
      injectIntoBody({ from: 'description', position: 'append' }),
      toMarkdown(),
    )
    const doc = await parse(`
      <html>
        <head><meta name="description" content="Footer summary"></head>
        <body><p>Original content</p></body>
      </html>
    `)
    const lines = doc.body.split('\n').filter((l) => l.trim())
    expect(lines[lines.length - 1]).toContain('Footer summary')
    expect(doc.body).toContain('Original content')
  })

  it('is a no-op when metadata field is missing', async () => {
    const parse = pipeline(
      injectIntoBody({ from: 'description', position: 'prepend' }),
      toMarkdown(),
    )
    const doc = await parse('<html><body><p>Original content</p></body></html>')
    expect(doc.body).toContain('Original content')
    expect(doc.body).not.toContain('description')
  })

  it('is a no-op when metadata field is empty string', async () => {
    const parse = pipeline(
      extractMeta(),
      injectIntoBody({ from: 'description', position: 'prepend' }),
      toMarkdown(),
    )
    const doc = await parse(`
      <html>
        <head><meta name="description" content=""></head>
        <body><p>Original content</p></body>
      </html>
    `)
    expect(doc.body).toContain('Original content')
  })
})
