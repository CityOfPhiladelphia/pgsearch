// ABOUTME: cleanWhitespace transform — normalizes whitespace in text nodes.
// ABOUTME: Collapses runs of whitespace and unicode whitespace to single spaces, then trims.

import type { Transform } from '../pipeline'

// Matches runs of any unicode whitespace, including tabs, newlines, nbsp, zero-width space, etc.
const WHITESPACE_RUN = /[\s\u00A0\u200B\u200C\u200D\uFEFF]+/g

export function cleanWhitespace(): Transform {
  return (ctx) => {
    ctx.$('*')
      .contents()
      .filter(function () {
        return this.type === 'text'
      })
      .each(function () {
        // Cheerio text nodes have a `data` property
        const node = this as unknown as { data: string }
        node.data = node.data.replace(WHITESPACE_RUN, ' ').trim()
      })
    return ctx
  }
}
