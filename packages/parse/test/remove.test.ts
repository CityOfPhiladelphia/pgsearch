// ABOUTME: Tests for remove transform — strips elements matching CSS selectors.
// ABOUTME: Covers single selector, multiple selectors, and missing selectors.

import { describe, it, expect } from 'vitest'
import { pipeline } from '../src/pipeline'
import { remove } from '../src/transforms/remove'
import type { Transform } from '../src/pipeline'

const captureBody: Transform = (ctx) => {
  ctx.body = ctx.$.html()
  return ctx
}

describe('remove', () => {
  it('removes elements matching a single selector', async () => {
    const parse = pipeline(remove('nav'), captureBody)
    const doc = await parse('<html><body><nav>menu</nav><p>content</p></body></html>')
    expect(doc.body).not.toContain('menu')
    expect(doc.body).toContain('content')
  })

  it('removes elements matching multiple selectors', async () => {
    const parse = pipeline(remove('nav', 'footer', '.sidebar'), captureBody)
    const doc = await parse(`
      <html><body>
        <nav>menu</nav>
        <p>content</p>
        <div class="sidebar">side</div>
        <footer>foot</footer>
      </body></html>
    `)
    expect(doc.body).not.toContain('menu')
    expect(doc.body).not.toContain('side')
    expect(doc.body).not.toContain('foot')
    expect(doc.body).toContain('content')
  })

  it('is a no-op when no selectors match', async () => {
    const parse = pipeline(remove('.does-not-exist'), captureBody)
    const doc = await parse('<html><body><p>content</p></body></html>')
    expect(doc.body).toContain('content')
  })
})
