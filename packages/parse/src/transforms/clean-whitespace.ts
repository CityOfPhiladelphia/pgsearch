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
        // Cheerio text nodes have data, prev, and next properties.
        // Only trim text nodes that are sole children of their parent;
        // text nodes with siblings preserve their whitespace runs (collapsed to single space)
        // so spaces between inline siblings like <a>, <strong>, <em> are not lost.
        const node = this as unknown as { data: string; prev: unknown; next: unknown }
        const collapsed = node.data.replace(WHITESPACE_RUN, ' ')
        if (node.prev === null && node.next === null) {
          node.data = collapsed.trim()
        } else {
          node.data = collapsed
        }
      })
    return ctx
  }
}
