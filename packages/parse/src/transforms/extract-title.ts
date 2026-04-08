// ABOUTME: extractTitle transform — explicit selector or h1 → og_title → html_title fallback chain.
// ABOUTME: Sets ctx.title; throws in required mode when nothing resolves.

import type { Transform } from '../pipeline'

export interface ExtractTitleOptions {
  required?: boolean
}

export function extractTitle(selector?: string, options: ExtractTitleOptions = {}): Transform {
  return (ctx) => {
    let title: string | null = null

    if (selector) {
      const text = ctx.$(selector).first().text().trim()
      if (text) title = text
    } else {
      const h1Text = ctx.$('h1').first().text().trim()
      if (h1Text) {
        title = h1Text
      } else if (typeof ctx.metadata.og_title === 'string') {
        title = ctx.metadata.og_title
      } else if (typeof ctx.metadata.html_title === 'string') {
        title = ctx.metadata.html_title
      }
    }

    if (title === null && options.required) {
      throw new Error(
        selector
          ? `extractTitle: required selector "${selector}" matched no elements`
          : 'extractTitle: required title could not be resolved (no h1, og_title, or html_title)'
      )
    }

    ctx.title = title
    return ctx
  }
}
