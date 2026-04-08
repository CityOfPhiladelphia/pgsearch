// ABOUTME: ParseContext creation and implicit HTML cleanup.
// ABOUTME: Strips script, style, noscript, and HTML comments before any user transforms run.

import * as cheerio from 'cheerio'
import type { CheerioAPI } from 'cheerio'
import type { ParseContext } from './pipeline'

export function createContext(input: string | CheerioAPI): ParseContext {
  const $ = typeof input === 'string' ? cheerio.load(input) : input

  // Implicit cleanup: strip elements that have zero search value.
  $('script, style, noscript').remove()

  // Remove HTML comments at any depth, including top-level nodes before <html>.
  // $('*').contents() only walks element descendants, so we also walk the root's
  // own contents to catch comments that sit outside the document element.
  $.root()
    .contents()
    .filter(function () {
      return this.type === 'comment'
    })
    .remove()
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
