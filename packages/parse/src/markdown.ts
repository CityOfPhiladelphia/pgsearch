// ABOUTME: Turndown configuration for HTML→markdown conversion.
// ABOUTME: Adds GFM extensions (tables, strikethrough) and a custom rule to strip empty paragraphs.

import TurndownService from 'turndown'
// @ts-ignore — turndown-plugin-gfm has no types
import { gfm } from 'turndown-plugin-gfm'

export function createTurndown(options: TurndownService.Options = {}): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    linkStyle: 'inlined',
    emDelimiter: '_',
    ...options,
  })

  td.use(gfm)

  // Custom rule: strip empty paragraphs (turndown has no built-in option for this).
  td.addRule('strip-empty-paragraphs', {
    filter: (node) => {
      return node.nodeName === 'P' && node.textContent?.trim() === ''
    },
    replacement: () => '',
  })

  // Override turndown's default list item rule, which pads markers with extra spaces
  // (producing "-   one" and "1.  first"). A single space after the marker keeps the
  // output compact: matters for embedding token budget and for readable search snippets.
  td.addRule('list-item', {
    filter: 'li',
    replacement: (content, node, ruleOptions) => {
      const liNode = node as unknown as {
        parentNode: { nodeName: string; getAttribute: (name: string) => string | null; children: ArrayLike<unknown> } | null
        nextSibling: unknown
      }
      const parent = liNode.parentNode
      let prefix = `${ruleOptions.bulletListMarker} `
      if (parent && parent.nodeName === 'OL') {
        const start = parent.getAttribute('start')
        const index = Array.prototype.indexOf.call(parent.children, node)
        const number = start ? Number(start) + index : index + 1
        prefix = `${number}. `
      }
      const indented = content
        .replace(/^\n+/, '')
        .replace(/\n+$/, '')
        .replace(/\n/gm, '\n' + ' '.repeat(prefix.length))
      return prefix + indented + (liNode.nextSibling ? '\n' : '')
    },
  })

  return td
}
