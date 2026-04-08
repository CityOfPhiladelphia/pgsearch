// ABOUTME: Pipeline runner and core types for the @phila/search-parse package.
// ABOUTME: Composes transforms into a callable that produces a ParsedDocument from HTML.

import type { CheerioAPI } from 'cheerio'
import { createContext } from './context'

export interface ParseContext {
  $: CheerioAPI
  title: string | null
  body: string | null
  metadata: Record<string, unknown>
}

export type Transform = (ctx: ParseContext) => ParseContext | Promise<ParseContext>

export interface ParsedDocument {
  title: string
  body: string
  metadata: Record<string, unknown>
}

export function pipeline(
  ...transforms: Transform[]
): (input: string | CheerioAPI) => Promise<ParsedDocument> {
  return async (input) => {
    let ctx = createContext(input)
    for (const transform of transforms) {
      ctx = await transform(ctx)
    }
    return {
      title: ctx.title ?? '',
      body: ctx.body ?? '',
      metadata: ctx.metadata,
    }
  }
}
