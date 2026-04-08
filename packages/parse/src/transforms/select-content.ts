// ABOUTME: selectContent transform — narrows ctx.$ to a subtree selected by CSS selector.
// ABOUTME: Subsequent content transforms operate within the narrowed scope.

import * as cheerio from 'cheerio'
import type { Transform } from '../pipeline'

export interface SelectContentOptions {
  required?: boolean
}

export function selectContent(selector: string, options: SelectContentOptions = {}): Transform {
  return (ctx) => {
    const matched = ctx.$(selector).first()
    if (matched.length === 0) {
      if (options.required) {
        throw new Error(`selectContent: required selector "${selector}" matched no elements`)
      }
      return ctx
    }

    const html = ctx.$.html(matched)
    ctx.$ = cheerio.load(html)
    return ctx
  }
}
