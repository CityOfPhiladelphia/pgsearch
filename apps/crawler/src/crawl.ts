// ABOUTME: Crawl orchestrator — wires Discoverer, parse pipelines, and HTTP sink to a CheerioCrawler.
// ABOUTME: Single straight pipe per page; no persisted state. --limit counts successful ingests.

import { CheerioCrawler, log, LogLevel } from 'crawlee'
import type { Discoverer } from './discover'
import { pipelines, pipelineKeyFor } from './parse'
import type { SinkConfig } from './sink/http'
import { postDocument, SinkError } from './sink/http'

export interface CrawlOptions {
  discoverer: Discoverer
  sink: SinkConfig
  userAgent: string
  maxConcurrency?: number
  maxRetries?: number
  requestHandlerTimeoutSecs?: number
  limit?: number
}

export interface CrawlSummary {
  discovered: number
  fetched: number
  parsed: number
  ingested: number
  failed: number
  durationMs: number
}

export async function crawl(options: CrawlOptions): Promise<CrawlSummary> {
  log.setLevel(LogLevel.WARNING) // Crawlee is chatty by default; let our own logs lead.

  const counters = {
    discovered: 0,
    fetched: 0,
    parsed: 0,
    ingested: 0,
    failed: 0,
  }
  const start = Date.now()
  let stopRequested = false
  // `limit` is a soft cap — concurrent handlers may overshoot by up to maxConcurrency-1.

  const crawler = new CheerioCrawler({
    maxConcurrency: options.maxConcurrency ?? 4,
    maxRequestRetries: options.maxRetries ?? 2,
    requestHandlerTimeoutSecs: options.requestHandlerTimeoutSecs ?? 30,
    additionalMimeTypes: ['text/html'],
    preNavigationHooks: [
      async (_ctx, gotOptions) => {
        // Crawlee uses got under the hood for CheerioCrawler.
        gotOptions.headers = { ...gotOptions.headers, 'user-agent': options.userAgent }
      },
    ],
    requestHandler: async ({ request, $ }) => {
      counters.fetched++
      if (stopRequested) return

      const key = pipelineKeyFor(request.url)
      if (!key) {
        // Defensive — sitemap filter should already exclude.
        return
      }

      const parse = pipelines[key]

      let doc
      try {
        doc = await parse($.html())
        counters.parsed++
      } catch (err) {
        console.error(`[parse] failed for ${request.url}:`, (err as Error).stack ?? err)
        counters.failed++
        return
      }

      try {
        await postDocument(options.sink, doc, request.url, key)
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
        console.error(`[sink] failed for ${request.url}:`, (err as Error).message)
        counters.failed++
      }
    },
    failedRequestHandler: async ({ request }, err) => {
      console.error(`[fetch] failed for ${request.url}:`, err.message)
      counters.failed++
    },
  })

  // Drain the discoverer into the crawler queue, then run.
  for await (const url of options.discoverer.discover()) {
    counters.discovered++
    await crawler.addRequests([{ url: url.toString() }])
  }
  console.log(`[discover] enqueued ${counters.discovered} URLs`)

  await crawler.run()

  return {
    ...counters,
    durationMs: Date.now() - start,
  }
}

export function printSummary(summary: CrawlSummary): void {
  const seconds = (summary.durationMs / 1000).toFixed(1)
  console.log(``)
  console.log(`[summary] Discovered: ${summary.discovered}`)
  console.log(`[summary] Fetched:    ${summary.fetched}`)
  console.log(`[summary] Parsed:     ${summary.parsed}`)
  console.log(`[summary] Ingested:   ${summary.ingested}`)
  console.log(`[summary] Failed:     ${summary.failed}`)
  console.log(`[summary] Duration:   ${seconds}s`)
}
