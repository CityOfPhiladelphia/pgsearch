// ABOUTME: Tests for cleanWhitespace transform — normalizes whitespace in text nodes.
// ABOUTME: Collapses runs of whitespace and unicode whitespace characters to single spaces.

import { describe, it, expect } from 'vitest'
import { pipeline } from '../src/pipeline'
import { cleanWhitespace } from '../src/transforms/clean-whitespace'
import type { Transform } from '../src/pipeline'

const captureBody: Transform = (ctx) => {
  ctx.body = ctx.$('p').text()
  return ctx
}

describe('cleanWhitespace', () => {
  it('collapses runs of spaces to a single space', async () => {
    const parse = pipeline(cleanWhitespace(), captureBody)
    const doc = await parse('<html><body><p>hello    world</p></body></html>')
    expect(doc.body).toBe('hello world')
  })

  it('collapses tabs and newlines', async () => {
    const parse = pipeline(cleanWhitespace(), captureBody)
    const doc = await parse('<html><body><p>hello\t\n   world</p></body></html>')
    expect(doc.body).toBe('hello world')
  })

  it('normalizes unicode whitespace (nbsp, zero-width space)', async () => {
    const parse = pipeline(cleanWhitespace(), captureBody)
    const doc = await parse('<html><body><p>hello\u00A0world\u200Bagain</p></body></html>')
    expect(doc.body).toBe('hello world again')
  })

  it('trims leading and trailing whitespace from text nodes', async () => {
    const parse = pipeline(cleanWhitespace(), captureBody)
    const doc = await parse('<html><body><p>   hello world   </p></body></html>')
    expect(doc.body).toBe('hello world')
  })

  it('preserves spaces between inline siblings (anchor mid-sentence)', async () => {
    const parse = pipeline(cleanWhitespace(), captureBody)
    const doc = await parse('<html><body><p>Please <a href="/x">click here</a> to continue.</p></body></html>')
    expect(doc.body).toBe('Please click here to continue.')
  })

  it('preserves spaces between inline siblings (strong and em)', async () => {
    const parse = pipeline(cleanWhitespace(), captureBody)
    const doc = await parse('<html><body><p><strong>bold</strong> and <em>italic</em></p></body></html>')
    expect(doc.body).toBe('bold and italic')
  })

  it('collapses but does not strip whitespace-only text between siblings', async () => {
    const parse = pipeline(cleanWhitespace(), captureBody)
    const doc = await parse('<html><body><p><span>a</span>   <span>b</span></p></body></html>')
    expect(doc.body).toBe('a b')
  })
})
