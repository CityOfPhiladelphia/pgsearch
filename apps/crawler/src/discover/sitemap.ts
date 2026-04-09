// ABOUTME: Sitemap-based URL discoverer.
// ABOUTME: Fetches a flat sitemap.xml, parses <loc> entries, and yields URLs that pass the filter.

import { load } from 'cheerio'
import type { Discoverer } from './types'

export interface SitemapDiscovererOptions {
  url: string
  filter: (url: URL) => boolean
  fetch?: typeof fetch
}

export function createSitemapDiscoverer(options: SitemapDiscovererOptions): Discoverer {
  const fetchImpl = options.fetch ?? fetch
  return {
    async *discover(): AsyncIterable<URL> {
      const res = await fetchImpl(options.url)
      if (!res.ok) {
        throw new Error(`sitemap fetch failed: ${res.status} ${res.statusText}`)
      }
      const xml = await res.text()
      const $ = load(xml, { xmlMode: true })
      const locs = $('url > loc').toArray()
      for (const el of locs) {
        const text = $(el).text().trim()
        if (!text) continue
        let url: URL
        try {
          url = new URL(text)
        } catch {
          continue
        }
        if (options.filter(url)) {
          yield url
        }
      }
    },
  }
}
