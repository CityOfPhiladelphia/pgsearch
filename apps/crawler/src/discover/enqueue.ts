// ABOUTME: Recursive enqueueLinks-based URL discoverer; walks the link graph from seeds.
// ABOUTME: Yields URLs matching a caller-supplied filter by traversing links within seed URL paths.

import { CheerioCrawler, log, LogLevel, RequestQueue } from 'crawlee'
import type { Discoverer } from './types'

export interface EnqueueDiscovererOptions {
  seeds: string[]
  filter: (url: URL) => boolean
  userAgent: string
  maxConcurrency?: number
  // Optional fetch for tests — when supplied, the discoverer uses a fake fetch-based walker
  // instead of the real Crawlee crawler. See test file for usage.
  fetch?: typeof fetch
}

export function createEnqueueDiscoverer(options: EnqueueDiscovererOptions): Discoverer {
  return {
    async *discover(): AsyncIterable<URL> {
      const matched: URL[] = []
      const seenForYield = new Set<string>()

      // Test path: when a fetch is injected, walk the graph using the provided fetch
      // and cheerio. This avoids spinning up a real Crawlee crawler in unit tests.
      if (options.fetch) {
        for (const url of await walkWithFetch(options.seeds, options.filter, options.fetch)) {
          const key = url.toString()
          if (!seenForYield.has(key)) {
            seenForYield.add(key)
            matched.push(url)
          }
        }
        for (const url of matched) yield url
        return
      }

      // Production path: real Crawlee crawler with an isolated request queue.
      // Each run gets its own named queue so it doesn't collide with the main
      // orchestrator's queue or with previous runs' state.
      log.setLevel(LogLevel.WARNING)
      const seedUrls = options.seeds.map(s => new URL(s))
      const seedHostname = seedUrls[0]?.hostname
      const queueName = `discover-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const requestQueue = await RequestQueue.open(queueName)
      const crawler = new CheerioCrawler({
        requestQueue,
        maxConcurrency: options.maxConcurrency ?? 4,
        maxRequestRetries: 2,
        requestHandlerTimeoutSecs: 30,
        preNavigationHooks: [
          async (_ctx, gotOptions) => {
            gotOptions.headers = { ...gotOptions.headers, 'user-agent': options.userAgent }
          },
        ],
        requestHandler: async ({ request, response, enqueueLinks }) => {
          // Respect non-2xx — don't follow links from error pages.
          const status = response?.statusCode
          if (status != null && (status < 200 || status >= 300)) return

          const finalUrl = new URL(request.loadedUrl ?? request.url)

          // Yield this URL if it matches the leaf filter.
          if (options.filter(finalUrl)) {
            const key = finalUrl.toString()
            if (!seenForYield.has(key)) {
              seenForYield.add(key)
              matched.push(finalUrl)
            }
          }

          // Follow same-hostname links whose path is under any of the seed paths.
          // We walk MORE than just the leaf filter (e.g. category roots that don't
          // match the leaf filter) so we can find leaves they link to.
          await enqueueLinks({
            strategy: 'same-hostname',
            transformRequestFunction: (req) => {
              try {
                const u = new URL(req.url)
                if (u.hostname !== seedHostname) return false
                const underSeed = seedUrls.some(seed => u.pathname.startsWith(seed.pathname))
                if (!underSeed) return false
                return req
              } catch {
                return false
              }
            },
          })
        },
        failedRequestHandler: async ({ request }, err) => {
          console.error(`[discover/enqueue] failed for ${request.url}:`, err.message)
        },
      })

      try {
        await crawler.addRequests(options.seeds.map(url => ({ url })))
        await crawler.run()
      } finally {
        await requestQueue.drop()
      }

      for (const url of matched) yield url
    },
  }
}

// Walks the link graph using an injected fetch + cheerio. Same semantics as the
// Crawlee path but without spinning up a real crawler. Returns matched URLs.
async function walkWithFetch(
  seeds: string[],
  filter: (url: URL) => boolean,
  fetchImpl: typeof fetch,
): Promise<URL[]> {
  const { load } = await import('cheerio')
  const seedUrls = seeds.map(s => new URL(s))
  const seedHostname = seedUrls[0]?.hostname
  const visited = new Set<string>()
  const matched: URL[] = []
  const queue: string[] = [...seeds]

  while (queue.length > 0) {
    const next = queue.shift()!
    if (visited.has(next)) continue
    visited.add(next)

    const res = await fetchImpl(next)
    if (!res.ok) continue
    const html = await res.text()

    let pageUrl: URL
    try {
      pageUrl = new URL(next)
    } catch {
      continue
    }
    if (filter(pageUrl)) {
      matched.push(pageUrl)
    }

    const $ = load(html)
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href')
      if (!href) return
      let linkUrl: URL
      try {
        linkUrl = new URL(href, pageUrl)
      } catch {
        return
      }
      if (linkUrl.hostname !== seedHostname) return
      const underSeed = seedUrls.some(seed => linkUrl.pathname.startsWith(seed.pathname))
      if (!underSeed) return
      const key = linkUrl.toString()
      if (visited.has(key) || queue.includes(key)) return
      queue.push(key)
    })
  }

  return matched
}
