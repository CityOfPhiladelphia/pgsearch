// ABOUTME: remove transform — strips elements matching one or more CSS selectors.
// ABOUTME: Mutates ctx.$ in place. Idempotent and lenient when selectors match nothing.

import type { Transform } from '../pipeline'

export function remove(...selectors: string[]): Transform {
  return (ctx) => {
    for (const selector of selectors) {
      ctx.$(selector).remove()
    }
    return ctx
  }
}
