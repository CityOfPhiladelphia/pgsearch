// ABOUTME: Tests for selectContent — narrows the working DOM to a subtree.
// ABOUTME: Covers narrowing behavior, missing selectors, and required mode.

import { describe, it, expect } from 'vitest'
import { pipeline } from '../src/pipeline'
import { selectContent } from '../src/transforms/select-content'
import type { Transform } from '../src/pipeline'

describe('selectContent', () => {
  const captureBody: Transform = (ctx) => {
    ctx.body = ctx.$.html()
    return ctx
  }

  it('narrows the working DOM to the selected subtree', async () => {
    const parse = pipeline(selectContent('.content'), captureBody)
    const doc = await parse(`
      <html><body>
        <nav>navigation text</nav>
        <div class="content"><p>kept</p></div>
        <footer>footer text</footer>
      </body></html>
    `)
    expect(doc.body).toContain('kept')
    expect(doc.body).not.toContain('navigation text')
    expect(doc.body).not.toContain('footer text')
  })

  it('is a no-op when selector matches nothing', async () => {
    const parse = pipeline(selectContent('.does-not-exist'), captureBody)
    const doc = await parse('<html><body><p>kept</p></body></html>')
    expect(doc.body).toContain('kept')
  })

  it('throws when required: true and selector matches nothing', async () => {
    const parse = pipeline(selectContent('.does-not-exist', { required: true }))
    await expect(parse('<html><body></body></html>')).rejects.toThrow(/selectContent/i)
  })

  it('uses the first match when selector matches multiple elements', async () => {
    const parse = pipeline(selectContent('.content'), captureBody)
    const doc = await parse(`
      <html><body>
        <div class="content"><p>first</p></div>
        <div class="content"><p>second</p></div>
      </body></html>
    `)
    expect(doc.body).toContain('first')
    expect(doc.body).not.toContain('second')
  })
})
