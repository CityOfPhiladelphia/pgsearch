// ABOUTME: Tests for extractMeta — meta tag extraction with blocklist and key normalization.
// ABOUTME: Covers default extraction, options (only/exclude/extras), and standard tag handling.

import { describe, it, expect } from 'vitest'
import { pipeline } from '../src/pipeline'
import { extractMeta } from '../src/transforms/extract-meta'

const html = (head: string) => `<html lang="en-US"><head>${head}</head><body><p>x</p></body></html>`

describe('extractMeta', () => {
  it('extracts description', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse(html('<meta name="description" content="A test page">'))
    expect(doc.metadata.description).toBe('A test page')
  })

  it('extracts og:* tags as og_*', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse(html(`
      <meta property="og:title" content="Page Title">
      <meta property="og:description" content="Page description">
      <meta property="og:url" content="https://example.com/page">
      <meta property="og:image" content="https://example.com/img.jpg">
      <meta property="og:type" content="article">
      <meta property="og:site_name" content="Example">
    `))
    expect(doc.metadata.og_title).toBe('Page Title')
    expect(doc.metadata.og_description).toBe('Page description')
    expect(doc.metadata.og_url).toBe('https://example.com/page')
    expect(doc.metadata.og_image).toBe('https://example.com/img.jpg')
    expect(doc.metadata.og_type).toBe('article')
    expect(doc.metadata.og_site_name).toBe('Example')
  })

  it('extracts article:* tags as article_*', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse(html(`
      <meta property="article:published_time" content="2026-01-01T00:00:00Z">
      <meta property="article:modified_time" content="2026-02-01T00:00:00Z">
      <meta property="article:author" content="Jane Doe">
    `))
    expect(doc.metadata.article_published_time).toBe('2026-01-01T00:00:00Z')
    expect(doc.metadata.article_modified_time).toBe('2026-02-01T00:00:00Z')
    expect(doc.metadata.article_author).toBe('Jane Doe')
  })

  it('extracts <title> as html_title', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse('<html><head><title>Page</title></head><body></body></html>')
    expect(doc.metadata.html_title).toBe('Page')
  })

  it('extracts <html lang> as language', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse(html(''))
    expect(doc.metadata.language).toBe('en-US')
  })

  it('extracts canonical URL from link[rel=canonical]', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse(html('<link rel="canonical" href="https://example.com/canonical">'))
    expect(doc.metadata.canonical_url).toBe('https://example.com/canonical')
  })

  it('falls back to og:url for canonical when no link[rel=canonical]', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse(html('<meta property="og:url" content="https://example.com/og">'))
    expect(doc.metadata.canonical_url).toBe('https://example.com/og')
  })

  it('blocks twitter:* tags by default', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse(html(`
      <meta name="twitter:title" content="Tweet Title">
      <meta name="twitter:description" content="Tweet desc">
      <meta name="twitter:image" content="https://example.com/tw.jpg">
    `))
    expect(doc.metadata.twitter_title).toBeUndefined()
    expect(doc.metadata.twitter_description).toBeUndefined()
    expect(doc.metadata.twitter_image).toBeUndefined()
  })

  it('blocks viewport, charset, and other browser hints', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse(html(`
      <meta name="viewport" content="width=device-width">
      <meta charset="utf-8">
      <meta http-equiv="X-UA-Compatible" content="IE=edge">
      <meta name="theme-color" content="#fff">
      <meta name="format-detection" content="telephone=no">
      <meta name="referrer" content="no-referrer">
    `))
    expect(doc.metadata.viewport).toBeUndefined()
    expect(doc.metadata.charset).toBeUndefined()
    expect(doc.metadata.theme_color).toBeUndefined()
    expect(doc.metadata.format_detection).toBeUndefined()
    expect(doc.metadata.referrer).toBeUndefined()
  })

  it('blocks SEO directives (robots, googlebot)', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse(html(`
      <meta name="robots" content="index,follow">
      <meta name="googlebot" content="noarchive">
    `))
    expect(doc.metadata.robots).toBeUndefined()
    expect(doc.metadata.googlebot).toBeUndefined()
  })

  it('blocks verification tags', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse(html(`
      <meta name="google-site-verification" content="abc123">
      <meta name="msvalidate.01" content="xyz">
      <meta property="fb:app_id" content="12345">
    `))
    expect(doc.metadata.google_site_verification).toBeUndefined()
    expect(doc.metadata['msvalidate.01']).toBeUndefined()
    expect(doc.metadata.fb_app_id).toBeUndefined()
  })

  it('blocks mobile app shims', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse(html(`
      <meta name="apple-mobile-web-app-capable" content="yes">
      <meta name="msapplication-TileColor" content="#fff">
      <meta name="application-name" content="App">
      <meta name="HandheldFriendly" content="True">
    `))
    expect(doc.metadata.apple_mobile_web_app_capable).toBeUndefined()
    expect(doc.metadata.msapplication_tilecolor).toBeUndefined()
    expect(doc.metadata.application_name).toBeUndefined()
    expect(doc.metadata.handheldfriendly).toBeUndefined()
  })

  it('respects only option to narrow extraction', async () => {
    const parse = pipeline(extractMeta({ only: ['description'] }))
    const doc = await parse(html(`
      <meta name="description" content="kept">
      <meta name="author" content="dropped">
      <meta property="og:title" content="dropped">
    `))
    expect(doc.metadata.description).toBe('kept')
    expect(doc.metadata.author).toBeUndefined()
    expect(doc.metadata.og_title).toBeUndefined()
  })

  it('respects exclude option to add to default exclusions', async () => {
    const parse = pipeline(extractMeta({ exclude: [/^article_/] }))
    const doc = await parse(html(`
      <meta name="description" content="kept">
      <meta property="article:published_time" content="dropped">
    `))
    expect(doc.metadata.description).toBe('kept')
    expect(doc.metadata.article_published_time).toBeUndefined()
  })

  it('respects extras option to map custom selectors', async () => {
    const parse = pipeline(extractMeta({ extras: { custom_field: 'meta[name=custom]' } }))
    const doc = await parse(html('<meta name="custom" content="custom value">'))
    expect(doc.metadata.custom_field).toBe('custom value')
  })

  it('extras are added even when only is set', async () => {
    const parse = pipeline(extractMeta({
      only: ['description'],
      extras: { custom_field: 'meta[name=custom]' },
    }))
    const doc = await parse(html(`
      <meta name="description" content="kept">
      <meta name="custom" content="extra value">
      <meta name="author" content="dropped">
    `))
    expect(doc.metadata.description).toBe('kept')
    expect(doc.metadata.custom_field).toBe('extra value')
    expect(doc.metadata.author).toBeUndefined()
  })

  it('normalizes colon-separated names to snake_case', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse(html('<meta property="og:image:alt" content="Alt text">'))
    expect(doc.metadata.og_image_alt).toBe('Alt text')
  })

  it('skips meta tags with no content attribute', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse(html('<meta name="description">'))
    expect(doc.metadata.description).toBeUndefined()
  })
})
