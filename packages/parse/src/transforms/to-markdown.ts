// ABOUTME: toMarkdown transform — terminal step that serializes the working DOM to markdown.
// ABOUTME: Sets ctx.body using turndown with GFM and empty-paragraph stripping.

import type TurndownService from 'turndown'
import type { Transform } from '../pipeline'
import { createTurndown } from '../markdown'

export function toMarkdown(options: TurndownService.Options = {}): Transform {
  const td = createTurndown(options)
  return (ctx) => {
    const html = ctx.$.html()
    ctx.body = td.turndown(html).trim()
    return ctx
  }
}
