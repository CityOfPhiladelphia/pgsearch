// ABOUTME: Tests for unwrap transform — removes wrapper elements but keeps their children.
// ABOUTME: Covers single selector, nested unwrapping, and missing selectors.

import { describe, it, expect } from 'vitest'
import { pipeline } from '../src/pipeline'
import { unwrap } from '../src/transforms/unwrap'
import type { Transform } from '../src/pipeline'

const captureBody: Transform = (ctx) => {
  ctx.body = ctx.$.html()
  return ctx
}

describe('unwrap', () => {
  it('removes the wrapper element but keeps children', async () => {
    const parse = pipeline(unwrap('span'), captureBody)
    const doc = await parse('<html><body><p>hello <span>world</span></p></body></html>')
    expect(doc.body).toContain('hello world')
    expect(doc.body).not.toContain('<span>')
  })

  it('handles multiple selectors', async () => {
    const parse = pipeline(unwrap('span', 'em'), captureBody)
    const doc = await parse('<html><body><p>a <span>b</span> <em>c</em></p></body></html>')
    expect(doc.body).not.toContain('<span>')
    expect(doc.body).not.toContain('<em>')
    expect(doc.body).toContain('a b c')
  })

  it('is a no-op when no selectors match', async () => {
    const parse = pipeline(unwrap('.does-not-exist'), captureBody)
    const doc = await parse('<html><body><p>content</p></body></html>')
    expect(doc.body).toContain('content')
  })
})
