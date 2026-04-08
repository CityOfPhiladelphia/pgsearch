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

    const escaped = ctx.$('<p></p>').text(value)
    const root = ctx.$.root()
    if (options.position === 'prepend') {
      root.prepend(escaped)
    } else {
      root.append(escaped)
    }
    return ctx
  }
}
