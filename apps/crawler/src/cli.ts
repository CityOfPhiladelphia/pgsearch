// ABOUTME: CLI entrypoint for @phila/search-crawler.
// ABOUTME: Parses args, runs the crawl from seed URLs, prints the summary.

import { parseArgs } from 'node:util'
import { crawl, printSummary } from './crawl'

const USER_AGENT = 'phila-pgsearch-crawler/0.1 (+https://github.com/CityOfPhiladelphia/pgsearch)'

interface CliArgs {
  endpoint: string
  index: string
  indexKey: string
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
      seed:        { type: 'string', multiple: true },
      concurrency: { type: 'string' },
      limit:       { type: 'string' },
    },
    strict: true,
  })

  const endpoint = values.endpoint
  const index = values.index
  const indexKey = values['index-key'] ?? process.env.INDEX_KEY
  const seeds = values.seed as string[] | undefined
  const concurrency = values.concurrency ? Number(values.concurrency) : 4
  const limit = values.limit ? Number(values.limit) : undefined

  const missing: string[] = []
  if (!endpoint) missing.push('--endpoint')
  if (!index) missing.push('--index')
  if (!indexKey) missing.push('--index-key (or INDEX_KEY env var)')
  if (!seeds || seeds.length === 0) missing.push('--seed (at least one)')
  if (missing.length) {
    console.error(`error: missing required argument(s): ${missing.join(', ')}`)
    console.error('')
    console.error('usage: tsx apps/crawler/src/cli.ts \\')
    console.error('  --endpoint http://localhost:3000 \\')
    console.error('  --index phila-services-programs \\')
    console.error('  --index-key $INDEX_KEY \\')
    console.error('  --seed https://www.phila.gov/services/ \\')
    console.error('  --seed https://www.phila.gov/programs/ \\')
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
    seeds: seeds!,
    concurrency,
    limit,
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2))

  const summary = await crawl({
    seeds: args.seeds,
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
