// ABOUTME: Tests for extractTitle — explicit selector or h1 → og_title → html_title fallback.
// ABOUTME: Covers required mode and the relationship with extractMeta-populated metadata.

import { describe, it, expect } from 'vitest'
import { pipeline } from '../src/pipeline'
import { extractMeta } from '../src/transforms/extract-meta'
import { extractTitle } from '../src/transforms/extract-title'

describe('extractTitle', () => {
  it('uses explicit selector when provided', async () => {
    const parse = pipeline(extractTitle('.page-title'))
    const doc = await parse('<html><body><h1>Wrong</h1><div class="page-title">Right</div></body></html>')
    expect(doc.title).toBe('Right')
  })

  it('with no selector, falls back to first h1', async () => {
    const parse = pipeline(extractTitle())
    const doc = await parse('<html><body><h1>From H1</h1><h1>Second</h1></body></html>')
    expect(doc.title).toBe('From H1')
  })

  it('with no selector, falls back to og_title from metadata', async () => {
    const parse = pipeline(extractMeta(), extractTitle())
    const doc = await parse('<html><head><meta property="og:title" content="From OG"></head><body></body></html>')
    expect(doc.title).toBe('From OG')
  })

  it('with no selector, falls back to html_title from metadata', async () => {
    const parse = pipeline(extractMeta(), extractTitle())
    const doc = await parse('<html><head><title>From Title Tag</title></head><body></body></html>')
    expect(doc.title).toBe('From Title Tag')
  })

  it('h1 wins over og_title and html_title', async () => {
    const parse = pipeline(extractMeta(), extractTitle())
    const doc = await parse(`
      <html>
        <head>
          <title>From Title Tag</title>
          <meta property="og:title" content="From OG">
        </head>
        <body><h1>From H1</h1></body>
      </html>
    `)
    expect(doc.title).toBe('From H1')
  })

  it('og_title wins over html_title', async () => {
    const parse = pipeline(extractMeta(), extractTitle())
    const doc = await parse(`
      <html>
        <head>
          <title>From Title Tag</title>
          <meta property="og:title" content="From OG">
        </head>
        <body></body>
      </html>
    `)
    expect(doc.title).toBe('From OG')
  })

  it('returns empty title when nothing matches', async () => {
    const parse = pipeline(extractTitle())
    const doc = await parse('<html><body></body></html>')
    expect(doc.title).toBe('')
  })

  it('throws when required: true and explicit selector matches nothing', async () => {
    const parse = pipeline(extractTitle('.does-not-exist', { required: true }))
    await expect(parse('<html><body></body></html>')).rejects.toThrow(/title/i)
  })

  it('throws when required: true and no fallback resolves', async () => {
    const parse = pipeline(extractTitle(undefined, { required: true }))
    await expect(parse('<html><body></body></html>')).rejects.toThrow(/title/i)
  })

  it('trims whitespace from extracted title', async () => {
    const parse = pipeline(extractTitle('h1'))
    const doc = await parse('<html><body><h1>   spaced out   </h1></body></html>')
    expect(doc.title).toBe('spaced out')
  })
})
