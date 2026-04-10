// ABOUTME: Crawl orchestrator — wires seeds, link expansion, parse pipelines, and HTTP sink to a CheerioCrawler.
// ABOUTME: Single Crawlee instance walks the link graph from seeds. --limit counts successful ingests.

import { CheerioCrawler, log, LogLevel, RequestQueue } from 'crawlee'
import { pipelines, pipelineKeyFor } from './parse'
import type { SinkConfig } from './sink/http'
import { postDocument, SinkError } from './sink/http'

export interface CrawlOptions {
  seeds: string[]
  sink: SinkConfig
  userAgent: string
  maxConcurrency?: number
  maxRetries?: number
  requestHandlerTimeoutSecs?: number
  limit?: number
}

export interface CrawlSummary {
  fetched: number
  parsed: number
  ingested: number
  failed: number
  durationMs: number
}

export async function crawl(options: CrawlOptions): Promise<CrawlSummary> {
  log.setLevel(LogLevel.WARNING)

  // `limit` is a soft cap — concurrent handlers may overshoot by up to maxConcurrency-1.
  const counters = {
    fetched: 0,
    parsed: 0,
    ingested: 0,
    failed: 0,
  }
  const start = Date.now()
  let stopRequested = false

  if (options.seeds.length === 0) {
    throw new Error('crawl: at least one seed URL is required')
  }

  // Pre-compute walk constraints from the seeds. We follow same-hostname links
  // whose path starts with any of the seed paths.
  const seedUrls = options.seeds.map(s => new URL(s))
  const seedHostname = seedUrls[0].hostname
  for (const u of seedUrls) {
    if (u.hostname !== seedHostname) {
      throw new Error(`crawl: all seeds must share the same hostname (saw ${seedHostname} and ${u.hostname})`)
    }
  }
  const seedPaths = seedUrls.map(u => u.pathname)

  const queueName = `crawl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const requestQueue = await RequestQueue.open(queueName)

  const crawler = new CheerioCrawler({
    requestQueue,
    maxConcurrency: options.maxConcurrency ?? 4,
    maxRequestRetries: options.maxRetries ?? 2,
    requestHandlerTimeoutSecs: options.requestHandlerTimeoutSecs ?? 30,
    additionalMimeTypes: ['text/html'],
    preNavigationHooks: [
      async (_ctx, gotOptions) => {
        gotOptions.headers = { ...gotOptions.headers, 'user-agent': options.userAgent }
      },
    ],
    requestHandler: async ({ request, response, $, enqueueLinks }) => {
      counters.fetched++
      if (stopRequested) return

      // Crawlee passes 4xx HTML bodies to the success handler by default.
      // Treat anything outside 2xx as a failed fetch.
      const status = response?.statusCode
      if (status != null && (status < 200 || status >= 300)) {
        console.error(`[fetch] non-2xx for ${request.url}: ${status}`)
        counters.failed++
        return
      }

      // Expand the queue with same-hostname links under any seed path.
      // We walk MORE than the leaf filter (e.g. category roots) so we can find
      // the leaves they link to.
      await enqueueLinks({
        strategy: 'same-hostname',
        transformRequestFunction: (req) => {
          try {
            const u = new URL(req.url)
            if (u.hostname !== seedHostname) return false
            const underSeed = seedPaths.some(p => u.pathname.startsWith(p))
            if (!underSeed) return false
            return req
          } catch {
            return false
          }
        },
      })

      // Decide whether to parse and ingest THIS page.
      const finalUrl = request.loadedUrl ?? request.url
      const key = pipelineKeyFor(finalUrl)
      if (!key) {
        // Page is walked (links extracted above) but not parsed.
        return
      }

      const parse = pipelines[key]

      let doc
      try {
        doc = await parse($.html())
        counters.parsed++
      } catch (err) {
        console.error(`[parse] failed for ${finalUrl}:`, (err as Error).stack ?? err)
        counters.failed++
        return
      }

      try {
        await postDocument(options.sink, doc, finalUrl, key)
        counters.ingested++
        if (options.limit != null && counters.ingested >= options.limit) {
          stopRequested = true
          console.log(`[summary] limit ${options.limit} reached; stopping`)
          await crawler.autoscaledPool?.abort()
        }
      } catch (err) {
        if (err instanceof SinkError && (err.status === 401 || err.status === 403)) {
          console.error(`[sink] auth failed (${err.status}); aborting run`)
          counters.failed++
          stopRequested = true
          await crawler.autoscaledPool?.abort()
          return
        }
        console.error(`[sink] failed for ${finalUrl}:`, (err as Error).message)
        counters.failed++
      }
    },
    failedRequestHandler: async ({ request }, err) => {
      console.error(`[fetch] failed for ${request.url}:`, err.message)
      counters.failed++
    },
  })

  try {
    await crawler.addRequests(options.seeds.map(url => ({ url })))
    await crawler.run()
  } finally {
    // Quiet Crawlee's post-abort cleanup chatter so it doesn't pollute the summary output.
    // Drop is best-effort cleanup: errors are LOGGED with [crawl] prefix, not silently swallowed.
    log.setLevel(LogLevel.OFF)
    try {
      await requestQueue.drop()
    } catch (err) {
      console.error('[crawl] queue cleanup error (non-fatal):', (err as Error).message)
    }
  }

  return {
    ...counters,
    durationMs: Date.now() - start,
  }
}

export function printSummary(summary: CrawlSummary): void {
  const seconds = (summary.durationMs / 1000).toFixed(1)
  console.log(``)
  console.log(`[summary] Fetched:   ${summary.fetched}`)
  console.log(`[summary] Parsed:    ${summary.parsed}`)
  console.log(`[summary] Ingested:  ${summary.ingested}`)
  console.log(`[summary] Failed:    ${summary.failed}`)
  console.log(`[summary] Duration:  ${seconds}s`)
}
