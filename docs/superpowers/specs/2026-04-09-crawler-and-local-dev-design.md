# Crawler and Local Dev Loop Design

**Status:** Draft
**Date:** 2026-04-09
**Author:** Darren McDowell, Claude

## Summary

A new `apps/crawler` workspace package: a Node CLI that fetches a sitemap, filters to leaf pages under `/services/*` and `/programs/*` on phila.gov, parses each via a per-content-type pipeline built on `@phila/search-parse`, and POSTs the result to a configurable pgsearch ingest endpoint. Ships with a local development surface — a Node entrypoint for the existing Hono API, a `pgsearch_dev` database alongside the existing test database, a static test-drive HTML page, and a one-time bootstrap script that creates an index and prints keys — so the iteration loop is: bring up the DB, run the API locally, run the crawler against `localhost`, open the test page, search.

The crawler is structured around two registries — `discoverers` (how URLs are discovered) and `pipelines` (how a page becomes a `ParsedDocument`) — so adding a new source or content type means adding one entry to a map, not threading code through an orchestrator.

## Goals

- **Lightweight.** Minimal dependencies, no persistent state, no daemon. One CLI invocation, full crawl, exit.
- **Composable.** Discovery and parsing are registry-driven, keyed by const-enum constants. Adding a new sitemap variant or a new content type is a one-line registry edit.
- **Reuses existing infrastructure.** The crawler is just another client of the existing pgsearch ingest API. The local API server is the same Hono `app` the Lambda exports, with a different runtime wrapper. No fork, no parallel implementation.
- **Tight iteration loop.** Three terminals (`dev:db`, `dev:api`, `dev:crawl`) plus a static HTML page that hits the local API. Sub-minute turnaround on parse changes.
- **Containerizable later without redesign.** No AWS-runtime assumptions in the crawler or local API entrypoint. Wrapping in a Dockerfile is a future task that adds files but does not modify any of the code in this spec.

## Non-Goals

- **Containerization.** No Dockerfile, no ECS task definition, no deployment automation in this spec. The design must not bake in anything that would block later containerization, but we ship none of it now.
- **Persisted or incremental crawl state.** Every run is a full recrawl. Crawlee's persistent request queue is not used. Adding incremental support is a possible follow-up if scale demands it.
- **Recursive `enqueueLinks` discovery.** Stub only. The registry has an `ENQUEUE` entry whose `discover()` throws `NotImplementedError`. Implementation is deferred.
- **Robots.txt parsing.** A pinned User-Agent and a fixed polite-crawl config (concurrency, retries, timeout) cover us for the immediate corpora. A robots parser is a separate concern.
- **Authentication on the dev API.** The local server uses the same per-index key auth as Lambda. No bypass, no debug mode that skips auth. Dev keys are generated through the existing admin route by the bootstrap script.
- **Production deployment of the dev API.** `apps/api/local.ts` is dev-only. The Lambda handler in `apps/api/index.ts` is the production path and is not modified.
- **Extracting structured fields from the programs `.connect-box`.** Address, phone, email, and the contact card flow into the body markdown for v1. Possible follow-up.
- **Integration tests against a fake HTTP server.** The crawl loop's wiring (orchestrator, sink, CLI) is exercised by the manual smoke test (`dev:crawl` against `localhost`), not by Crawlee/`fetch` mocks.

## Architecture

### File layout

```
apps/crawler/
├── package.json              # name: @phila/search-crawler
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── cli.ts                # arg parsing + entrypoint
│   ├── crawl.ts              # CheerioCrawler wiring (orchestrator)
│   ├── discover/
│   │   ├── types.ts          # Discoverer interface
│   │   ├── index.ts          # DISCOVER constants + discoverers registry
│   │   ├── sitemap.ts        # SitemapDiscoverer
│   │   └── enqueue.ts        # stub: throws NotImplementedError
│   ├── parse/
│   │   ├── index.ts          # PIPELINE constants + pipelines registry + pipelineKeyFor
│   │   ├── services.ts       # services parse pipeline
│   │   └── programs.ts       # programs parse pipeline
│   └── sink/
│       └── http.ts           # postDocument()
└── test/
    ├── fixtures/
    │   ├── camp-philly.html        # programs sample
    │   ├── pay-water-bill.html     # services sample
    │   └── sitemap-snippet.xml     # sitemap sample
    ├── parse-services.test.ts
    ├── parse-programs.test.ts
    ├── discover-sitemap.test.ts
    └── route.test.ts

apps/api/
├── local.ts                  # @hono/node-server entrypoint (NEW)
└── dev/
    └── search.html           # test-drive page (NEW)
```

