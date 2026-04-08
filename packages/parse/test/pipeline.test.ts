// ABOUTME: Tests for the pipeline() runner — composition, async, error coercion.
// ABOUTME: Verifies transforms execute in order and final document shape is correct.

import { describe, it, expect } from 'vitest'
import { pipeline } from '../src/pipeline'
import type { Transform } from '../src/pipeline'

describe('pipeline', () => {
  it('returns a function that produces a ParsedDocument', async () => {
    const parse = pipeline()
    const doc = await parse('<html><body><p>hi</p></body></html>')
    expect(doc).toEqual({ title: '', body: '', metadata: {} })
  })

  it('runs transforms in order', async () => {
    const order: number[] = []
    const t1: Transform = (ctx) => { order.push(1); return ctx }
    const t2: Transform = (ctx) => { order.push(2); return ctx }
    const t3: Transform = (ctx) => { order.push(3); return ctx }

    const parse = pipeline(t1, t2, t3)
    await parse('<html></html>')

    expect(order).toEqual([1, 2, 3])
  })

  it('awaits async transforms', async () => {
    const setTitle: Transform = async (ctx) => {
      await new Promise((r) => setTimeout(r, 10))
      ctx.title = 'async title'
      return ctx
    }

    const parse = pipeline(setTitle)
    const doc = await parse('<html></html>')

    expect(doc.title).toBe('async title')
  })

  it('coerces null title to empty string', async () => {
    const parse = pipeline()
    const doc = await parse('<html></html>')
    expect(doc.title).toBe('')
  })

  it('coerces null body to empty string', async () => {
    const parse = pipeline()
    const doc = await parse('<html></html>')
    expect(doc.body).toBe('')
  })

  it('passes metadata through unchanged', async () => {
    const setMeta: Transform = (ctx) => {
      ctx.metadata.foo = 'bar'
      return ctx
    }

    const parse = pipeline(setMeta)
    const doc = await parse('<html></html>')

    expect(doc.metadata).toEqual({ foo: 'bar' })
  })

  it('accepts a CheerioAPI as input', async () => {
    const cheerio = await import('cheerio')
    const $ = cheerio.load('<html><body><p>hi</p></body></html>')

    const captureText: Transform = (ctx) => {
      ctx.title = ctx.$('p').text()
      return ctx
    }

    const parse = pipeline(captureText)
    const doc = await parse($)

    expect(doc.title).toBe('hi')
  })

  it('runs implicit cleanup before user transforms', async () => {
    const checkScripts: Transform = (ctx) => {
      ctx.title = String(ctx.$('script').length)
      return ctx
    }

    const parse = pipeline(checkScripts)
    const doc = await parse('<html><body><script>x</script></body></html>')

    expect(doc.title).toBe('0')
  })
})
