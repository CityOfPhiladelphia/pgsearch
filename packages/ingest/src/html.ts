// ABOUTME: Parses HTML documents into structured text for search ingestion.
// ABOUTME: Extracts title, body text, and metadata from HTML content.

import { parse } from 'node-html-parser'

interface ParseHtmlOptions {
  titleSelector?: string
  contentSelector?: string
  metadata?: Record<string, unknown>
}

interface ParsedDocument {
  title: string
  body: string
  metadata?: Record<string, unknown>
}

export function parseHtml(html: string, options?: ParseHtmlOptions): ParsedDocument {
  const root = parse(html)

  // Extract title
  let title = ''
  if (options?.titleSelector) {
    title = root.querySelector(options.titleSelector)?.textContent?.trim() || ''
  } else {
    title = root.querySelector('h1')?.textContent?.trim()
      || root.querySelector('title')?.textContent?.trim()
      || ''
  }

  // Extract body
  let body = ''
  if (options?.contentSelector) {
    body = root.querySelector(options.contentSelector)?.textContent?.trim() || ''
  } else {
    // Get body content, stripping the title element to avoid duplication
    const bodyEl = root.querySelector('body')
    if (bodyEl) {
      const h1 = bodyEl.querySelector('h1')
      if (h1) h1.remove()
      body = bodyEl.textContent?.trim() || ''
    }
  }

  return {
    title,
    body,
    metadata: options?.metadata,
  }
}