### Data flow for a single run

```
sitemap.xml ──[fetch+filter]──> AsyncIterable<URL>
                                       │
                                       ▼
                          CheerioCrawler request queue
                                       │  (parallel, polite)
                                       ▼
                       fetch HTML  →  Cheerio $  →  pipelineKeyFor(url)
                                                          │
                                                          ▼
                                                  pipelines[key]($)
                                                          │
                                                          ▼
                                                  ParsedDocument
                                                          │
                                                          ▼
                                          postDocument(endpoint, …)
                                                          │
                                                          ▼
                                          POST /index/<name>/documents
```

A single straight pipe per page. The only branch is `pipelineKeyFor` deciding which pipeline runs. No persisted state between pages or runs.

### Dependencies

- `crawlee` — `CheerioCrawler` only. Not the memory storage, not the Playwright integration.
- `@phila/search-parse` — workspace dependency.
- `@hono/node-server` — only for `apps/api/local.ts`.
- No new utility libraries. CLI argument parsing uses `parseArgs` from `node:util`.

## Discovery

### Discoverer interface

```ts
// apps/crawler/src/discover/types.ts
export interface Discoverer {
  discover(): AsyncIterable<URL>
}
```

One method. Async iterable so the orchestrator can start enqueueing as URLs arrive instead of waiting for the full list to materialize.

### Registry

```ts
// apps/crawler/src/discover/index.ts
import type { Discoverer } from './types'
import { sitemapDiscoverer } from './sitemap'
import { enqueueDiscoverer } from './enqueue'

export const DISCOVER = {
  SITEMAP: 'sitemap',
  ENQUEUE: 'enqueue',
} as const
export type DiscoverKey = (typeof DISCOVER)[keyof typeof DISCOVER]

export const discoverers: Record<DiscoverKey, Discoverer> = {
  [DISCOVER.SITEMAP]: sitemapDiscoverer,
  [DISCOVER.ENQUEUE]: enqueueDiscoverer,
}
```

The string values (`'sitemap'`, `'enqueue'`) are the literal CLI flag values, telemetry tags, and any future config-file keys. Single source of truth.

### Sitemap implementation

`sitemapDiscoverer` is constructed with a sitemap URL and a URL-pattern filter, then called via `discover()`. It fetches the XML, parses it, and yields each `<loc>` that matches the filter. The phila.gov sitemap at `https://www.phila.gov/sitemap.xml` is a flat list (not a sitemap index), so a single fetch is sufficient.

URL filter for the initial corpus: leaf pages only, accepting paths matching `/services/<segment>/<...>/` and `/programs/<segment>/`. Category roots (`/services/`, `/programs/`) and intermediate index pages (`/services/water-gas-utilities/`) are excluded. The exact regex lives in `cli.ts` and is passed to the discoverer at construction time, so the discoverer itself stays generic.

### Enqueue stub

```ts
// apps/crawler/src/discover/enqueue.ts
import type { Discoverer } from './types'

export const enqueueDiscoverer: Discoverer = {
  async *discover() {
    throw new Error('NotImplementedError: enqueue-based discovery is not yet implemented')
  },
}
```

Importing the module is free. Calling `discover()` is what flags it. The registry entry exists so future implementations slot in without touching anything else.

## Parse

### Per-content-type pipelines

Each pipeline is a `pipeline(...)` from `@phila/search-parse` exposed as a `ParseFn`:

```ts
// apps/crawler/src/parse/index.ts
import type { CheerioAPI } from 'cheerio'
import type { ParsedDocument } from '@phila/search-parse'
import { parseService } from './services'
import { parseProgram } from './programs'

export type ParseFn = (input: string | CheerioAPI) => Promise<ParsedDocument>

export const PIPELINE = {
  SERVICES: 'services',
  PROGRAMS: 'programs',
} as const
export type PipelineKey = (typeof PIPELINE)[keyof typeof PIPELINE]

export const pipelines: Record<PipelineKey, ParseFn> = {
  [PIPELINE.SERVICES]: parseService,
  [PIPELINE.PROGRAMS]: parseProgram,
}

export function pipelineKeyFor(url: string): PipelineKey | null {
  const path = new URL(url).pathname
  if (path.startsWith('/services/')) return PIPELINE.SERVICES
  if (path.startsWith('/programs/')) return PIPELINE.PROGRAMS
  return null
}
```

