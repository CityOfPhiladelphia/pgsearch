// ABOUTME: ParseContext creation and implicit HTML cleanup.
// ABOUTME: Strips script, style, noscript, and HTML comments before any user transforms run.

import * as cheerio from 'cheerio'
import type { CheerioAPI } from 'cheerio'
import type { ParseContext } from './pipeline'

export function createContext(input: string | CheerioAPI): ParseContext {
  const $ = typeof input === 'string' ? cheerio.load(input) : input

  // Implicit cleanup: strip elements that have zero search value.
  $('script, style, noscript').remove()

  // Remove HTML comments. Cheerio represents comments as nodes with type 'comment'.
  $('*')
    .contents()
    .filter(function () {
      return this.type === 'comment'
    })
    .remove()

  return {
    $,
    title: null,
    body: null,
    metadata: {},
  }
}
