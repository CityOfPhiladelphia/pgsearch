// ABOUTME: injectIntoBody transform — injects a metadata field as a paragraph into the working DOM.
// ABOUTME: Wraps the value in a <p> so it survives markdown conversion as a standalone paragraph.

import type { Transform } from '../pipeline'

export interface InjectIntoBodyOptions {
  from: string
  position: 'prepend' | 'append'
}

export function injectIntoBody(options: InjectIntoBodyOptions): Transform {
  return (ctx) => {
    const value = ctx.metadata[options.from]
    if (typeof value !== 'string' || value.trim() === '') {
      return ctx
    }

    const paragraph = ctx.$('<p></p>').text(value)
    // Prefer <body> as the insertion target so the injected paragraph lives inside the document.
    // Fall back to the document root for narrowed fragments (e.g. after selectContent stripped <body>).
    const body = ctx.$('body')
    if (body.length > 0) {
      if (options.position === 'prepend') {
        body.prepend(paragraph)
      } else {
        body.append(paragraph)
      }
    } else {
      const root = ctx.$.root()
      if (options.position === 'prepend') {
        root.prepend(paragraph)
      } else {
        root.append(paragraph)
      }
    }
    return ctx
  }
}