URL prefix is the discriminator. No content sniffing, no `<meta>` parsing for routing. (We do extract `<meta name="content_type">` into the `metadata` object, but only as a downstream signal — not to decide which pipeline runs.)

### Services pipeline

Targets the existing WordPress template:

```ts
// apps/crawler/src/parse/services.ts
import {
  pipeline,
  extractMeta,
  extractTitle,
  selectContent,
  remove,
  cleanWhitespace,
  toMarkdown,
} from '@phila/search-parse'

export const parseService = pipeline(
  extractMeta(),
  extractTitle('.entry-header h2'),
  remove('.breadcrumbs', '.related-content'),
  selectContent('.entry-content'),
  cleanWhitespace(),
  toMarkdown(),
)
```

This is the same pipeline already proven by the parse package's e2e test against `pay-a-water-bill`.

### Programs pipeline

Targets the distinct programs template (`#post-<id>.program`, `<h1>` title, `<section>`-based body):

```ts
// apps/crawler/src/parse/programs.ts
import {
  pipeline,
  extractMeta,
  extractTitle,
  selectContent,
  remove,
  cleanWhitespace,
  toMarkdown,
} from '@phila/search-parse'

export const parseProgram = pipeline(
  extractMeta(),
  extractTitle('header h1'),                    // hero header
  remove('.translations-bar', '.global-nav'),   // belt-and-braces; selectContent should already exclude
  selectContent('.program'),                    // #post-<id>.program wrapper
  cleanWhitespace(),
  toMarkdown(),
)
```

The exact selectors will be validated and refined in the test-first implementation phase. The shape is fixed: same primitives, different selectors.

## Sink

```ts
// apps/crawler/src/sink/http.ts
import type { ParsedDocument } from '@phila/search-parse'
import type { PipelineKey } from '../parse'

export interface SinkConfig {
  endpoint: string       // e.g. http://localhost:3000
  indexName: string      // e.g. phila-services-programs
  indexKey: string       // x-index-key value
}

export async function postDocument(
  config: SinkConfig,
  doc: ParsedDocument,
  sourceUrl: string,
  contentType: PipelineKey,
): Promise<void> {
  const payload = {
    external_id: sourceUrl,
    title: doc.title,
    body: doc.body,
    metadata: {
      ...doc.metadata,
      content_type: contentType,
      source_url: sourceUrl,
    },
  }
  const res = await fetch(`${config.endpoint}/index/${config.indexName}/documents`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-index-key': config.indexKey,
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new SinkError(res.status, `${res.status} ${res.statusText}: ${body}`)
  }
}

export class SinkError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
```

`external_id` is the canonical URL — re-runs upsert the same document instead of duplicating. `metadata.content_type` and `metadata.source_url` are stamped explicitly so consumers (the test-drive page, future facets) don't have to derive them.

## Orchestrator

`crawl.ts` wires the pieces together. It takes a `Discoverer`, the `pipelines` registry, the `pipelineKeyFor` function, the sink config, and Crawlee config (concurrency, UA). It constructs a `CheerioCrawler` whose request handler:

1. Calls `pipelineKeyFor(request.url)`. If null, skip (defensive).
2. Looks up `pipelines[key]` and parses the page using the Cheerio `$` handed in by Crawlee.
3. Calls `postDocument(sinkConfig, doc, request.url, key)`.
4. Increments per-stage counters on the run summary.

It iterates the discoverer with `for await (const url of discoverer.discover())`, calling `crawler.addRequests([{ url: url.toString() }])` as URLs arrive. After the discoverer is exhausted, it calls `crawler.run()`.

The orchestrator does not import any specific discoverer or pipeline implementation directly. It receives them as arguments. This keeps it decoupled from the registries and easy to test in isolation if needed later.

## CLI

```
pnpm --filter @phila/search-crawler start -- \
  --endpoint http://localhost:3000 \
  --index phila-services-programs \
  --index-key $INDEX_KEY \
  --sitemap https://www.phila.gov/sitemap.xml \
  [--concurrency 4] \
  [--limit 10]
```

Flags:

| Flag | Required | Default | Notes |
|---|---|---|---|
| `--endpoint` | yes | — | pgsearch ingest base URL |
| `--index` | yes | — | index name |
| `--index-key` | yes | — | also accepted via `INDEX_KEY` env var so it stays out of shell history |
| `--sitemap` | yes | — | sitemap URL to discover from |
| `--concurrency` | no | `4` | Crawlee `maxConcurrency` |
| `--limit` | no | (none) | dev-only — stop after N successful ingests |

