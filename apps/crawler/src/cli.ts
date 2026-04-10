// ABOUTME: CLI entrypoint for @phila/search-crawler.
// ABOUTME: Parses args, constructs a discoverer (sitemap or enqueue), runs the crawl, prints the summary.

import { parseArgs } from 'node:util'
import { createSitemapDiscoverer, createEnqueueDiscoverer } from './discover'
import { crawl, printSummary } from './crawl'

const USER_AGENT = 'phila-pgsearch-crawler/0.1 (+https://github.com/CityOfPhiladelphia/pgsearch)'

const PHILA_LEAF_FILTER = (url: URL): boolean => {
  const p = url.pathname
  if (p.startsWith('/services/')) {
    const segments = p.split('/').filter(Boolean)
    return segments.length >= 3
  }
  if (p.startsWith('/programs/')) {
    const segments = p.split('/').filter(Boolean)
    return segments.length === 2
  }
  return false
}

interface CliArgs {
  endpoint: string
  index: string
  indexKey: string
  discover: 'sitemap' | 'enqueue'
  sitemap: string | undefined
  seeds: string[]
  concurrency: number
  limit: number | undefined
}

function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      endpoint:    { type: 'string' },
      index:       { type: 'string' },
      'index-key': { type: 'string' },
      discover:    { type: 'string' },
      sitemap:     { type: 'string' },
      seed:        { type: 'string', multiple: true },
      concurrency: { type: 'string' },
      limit:       { type: 'string' },
    },
    strict: true,
  })

  const endpoint = values.endpoint
  const index = values.index
  const indexKey = values['index-key'] ?? process.env.INDEX_KEY
  const discoverMode = (values.discover ?? 'sitemap') as 'sitemap' | 'enqueue'
  const sitemap = values.sitemap
  const seeds = (values.seed ?? []) as string[]
  const concurrency = values.concurrency ? Number(values.concurrency) : 4
  const limit = values.limit ? Number(values.limit) : undefined

  if (discoverMode !== 'sitemap' && discoverMode !== 'enqueue') {
    console.error(`error: --discover must be 'sitemap' or 'enqueue' (got ${discoverMode})`)
    process.exit(2)
  }

  const missing: string[] = []
  if (!endpoint) missing.push('--endpoint')
  if (!index) missing.push('--index')
  if (!indexKey) missing.push('--index-key (or INDEX_KEY env var)')
  if (discoverMode === 'sitemap' && !sitemap) missing.push('--sitemap')
  if (discoverMode === 'enqueue' && seeds.length === 0) missing.push('--seed (at least one required with --discover enqueue)')
  if (missing.length) {
    console.error(`error: missing required argument(s): ${missing.join(', ')}`)
    console.error('')
    console.error('usage: pnpm --filter @phila/search-crawler start -- \\')
    console.error('  --endpoint http://localhost:3000 \\')
    console.error('  --index phila-services-programs \\')
    console.error('  --index-key $INDEX_KEY \\')
    console.error('  --sitemap https://www.phila.gov/sitemap.xml \\')
    console.error('  [--discover sitemap|enqueue] [--seed <url> (repeatable)] \\')
    console.error('  [--concurrency 4] [--limit 10]')
    process.exit(2)
  }

  if (Number.isNaN(concurrency) || concurrency < 1) {
    console.error(`error: --concurrency must be a positive integer (got ${values.concurrency})`)
    process.exit(2)
  }
  if (limit !== undefined && (Number.isNaN(limit) || limit < 1)) {
    console.error(`error: --limit must be a positive integer (got ${values.limit})`)
    process.exit(2)
  }

  return {
    endpoint: endpoint!,
    index: index!,
    indexKey: indexKey!,
    discover: discoverMode,
    sitemap,
    seeds,
    concurrency,
    limit,
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2))

  const discoverer = args.discover === 'enqueue'
    ? createEnqueueDiscoverer({
        seeds: args.seeds,
        filter: PHILA_LEAF_FILTER,
        userAgent: USER_AGENT,
        maxConcurrency: args.concurrency,
      })
    : createSitemapDiscoverer({
        url: args.sitemap!,
        filter: PHILA_LEAF_FILTER,
      })

  const summary = await crawl({
    discoverer,
    sink: {
      endpoint: args.endpoint,
      indexName: args.index,
      indexKey: args.indexKey,
    },
    userAgent: USER_AGENT,
    maxConcurrency: args.concurrency,
    limit: args.limit,
  })

  printSummary(summary)

  if (summary.failed > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('[fatal]', err.stack ?? err)
  process.exit(1)
})
