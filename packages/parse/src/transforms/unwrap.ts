// ABOUTME: unwrap transform — removes wrapper elements but keeps their children in place.
// ABOUTME: Useful for stripping presentational span/div/font tags without losing text content.

import type { Transform } from '../pipeline'

export function unwrap(...selectors: string[]): Transform {
  return (ctx) => {
    for (const selector of selectors) {
      ctx.$(selector).each((_, el) => {
        const $el = ctx.$(el)
        $el.replaceWith($el.contents())
      })
    }
    return ctx
  }
}