`--index-key` is read from `process.env.INDEX_KEY` if not on the command line, in keeping with normal secret-handling hygiene.

Argument parsing uses `parseArgs` from `node:util`. No `commander`/`yargs` dep.

Exit code: `0` if `failed == 0`, `1` otherwise.

## Local API entrypoint

```ts
// apps/api/local.ts (NEW — sketch)
import { serve } from '@hono/node-server'
import app from './index'      // re-export app from index.ts (currently only handler is exported)

const port = Number(process.env.PORT ?? 3000)
serve({ fetch: app.fetch, port }, info => {
  console.log(`pgsearch API listening on http://localhost:${info.port}`)
})
```

`apps/api/index.ts` is updated minimally: the existing `const app = new Hono()` becomes `export const app = new Hono()` (or a `default` export). The Lambda `handler` export stays exactly as it is. No other change to `index.ts`.

DB connection uses the same env var pattern the Lambda already supports — `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` — with `DB_NAME=pgsearch_dev` set in the `dev:api` script.

## Dev database

Add `pgsearch_dev` to the existing `docker-compose.test.yml` Postgres container via an init script mounted to `/docker-entrypoint-initdb.d/`:

```yaml
# docker-compose.test.yml (additions)
services:
  postgres:
    # … existing config …
    volumes:
      - ./docker/postgres-init.sql:/docker-entrypoint-initdb.d/init.sql
```

```sql
-- docker/postgres-init.sql (NEW)
CREATE DATABASE pgsearch_dev;
```

Init scripts run only on first container creation; `docker compose down -v` recreates from scratch. Tests continue to use `pgsearch_test`. The dev API uses `pgsearch_dev`. Both share the same Postgres process and the same pgvector extension.

## Test-drive page

`apps/api/dev/search.html` — single static file, vanilla JS, no build step. Opened from disk via `file://`. CORS on the local API is already wide open (`origin: '*'` in `apps/api/index.ts`), so cross-origin calls to `http://localhost:3000` work without changes.

Page contents:

- Three text inputs at the top: **search key** (persisted to `localStorage`), **index name** (default `phila-services-programs`, persisted), **API base URL** (default `http://localhost:3000`, persisted).
- A search input and submit button.
- On submit: `fetch(base + '/search/' + index + '?q=' + encodeURIComponent(q), { headers: { 'x-search-key': key } })`.
- Renders `results[]` as a list. Each item shows: title (linked to `metadata.source_url`), a `metadata.content_type` badge (`service` / `program`), the score, and a snippet of body.
- Modest CSS for legibility. No framework, no bundler. Estimated ~150 lines including styles.

## Bootstrap script

A one-time helper to create the dev index and print its keys:

```
pnpm dev:bootstrap
# → calls POST /admin/indexes against http://localhost:3000
# → creates index "phila-services-programs" if it doesn't exist
# → prints the index key and search key to stdout
```

Implementation: a small TypeScript script under `apps/api/scripts/` (or `apps/crawler/scripts/`, TBD during implementation) that posts to the existing `/admin/indexes` admin route. Idempotent — if the index already exists, prints a "already exists" notice and exits 0. About 30 lines.

