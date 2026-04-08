// ABOUTME: Tests for ParseContext creation and implicit cleanup.
// ABOUTME: Verifies that scripts, styles, noscript, and comments are stripped on load.

import { describe, it, expect } from 'vitest'
import { createContext } from '../src/context'

describe('createContext', () => {
  it('accepts an HTML string and returns a populated context', () => {
    const ctx = createContext('<html><body><p>hello</p></body></html>')
    expect(ctx.$).toBeDefined()
    expect(ctx.title).toBeNull()
    expect(ctx.body).toBeNull()
    expect(ctx.metadata).toEqual({})
    expect(ctx.$('p').text()).toBe('hello')
  })

  it('strips script tags on creation', () => {
    const ctx = createContext('<html><body><script>alert(1)</script><p>hi</p></body></html>')
    expect(ctx.$('script').length).toBe(0)
    expect(ctx.$('p').text()).toBe('hi')
  })

  it('strips style tags on creation', () => {
    const ctx = createContext('<html><head><style>body { color: red }</style></head><body><p>hi</p></body></html>')
    expect(ctx.$('style').length).toBe(0)
  })

  it('strips noscript tags on creation', () => {
    const ctx = createContext('<html><body><noscript>nope</noscript><p>hi</p></body></html>')
    expect(ctx.$('noscript').length).toBe(0)
  })

  it('strips HTML comments on creation', () => {
    const ctx = createContext('<html><body><!-- a comment --><p>hi</p></body></html>')
    const html = ctx.$.root().html()
    expect(html).not.toContain('a comment')
  })

  it('strips top-level HTML comments before <html>', () => {
    const ctx = createContext('<!-- top comment --><html><body><p>hi</p></body></html>')
    const html = ctx.$.root().html()
    expect(html).not.toContain('top comment')
  })

  it('accepts an existing CheerioAPI instance', async () => {
    const cheerio = await import('cheerio')
    const $ = cheerio.load('<html><body><script>x</script><p>hi</p></body></html>')
    const ctx = createContext($)
    expect(ctx.$('script').length).toBe(0)
    expect(ctx.$('p').text()).toBe('hi')
  })
})