The user pastes the printed `index_key` into their `INDEX_KEY` env var (or shell rc) for the crawler, and the printed `search_key` into the search.html localStorage (via the page's input).

## Workspace scripts

Added to root `package.json`:

```json
{
  "scripts": {
    "dev:db": "docker compose -f docker-compose.test.yml up -d postgres",
    "dev:api": "DB_NAME=pgsearch_dev tsx watch apps/api/local.ts",
    "dev:bootstrap": "tsx apps/api/scripts/bootstrap-dev-index.ts",
    "dev:crawl": "pnpm --filter @phila/search-crawler start -- --endpoint http://localhost:3000 --index phila-services-programs --sitemap https://www.phila.gov/sitemap.xml"
  }
}
```

`tsx` is added as a workspace dev dependency. The crawler's own `start` script (`apps/crawler/package.json`) runs `tsx src/cli.ts` for development.

## Polite crawling

CLI-overridable defaults:

| Setting | Default | Notes |
|---|---|---|
| `maxConcurrency` | `4` | |
| `maxRequestRetries` | `2` | |
| `requestHandlerTimeoutSecs` | `30` | |
| `User-Agent` | `phila-pgsearch-crawler/0.1 (+https://github.com/CityOfPhiladelphia/pgsearch)` | Pinned explicitly. CloudFront 403s plain `curl` with no UA, so a real UA is mandatory. The contact URL lets phila.gov ops grep their access logs and reach us if we misbehave. |

No `--delay` flag. Crawlee's defaults inside `maxConcurrency: 4` are gentle enough for the corpora at hand. Add later if rate-limit signals appear.

## Error handling

| Failure | Behavior |
|---|---|
| Sitemap fetch fails (network, 5xx) | Fail fast: log and exit non-zero. No URLs means no work. |
| Sitemap parse fails (malformed XML) | Same: fail fast, exit non-zero. |
| Single page fetch fails after retries | Log error with URL, increment failure counter, continue. |
| `pipelineKeyFor(url)` returns null | Skip silently. Defensive — sitemap filter should already exclude. |
| Parse pipeline throws | Log with URL + stack, increment failure counter, continue. |
| `postDocument` returns 401 / 403 | Fail fast — bad index key means every subsequent post will also fail. |
| `postDocument` returns other non-2xx | Log with URL + status + body, increment failure counter, continue. |
| `postDocument` network error | Retry once inline; if still failing, log + count + continue. |

Run summary printed at exit:

```
Discovered: 412 URLs
Fetched:    410
Parsed:     408
Ingested:   408
Failed:     4   (see errors above)
Duration:   2m 17s
```

Logging is `console.log` / `console.error` with structured prefixes (`[discover]`, `[parse]`, `[sink]`, `[summary]`). No logging library dependency. Readable lines are the priority during the iteration loop; structured JSON can come later if and when the crawler runs in ECS.

## Testing

### Test-first targets

Per project rules, every parse pipeline and the sitemap discoverer get a failing test before implementation.

1. **`parse-services.test.ts`** — fixture-based against `test/fixtures/pay-water-bill.html` (the same fixture the parse package's e2e test uses; copy it locally so tests are hermetic). Asserts on title (`'Pay a water bill'`), `metadata.description`, `metadata.og_*`, `metadata.canonical_url`, the absence of navigation/footer text in the body, and the presence of substantive content.

2. **`parse-programs.test.ts`** — fixture-based against `test/fixtures/camp-philly.html`. Asserts on title (`'Camp Philly'`), `metadata.content_type === 'programs'` (extracted from the `<meta class="swiftype" name="content_type">` tag that phila.gov already publishes), `metadata.description`, the presence of substantive content from the program body, and the absence of nav/footer text. Selectors will be refined as tests fail and pass.

3. **`discover-sitemap.test.ts`** — fixture-based against `test/fixtures/sitemap-snippet.xml` (a representative slice of `https://www.phila.gov/sitemap.xml` — a few hundred lines including services leaves, programs leaves, departments, root, and a non-leaf). Asserts that the discoverer:
   - parses the XML and yields URL objects
   - filters by the configured pattern
   - excludes category roots and non-matching paths
   - is consumable with `for await`

4. **`route.test.ts`** — pure unit test for `pipelineKeyFor`. Covers `/services/...` → `'services'`, `/programs/...` → `'programs'`, root and other paths → `null`. Trivial, but it's the contract between discovery and parsing.

### Wiring code (no unit tests)

- `crawl.ts` orchestrator
- `sink/http.ts` `postDocument`
- `cli.ts`
- `apps/api/local.ts`
- `apps/api/scripts/bootstrap-dev-index.ts`
- `apps/api/dev/search.html`

These are exercised by the manual smoke test:

```
pnpm dev:db
pnpm dev:api
pnpm dev:bootstrap   # capture printed keys, set INDEX_KEY env, set search.html localStorage
INDEX_KEY=… pnpm dev:crawl --limit 10   # confirm 10 docs ingest cleanly
# open apps/api/dev/search.html in browser, search "water bill" and "camp"
```

If pages land in the local DB and search.html returns relevant hits, the wiring works. Unit-testing this code would mean asserting on Crawlee internals and `fetch` mocks, which test our mocks rather than our system.

## Open questions

None at design time. All of the major decisions (discovery strategy, index granularity, per-content-type pipelines, local DB layout, dev surface scope, error semantics) were resolved during brainstorming. Specific selectors in the programs pipeline will be refined during the test-first implementation phase.
