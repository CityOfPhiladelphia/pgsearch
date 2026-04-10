# Crawler and Local Dev Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `apps/crawler` (a Crawlee+Cheerio CLI that ingests phila.gov `/services/*` and `/programs/*` leaf pages into pgsearch via the existing ingest API) and the supporting local development surface (Node Hono entrypoint, dev database, bootstrap script, static test-drive HTML page).

**Architecture:** The crawler is structured around two registries — `discoverers` (URL discovery strategies) and `pipelines` (per-content-type parse pipelines from `@phila/search-parse`) — plus a thin orchestrator that wires Crawlee's `CheerioCrawler` to them and a sink that POSTs to the ingest API. The local dev surface reuses the existing Hono `app` from `apps/api/index.ts` via `@hono/node-server`, runs against a new `pgsearch_dev` database in the existing test compose, and ships a static HTML page that calls the local search endpoint.

**Tech Stack:** TypeScript, Node 20+, pnpm workspaces, Crawlee 3.x (`CheerioCrawler` only), `@phila/search-parse` (workspace), `@hono/node-server`, `tsx`, vitest, Postgres+pgvector (existing test compose).

**Spec:** [`docs/superpowers/specs/2026-04-09-crawler-and-local-dev-design.md`](../specs/2026-04-09-crawler-and-local-dev-design.md)

---

## Conventions used in this plan

- **TDD for code with branches.** Parse pipelines, route functions, and the sitemap discoverer get failing tests first, then implementation.
- **No unit tests for pure wiring.** The HTTP sink, the orchestrator, the CLI, the local API entrypoint, the bootstrap script, and the HTML page are exercised by the manual smoke test in Task 15. Per the spec, mocking Crawlee or `fetch` to "test" them would test the mocks, not the system.
- **One commit per task.** Every task ends with a commit.
- **Exact commands in every step.** No "run the tests" — every command is copy-pasteable.
- **File-level header comments are mandatory** per project rules: every code file starts with `// ABOUTME: ` lines.

## Order rationale

Tasks 1–6 establish the local dev surface end-to-end with an empty index, so the loop is observably alive (DB up, API running, bootstrap creating an index, HTML page loading) before any crawler code is written. Tasks 7–11 build the parse and discover layers test-first. Tasks 12–14 wire the orchestrator and CLI. Task 15 is the manual smoke test that validates the whole loop.

---

## Task 1: Scaffold the `apps/crawler` workspace package

**Files:**
- Create: `apps/crawler/package.json`
- Create: `apps/crawler/tsconfig.json`
- Create: `apps/crawler/vitest.config.ts`
- Create: `apps/crawler/src/.gitkeep`
- Create: `apps/crawler/test/.gitkeep`

- [ ] **Step 1: Create `apps/crawler/package.json`**

```json
{
  "name": "@phila/search-crawler",
  "version": "0.0.1",
  "private": true,
  "main": "src/cli.ts",
  "scripts": {
    "build": "tsc",
    "start": "tsx src/cli.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@phila/search-parse": "workspace:*",
    "cheerio": "^1.0.0",
    "crawlee": "^3.11.0"
  },
  "devDependencies": {
    "@types/node": "^20.10.0",
    "tsx": "^4.19.0",
    "typescript": "^5.3.0",
    "vitest": "^3.1.0"
  }
}
```

- [ ] **Step 2: Create `apps/crawler/tsconfig.json`**

Match the existing parse package's tsconfig style. Read `packages/parse/tsconfig.json` first to mirror its compilerOptions (target, module, strict, outDir, rootDir, esModuleInterop). The crawler's tsconfig should be the same shape with `rootDir: "src"` and `outDir: "dist"`.

- [ ] **Step 3: Create `apps/crawler/vitest.config.ts`**

Mirror `packages/parse/vitest.config.ts`. Read it first; the crawler's config should be the same shape with `test: { include: ['test/**/*.test.ts'] }`.

- [ ] **Step 4: Create empty src and test directories with `.gitkeep` files**

```bash
mkdir -p apps/crawler/src apps/crawler/test
touch apps/crawler/src/.gitkeep apps/crawler/test/.gitkeep
```

- [ ] **Step 5: Run pnpm install and verify the workspace picks it up**

```bash
pnpm install
```

Expected: install completes; `pnpm --filter @phila/search-crawler exec node -e "console.log('ok')"` prints `ok`.

- [ ] **Step 6: Verify the package is recognized by the workspace test runner**

```bash
pnpm --filter @phila/search-crawler test
```

Expected: vitest reports "No test files found, exiting with code 0" or similar (no failure). It's fine if vitest exits non-zero specifically because it has no tests yet — record the exact message.

- [ ] **Step 7: Commit**

```bash
git add apps/crawler/ pnpm-lock.yaml
git commit -m "feat(crawler): scaffold @phila/search-crawler workspace package"
```

---

## Task 2: Add `pgsearch_dev` database to the existing docker compose

**Files:**
- Create: `docker/postgres-init.sql`
- Modify: `docker-compose.test.yml`

- [ ] **Step 1: Create the init script directory and file**

```bash
mkdir -p docker
```

`docker/postgres-init.sql`:

```sql
-- ABOUTME: Postgres init script run on first container creation.
-- ABOUTME: Creates the pgsearch_dev database alongside the existing pgsearch_test database.

CREATE DATABASE pgsearch_dev;
```

- [ ] **Step 2: Mount the init script in `docker-compose.test.yml`**

Read `docker-compose.test.yml` first to see the current shape. Add a `volumes:` key to the `postgres` service:

```yaml
    volumes:
      - ./docker/postgres-init.sql:/docker-entrypoint-initdb.d/init.sql
```

- [ ] **Step 3: Recreate the container so the init script runs**

```bash
docker compose -f docker-compose.test.yml down -v
docker compose -f docker-compose.test.yml up -d postgres
```

The `-v` removes the volume so the init script runs again on first boot.

- [ ] **Step 4: Verify both databases exist**

```bash
docker compose -f docker-compose.test.yml exec postgres psql -U pgsearch -l
```

Expected: both `pgsearch_test` and `pgsearch_dev` appear in the list.

- [ ] **Step 5: Run the existing api tests to confirm nothing broke**

```bash
pnpm --filter api test
```

Expected: tests pass against `pgsearch_test` exactly as before.

- [ ] **Step 6: Commit**

```bash
git add docker/ docker-compose.test.yml
git commit -m "feat(dev): add pgsearch_dev database to test compose"
```

---

## Task 3: Prepare `apps/api` for local execution

Two changes prep the API for being run from a Node process: export the Hono `app`, and teach `db/pool.ts` to fall back to plain env vars when `DB_SECRET_ARN` is absent (the Lambda path always sets it; the local path never will).

**Files:**
- Modify: `apps/api/index.ts`
- Modify: `apps/api/db/pool.ts`

- [ ] **Step 1: Add `export` to the existing `const app = new Hono()` declaration**

The current line in `apps/api/index.ts` is:

```ts
const app = new Hono()
```

Change it to:

```ts
export const app = new Hono()
```

That's the entire change to `index.ts`. Do not modify the `export const handler = handle(app)` line. Do not add or remove anything else.

- [ ] **Step 2: Add a local fallback to `apps/api/db/pool.ts`**

The current `getPool` body unconditionally calls `getPhilaPool()` from `@phila/db-postgres`, which requires `DB_SECRET_ARN` and fetches credentials from AWS Secrets Manager. Locally we have neither. Add a branch:

The current `getPool` is:

```ts
export async function getPool(): Promise<Pool> {
  if (!pool) {
    const { getPool: getPhilaPool } = await import('@phila/db-postgres')
    pool = await getPhilaPool()
  }
  return pool
}
```

Change it to:

```ts
export async function getPool(): Promise<Pool> {
  if (!pool) {
    if (process.env.DB_SECRET_ARN) {
      const { getPool: getPhilaPool } = await import('@phila/db-postgres')
      pool = await getPhilaPool()
    } else {
      pool = new Pool({
        host:     process.env.DB_HOST,
        port:     Number(process.env.DB_PORT),
        database: process.env.DB_NAME,
        user:     process.env.DB_USER,
        password: process.env.DB_PASSWORD,
      })
    }
  }
  return pool
}
```

`Pool` is already imported at the top of the file (`import { Pool } from 'pg'`). No new imports needed. The Lambda path is byte-identical because `DB_SECRET_ARN` is always set in that environment. The local path activates only when that var is absent.

Note: `apps/api/test/setup.ts` builds its own pool independently of `db/pool.ts` and is not affected by this change.

- [ ] **Step 3: Verify the api still type-checks**

```bash
pnpm --filter api exec tsc --noEmit
```

Expected: clean exit. (Use `tsc --noEmit` rather than the package's `build` script — that script runs esbuild, which bundles but does not actually type-check.)

- [ ] **Step 4: Run the existing api tests to confirm the Lambda path is unaffected**

```bash
pnpm --filter api test
```

Expected: all tests pass. Tests use their own pool (`test/setup.ts`), so they don't exercise either branch of the new code — but they do confirm nothing else broke.

- [ ] **Step 5: Commit**

```bash
git add apps/api/index.ts apps/api/db/pool.ts
git commit -m "refactor(api): export app and add local-mode fallback to db pool

The Hono app is now exported so a local Node entrypoint can wrap it.
db/pool.ts gains a fallback that connects with plain env vars when
DB_SECRET_ARN is absent — the Lambda path is unchanged; the local
path activates only when that var is missing."
```

---

## Task 4: Add the local Node entrypoint and `dev:api` workspace script

**Files:**
- Create: `apps/api/local.ts`
- Modify: `apps/api/package.json` (add `@hono/node-server` dependency)
- Modify: `package.json` (root — add `tsx` devDep + `dev:db`, `dev:api` scripts)

- [ ] **Step 1: Add `@hono/node-server` to `apps/api/package.json`**

In the `devDependencies` block, add (alphabetical order, before `@phila/search-parse`):

```json
"@hono/node-server": "^1.13.0",
```

- [ ] **Step 2: Add `tsx` to root `package.json` devDependencies**

In root `package.json`, add to `devDependencies` (alphabetical):

```json
"tsx": "^4.19.0",
```

- [ ] **Step 3: Add the `dev:db` and `dev:api` scripts to root `package.json`**

In root `package.json` `scripts`:

```json
"dev:db": "docker compose -f docker-compose.test.yml up -d postgres",
"dev:api": "DB_HOST=localhost DB_PORT=5433 DB_NAME=pgsearch_dev DB_USER=pgsearch DB_PASSWORD=testpassword tsx watch apps/api/local.ts"
```

The DB env vars match the existing `apps/api/test/setup.ts` shape, swapping `pgsearch_test` for `pgsearch_dev`.

- [ ] **Step 4: Run `pnpm install` to pick up the new deps**

```bash
pnpm install
```

Expected: install completes cleanly.

- [ ] **Step 5: Create `apps/api/local.ts`**

```ts
// ABOUTME: Local Node entrypoint for the pgsearch API.
// ABOUTME: Runs the same Hono app as the Lambda handler under @hono/node-server for dev iteration.

import { serve } from '@hono/node-server'
import { app } from './index'

const port = Number(process.env.PORT ?? 3000)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`pgsearch API listening on http://localhost:${info.port}`)
})
```

- [ ] **Step 6: Smoke-test the local API end-to-end**

This step is also the empirical check that Task 3 Step 2's `db/pool.ts` fallback works — if the pool wiring is wrong, the request will fail with a clear DB error.

In one terminal:

```bash
pnpm dev:db
pnpm dev:api
```

Expected: `pgsearch API listening on http://localhost:3000`.

In another terminal:

```bash
curl -sv http://localhost:3000/public/health
```

Expected: HTTP 200 with a JSON health body. The first request triggers migrations on the empty `pgsearch_dev` DB and may take a few seconds.

If the response is 5xx or the API process crashes with a DB error, pause and read the error carefully:
- "DB_SECRET_ARN environment variable required" → Task 3 Step 2's fallback didn't take effect (likely the file wasn't saved or `dev:api` is somehow setting `DB_SECRET_ARN`).
- "ECONNREFUSED" → `pgsearch_dev` isn't reachable; verify `pnpm dev:db` is up and `psql -h localhost -p 5433 -U pgsearch -d pgsearch_dev -c '\q'` succeeds.
- "database pgsearch_dev does not exist" → Task 2's init script didn't run. Re-run `docker compose -f docker-compose.test.yml down -v && pnpm dev:db`.

Stop the dev:api process (Ctrl-C) when done.

- [ ] **Step 7: Commit**

```bash
git add apps/api/local.ts apps/api/package.json package.json pnpm-lock.yaml
git commit -m "feat(api): add local Hono node entrypoint and dev workspace scripts"
```

---

## Task 5: Add the bootstrap script and `dev:bootstrap` workspace script

**Files:**
- Create: `apps/api/scripts/bootstrap-dev-index.ts`
- Modify: `package.json` (add `dev:bootstrap` script)

- [ ] **Step 1: Create the bootstrap script**

`apps/api/scripts/bootstrap-dev-index.ts`:

```ts
// ABOUTME: One-time helper that creates the dev search index and prints its keys.
// ABOUTME: Idempotent — if the index already exists, prints a notice and exits 0 unless --force is set.

const API_BASE = process.env.API_BASE ?? 'http://localhost:3000'
const INDEX_NAME = process.env.INDEX_NAME ?? 'phila-services-programs'
const FORCE = process.argv.includes('--force')

async function main(): Promise<void> {
  const existing = await fetch(`${API_BASE}/private/key/admin/indexes/${INDEX_NAME}`)
  if (existing.status === 200) {
    if (!FORCE) {
      console.log(`[bootstrap] index '${INDEX_NAME}' already exists at ${API_BASE}.`)
      console.log(`[bootstrap] keys cannot be retrieved after creation. Pass --force to drop and recreate.`)
      return
    }
    console.log(`[bootstrap] --force set; deleting existing index '${INDEX_NAME}'`)
    const del = await fetch(`${API_BASE}/private/key/admin/indexes/${INDEX_NAME}`, { method: 'DELETE' })
    if (!del.ok) {
      throw new Error(`delete failed: ${del.status} ${await del.text()}`)
    }
  } else if (existing.status !== 404) {
    throw new Error(`unexpected status checking index existence: ${existing.status} ${await existing.text()}`)
  }

  const create = await fetch(`${API_BASE}/private/key/admin/indexes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: INDEX_NAME,
      description: 'phila.gov services and programs (dev)',
    }),
  })
  if (!create.ok) {
    throw new Error(`create failed: ${create.status} ${await create.text()}`)
  }
  const result = await create.json() as { name: string; index_key: string; search_key: string; created_at: string }

  console.log(`[bootstrap] created index '${result.name}'`)
  console.log(``)
  console.log(`  index_key:  ${result.index_key}`)
  console.log(`  search_key: ${result.search_key}`)
  console.log(``)
  console.log(`Set INDEX_KEY in your shell for the crawler:`)
  console.log(`  export INDEX_KEY=${result.index_key}`)
  console.log(``)
  console.log(`Paste search_key into the test-drive page (apps/api/dev/search.html):`)
  console.log(`  ${result.search_key}`)
}

main().catch((err) => {
  console.error('[bootstrap] failed:', err.message)
  process.exit(1)
})
```

- [ ] **Step 2: Add the `dev:bootstrap` script to root `package.json`**

```json
"dev:bootstrap": "tsx apps/api/scripts/bootstrap-dev-index.ts"
```

- [ ] **Step 3: Smoke-test the bootstrap script**

In one terminal, with the dev API running (`pnpm dev:db && pnpm dev:api`):

```bash
pnpm dev:bootstrap
```

Expected: prints the index name, an `idx_*` index key, an `srch_*` search key, and the export hint.

- [ ] **Step 4: Smoke-test idempotency**

```bash
pnpm dev:bootstrap
```

Expected: prints `index 'phila-services-programs' already exists` and exits 0.

- [ ] **Step 5: Smoke-test --force**

```bash
pnpm dev:bootstrap -- --force
```

Expected: deletes and recreates, prints new keys (different from previous).

- [ ] **Step 6: Commit**

```bash
git add apps/api/scripts/ package.json
git commit -m "feat(api): add dev index bootstrap script"
```

---

## Task 6: Add the static test-drive HTML page

**Files:**
- Create: `apps/api/dev/search.html`

- [ ] **Step 1: Create `apps/api/dev/search.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>pgsearch dev</title>
<style>
  body { font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 780px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.2rem; margin-bottom: 1rem; }
  .config { background: #f4f4f4; padding: 1rem; border-radius: 6px; margin-bottom: 1.5rem; }
  .config label { display: block; margin-bottom: 0.5rem; font-size: 12px; color: #555; }
  .config input { width: 100%; padding: 0.4rem; box-sizing: border-box; font-family: inherit; font-size: 13px; }
  form.search { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
  form.search input[type=search] { flex: 1; padding: 0.6rem; font-size: 14px; }
  form.search button { padding: 0.6rem 1rem; font-size: 14px; cursor: pointer; }
  .result { padding: 1rem 0; border-top: 1px solid #e4e4e4; }
  .result h3 { margin: 0 0 0.3rem; font-size: 1rem; }
  .result h3 a { color: #0a5fb1; text-decoration: none; }
  .result h3 a:hover { text-decoration: underline; }
  .badge { display: inline-block; background: #e8eef5; color: #0a5fb1; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 11px; margin-right: 0.5rem; vertical-align: middle; }
  .score { color: #888; font-size: 12px; }
  .snippet { color: #555; margin-top: 0.3rem; }
  .empty, .error { padding: 1rem; text-align: center; color: #888; }
  .error { color: #b00020; }
</style>
</head>
<body>

<h1>pgsearch dev</h1>

<div class="config">
  <label>API base URL <input id="api-base" value="http://localhost:3000"></label>
  <label>Index name <input id="index-name" value="phila-services-programs"></label>
  <label>Search key <input id="search-key" type="password" placeholder="srch_..."></label>
</div>

<form class="search" onsubmit="event.preventDefault(); runSearch();">
  <input type="search" id="q" placeholder="Search…" autofocus>
  <button type="submit">Search</button>
</form>

<div id="results"></div>

<script>
  const $apiBase = document.getElementById('api-base');
  const $indexName = document.getElementById('index-name');
  const $searchKey = document.getElementById('search-key');
  const $q = document.getElementById('q');
  const $results = document.getElementById('results');

  // Restore from localStorage
  for (const [el, key] of [[$apiBase, 'apiBase'], [$indexName, 'indexName'], [$searchKey, 'searchKey']]) {
    const saved = localStorage.getItem('pgsearch:' + key);
    if (saved) el.value = saved;
    el.addEventListener('input', () => localStorage.setItem('pgsearch:' + key, el.value));
  }

  async function runSearch() {
    const q = $q.value.trim();
    if (!q) return;
    const base = $apiBase.value.replace(/\/$/, '');
    const index = $indexName.value;
    const key = $searchKey.value;
    $results.innerHTML = '<div class="empty">searching…</div>';
    try {
      const res = await fetch(`${base}/search/${encodeURIComponent(index)}?q=${encodeURIComponent(q)}&limit=20`, {
        headers: { 'x-search-key': key },
      });
      if (!res.ok) {
        const body = await res.text();
        $results.innerHTML = `<div class="error">${res.status} ${res.statusText}<br><pre>${escape(body)}</pre></div>`;
        return;
      }
      const data = await res.json();
      const results = data.results ?? [];
      if (results.length === 0) {
        $results.innerHTML = '<div class="empty">no results</div>';
        return;
      }
      $results.innerHTML = results.map(r => {
        const url = r.metadata?.source_url ?? '#';
        const type = r.metadata?.content_type ?? '';
        const snippet = (r.snippet ?? '').slice(0, 300);
        const truncated = (r.snippet ?? '').length > 300 ? '…' : '';
        return `
          <div class="result">
            <h3><a href="${escape(url)}" target="_blank" rel="noopener">${escape(r.title)}</a></h3>
            <div>
              ${type ? `<span class="badge">${escape(type)}</span>` : ''}
              <span class="score">score: ${r.score.toFixed(3)}</span>
            </div>
            <div class="snippet">${escape(snippet)}${truncated}</div>
          </div>
        `;
      }).join('');
    } catch (err) {
      $results.innerHTML = `<div class="error">${escape(err.message)}</div>`;
    }
  }

  function escape(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
</script>
</body>
</html>
```

- [ ] **Step 2: Open the page in a browser to verify it loads**

```bash
open apps/api/dev/search.html
```

(Or the macOS equivalent. The page opens via `file://`.)

Expected: the page loads, shows three config inputs (with `http://localhost:3000` and `phila-services-programs` prefilled), a search box, and an empty results area. Typing in the inputs persists to localStorage (verify by reloading the page).

- [ ] **Step 3: Verify the search call fails gracefully against an empty index**

With dev API running and the index bootstrapped: paste the `srch_*` key from Task 5 into the search-key field, type "anything" into the search box, hit Search.

Expected: either an empty `no results` state or a clean error message in red. No console exceptions, no white screen.

- [ ] **Step 4: Commit**

```bash
git add apps/api/dev/
git commit -m "feat(api): add static test-drive search page for dev"
```

---

## Task 7: TDD `pipelineKeyFor` (URL → content type router)

**Files:**
- Create: `apps/crawler/test/route.test.ts`
- Create: `apps/crawler/src/parse/index.ts` (initial — registry comes in Tasks 8 and 9)

- [ ] **Step 1: Write the failing test**

`apps/crawler/test/route.test.ts`:

```ts
// ABOUTME: Tests for the URL-to-pipeline-key router.
// ABOUTME: Validates that paths under /services/ and /programs/ map to the correct PipelineKey.

import { describe, it, expect } from 'vitest'
import { pipelineKeyFor, PIPELINE } from '../src/parse'

describe('pipelineKeyFor', () => {
  it('routes /services/<...> to PIPELINE.SERVICES', () => {
    expect(pipelineKeyFor('https://www.phila.gov/services/water-gas-utilities/pay-or-dispute-a-water-bill/pay-a-water-bill/'))
      .toBe(PIPELINE.SERVICES)
  })

  it('routes /programs/<...> to PIPELINE.PROGRAMS', () => {
    expect(pipelineKeyFor('https://www.phila.gov/programs/camp-philly/'))
      .toBe(PIPELINE.PROGRAMS)
  })

  it('returns null for the site root', () => {
    expect(pipelineKeyFor('https://www.phila.gov/')).toBeNull()
  })

  it('returns null for unrelated paths', () => {
    expect(pipelineKeyFor('https://www.phila.gov/departments/')).toBeNull()
    expect(pipelineKeyFor('https://www.phila.gov/news/some-article/')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
pnpm --filter @phila/search-crawler test
```

Expected: failure — "Failed to resolve import" or similar, because `apps/crawler/src/parse/index.ts` doesn't exist yet.

- [ ] **Step 3: Implement the minimal `parse/index.ts` to make the test pass**

`apps/crawler/src/parse/index.ts`:

```ts
// ABOUTME: Routes URLs to their content-type pipeline by path prefix.

export const PIPELINE = {
  SERVICES: 'services',
  PROGRAMS: 'programs',
} as const

export type PipelineKey = (typeof PIPELINE)[keyof typeof PIPELINE]

export function pipelineKeyFor(url: string): PipelineKey | null {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    return null
  }
  if (path.startsWith('/services/')) return PIPELINE.SERVICES
  if (path.startsWith('/programs/')) return PIPELINE.PROGRAMS
  return null
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
pnpm --filter @phila/search-crawler test
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/crawler/src/parse/index.ts apps/crawler/test/route.test.ts
git commit -m "feat(crawler): add pipelineKeyFor URL-to-content-type router"
```

---

## Task 8: TDD `parseService` pipeline

**Files:**
- Create: `apps/crawler/test/fixtures/pay-water-bill.html` (copied from parse package fixture)
- Create: `apps/crawler/test/parse-services.test.ts`
- Create: `apps/crawler/src/parse/services.ts`
- Modify: `apps/crawler/src/parse/index.ts` (add `parseService` to a partial pipelines registry)

- [ ] **Step 1: Copy the fixture from the parse package**

```bash
cp packages/parse/test/fixtures/phila-pay-water-bill.html apps/crawler/test/fixtures/pay-water-bill.html
```

If the file doesn't exist at that path, run `find packages/parse/test/fixtures -type f` to locate the actual filename and adjust.

- [ ] **Step 2: Write the failing test**

`apps/crawler/test/parse-services.test.ts`:

```ts
// ABOUTME: End-to-end test of the services parse pipeline against a cached phila.gov fixture.
// ABOUTME: Validates title, metadata, and body content for a real services page.

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { ParsedDocument } from '@phila/search-parse'
import { parseService } from '../src/parse/services'

describe('parseService', () => {
  const html = readFileSync(join(__dirname, 'fixtures/pay-water-bill.html'), 'utf-8')
  let doc: ParsedDocument

  beforeAll(async () => {
    doc = await parseService(html)
  })

  it('extracts the title', () => {
    expect(doc.title).toBe('Pay a water bill')
  })

  it('extracts standard metadata', () => {
    expect(doc.metadata.description).toBe('Instructions and fees for accessing and paying your water and sewer services bill.')
    expect(doc.metadata.canonical_url).toBe('https://www.phila.gov/services/water-gas-utilities/pay-or-dispute-a-water-bill/pay-a-water-bill/')
    expect(doc.metadata.og_site_name).toBe('City of Philadelphia')
  })

  it('extracts content_type from the swiftype meta tag', () => {
    expect(doc.metadata.content_type).toBe('service_page')
  })

  it('produces markdown body with substantive content', () => {
    expect(doc.body.length).toBeGreaterThan(500)
    expect(doc.body.toLowerCase()).toContain('water bill')
  })

  it('strips navigation and footer text', () => {
    expect(doc.body).not.toContain('Skip to main content')
    expect(doc.body).not.toContain('Open government')
  })
})
```

Note: the `content_type` assertion expects whatever string the phila.gov swiftype meta actually publishes for service pages. The existing camp-philly fixture has `content="programs"` for programs. If the services fixture has `content="services"` (plural) instead of `service` (singular), the assertion needs to match the fixture — adjust to whatever the fixture actually contains. **Verify the fixture's exact `content_type` value before running the test.**

```bash
grep 'name="content_type"' apps/crawler/test/fixtures/pay-water-bill.html
```

If it shows `content="services"`, change the assertion to `'services'`. If it shows `content="service"`, leave as written. If the meta tag doesn't exist on the services fixture at all, remove the assertion entirely (programs gets it; services doesn't have to).

- [ ] **Step 3: Run the test and confirm it fails**

```bash
pnpm --filter @phila/search-crawler test parse-services
```

Expected: failure — module `'../src/parse/services'` not found.

- [ ] **Step 4: Implement `parse/services.ts`**

`apps/crawler/src/parse/services.ts`:

```ts
// ABOUTME: Parse pipeline for phila.gov services pages.
// ABOUTME: Targets the page title in .entry-header h2 and body in .entry-content.

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

- [ ] **Step 5: Run the test and confirm it passes**

```bash
pnpm --filter @phila/search-crawler test parse-services
```

Expected: 5 tests pass. If a single assertion fails, fix the pipeline (or, for the `content_type` assertion, fix the assertion to match the fixture). Do not add new pipeline transforms speculatively — fix only what the test demands.

- [ ] **Step 6: Add `parseService` to the pipelines registry in `parse/index.ts`**

Edit `apps/crawler/src/parse/index.ts` to add the import and the registry. The full file becomes:

```ts
// ABOUTME: Pipeline registry and URL-to-pipeline-key router for the crawler.

import type { CheerioAPI } from 'cheerio'
import type { ParsedDocument } from '@phila/search-parse'
import { parseService } from './services'

export type ParseFn = (input: string | CheerioAPI) => Promise<ParsedDocument>

export const PIPELINE = {
  SERVICES: 'services',
  PROGRAMS: 'programs',
} as const

export type PipelineKey = (typeof PIPELINE)[keyof typeof PIPELINE]

export const pipelines: Partial<Record<PipelineKey, ParseFn>> = {
  [PIPELINE.SERVICES]: parseService,
}

export function pipelineKeyFor(url: string): PipelineKey | null {
  const path = new URL(url).pathname
  if (path.startsWith('/services/')) return PIPELINE.SERVICES
  if (path.startsWith('/programs/')) return PIPELINE.PROGRAMS
  return null
}
```

The `Partial` is intentional — `PROGRAMS` isn't wired until Task 9. It becomes a full `Record` at the end of Task 9.

- [ ] **Step 7: Re-run the full crawler test suite**

```bash
pnpm --filter @phila/search-crawler test
```

Expected: 9 tests pass (4 route + 5 services).

- [ ] **Step 8: Commit**

```bash
git add apps/crawler/test/fixtures/pay-water-bill.html apps/crawler/test/parse-services.test.ts apps/crawler/src/parse/services.ts apps/crawler/src/parse/index.ts
git commit -m "feat(crawler): add services parse pipeline"
```

---

## Task 9: TDD `parseProgram` pipeline

**Files:**
- Create: `apps/crawler/test/fixtures/camp-philly.html` (downloaded with a real User-Agent)
- Create: `apps/crawler/test/parse-programs.test.ts`
- Create: `apps/crawler/src/parse/programs.ts`
- Modify: `apps/crawler/src/parse/index.ts` (add `PROGRAMS` to the registry, drop `Partial`)

- [ ] **Step 1: Download the camp-philly fixture with a real User-Agent**

```bash
curl -s -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" \
  https://www.phila.gov/programs/camp-philly/ \
  -o apps/crawler/test/fixtures/camp-philly.html
wc -c apps/crawler/test/fixtures/camp-philly.html
```

Expected: ~50,000 bytes. If under 1KB, it's the CloudFront 403 page — re-run with a real UA. (CloudFront blocks plain `curl`.)

- [ ] **Step 2: Confirm the fixture's actual content_type meta tag value**

```bash
grep 'name="content_type"' apps/crawler/test/fixtures/camp-philly.html
```

Expected: `<meta class="swiftype" name="content_type" data-type="string" content="programs">`. The value (`programs`) is what the test asserts on.

- [ ] **Step 3: Write the failing test**

`apps/crawler/test/parse-programs.test.ts`:

```ts
// ABOUTME: End-to-end test of the programs parse pipeline against a cached phila.gov fixture.
// ABOUTME: Validates title, metadata, and body content for a real programs page.

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { ParsedDocument } from '@phila/search-parse'
import { parseProgram } from '../src/parse/programs'

describe('parseProgram', () => {
  const html = readFileSync(join(__dirname, 'fixtures/camp-philly.html'), 'utf-8')
  let doc: ParsedDocument

  beforeAll(async () => {
    doc = await parseProgram(html)
  })

  it('extracts the title from the hero header', () => {
    expect(doc.title).toBe('Camp Philly')
  })

  it('extracts content_type from the swiftype meta tag', () => {
    expect(doc.metadata.content_type).toBe('programs')
  })

  it('extracts the canonical URL', () => {
    expect(doc.metadata.canonical_url).toBe('https://www.phila.gov/programs/camp-philly/')
  })

  it('produces markdown body with substantive content', () => {
    expect(doc.body.length).toBeGreaterThan(2500)
    // Content known to be on the page from spec validation.
    expect(doc.body.toLowerCase()).toMatch(/sleep[- ]away|camp speers|recreation/)
  })

  it('strips global navigation and footer text', () => {
    expect(doc.body).not.toContain('Skip to main content')
    expect(doc.body).not.toContain('Open government')
  })
})
```

- [ ] **Step 4: Run the test and confirm it fails**

```bash
pnpm --filter @phila/search-crawler test parse-programs
```

Expected: failure — module `'../src/parse/programs'` not found.

- [ ] **Step 5: Implement `parse/programs.ts` (initial cut)**

`apps/crawler/src/parse/programs.ts`:

```ts
// ABOUTME: Parse pipeline for phila.gov programs pages.
// ABOUTME: Targets the post.program template (#post-<id>.program with hero h1 and section body).

import {
  pipeline,
  extractMeta,
  extractTitle,
  selectContent,
  cleanWhitespace,
  toMarkdown,
} from '@phila/search-parse'

export const parseProgram = pipeline(
  extractMeta(),
  extractTitle('.program header h1'),
  selectContent('.program'),
  cleanWhitespace(),
  toMarkdown(),
)
```

The selector for the title (`.program header h1`) and the content wrapper (`.program`) come from the spec validation. They may need refining — that's what the test cycle is for.

- [ ] **Step 6: Run the test and iterate until it passes**

```bash
pnpm --filter @phila/search-crawler test parse-programs
```

If the title test fails: inspect the fixture for the actual h1 location:

```bash
grep -n '<h1' apps/crawler/test/fixtures/camp-philly.html | head
```

If the body test fails (too short, or contains nav text): inspect the actual top-level container:

```bash
grep -n 'class="[^"]*program[^"]*"' apps/crawler/test/fixtures/camp-philly.html | head
grep -n 'id="post-' apps/crawler/test/fixtures/camp-philly.html | head
```

Adjust selectors. Add `remove(...)` calls for nav/footer if `selectContent` alone doesn't isolate the body cleanly. **Do not add transforms speculatively** — only add what the failing test requires.

Expected end state: 5 tests pass.

- [ ] **Step 7: Add `PROGRAMS` to the pipelines registry and drop the `Partial`**

Edit `apps/crawler/src/parse/index.ts`. The full file becomes:

```ts
// ABOUTME: Pipeline registry and URL-to-pipeline-key router for the crawler.

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

- [ ] **Step 8: Re-run the full crawler test suite**

```bash
pnpm --filter @phila/search-crawler test
```

Expected: 14 tests pass (4 route + 5 services + 5 programs).

- [ ] **Step 9: Commit**

```bash
git add apps/crawler/test/fixtures/camp-philly.html apps/crawler/test/parse-programs.test.ts apps/crawler/src/parse/programs.ts apps/crawler/src/parse/index.ts
git commit -m "feat(crawler): add programs parse pipeline"
```

---

## Task 10: Define `Discoverer` interface and the `enqueueDiscoverer` stub

**Files:**
- Create: `apps/crawler/src/discover/types.ts`
- Create: `apps/crawler/src/discover/enqueue.ts`

- [ ] **Step 1: Create the interface file**

`apps/crawler/src/discover/types.ts`:

```ts
// ABOUTME: Discoverer interface — yields URLs to crawl as an async iterable.

export interface Discoverer {
  discover(): AsyncIterable<URL>
}
```

- [ ] **Step 2: Create `apps/crawler/src/discover/enqueue.ts`**

See Task 16 for the implementation.

- [ ] **Step 3: Type-check the crawler package**

```bash
pnpm --filter @phila/search-crawler exec tsc --noEmit
```

Expected: clean exit.

- [ ] **Step 4: Commit**

```bash
git add apps/crawler/src/discover/types.ts apps/crawler/src/discover/enqueue.ts
git commit -m "feat(crawler): add Discoverer interface and enqueue stub"
```

---

## Task 11: TDD `sitemapDiscoverer`

**Files:**
- Create: `apps/crawler/test/fixtures/sitemap-snippet.xml`
- Create: `apps/crawler/test/discover-sitemap.test.ts`
- Create: `apps/crawler/src/discover/sitemap.ts`
- Create: `apps/crawler/src/discover/index.ts`

- [ ] **Step 1: Build the sitemap fixture**

The full phila.gov sitemap is large. We need a representative slice — 5 services leaves, 3 programs leaves, 2 category roots, and a couple of unrelated paths — sufficient to test filtering.

`apps/crawler/test/fixtures/sitemap-snippet.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://www.phila.gov/</loc>
    <lastmod>2026-01-01</lastmod>
  </url>
  <url>
    <loc>https://www.phila.gov/services/</loc>
  </url>
  <url>
    <loc>https://www.phila.gov/services/water-gas-utilities/</loc>
  </url>
  <url>
    <loc>https://www.phila.gov/services/water-gas-utilities/pay-or-dispute-a-water-bill/pay-a-water-bill/</loc>
  </url>
  <url>
    <loc>https://www.phila.gov/services/parking/parking-permits/get-a-residential-parking-permit/</loc>
  </url>
  <url>
    <loc>https://www.phila.gov/services/birth-marriage-life-events/get-a-marriage-license/</loc>
  </url>
  <url>
    <loc>https://www.phila.gov/services/business-self-employment/business-licenses-permits-and-approvals/get-a-business-license/</loc>
  </url>
  <url>
    <loc>https://www.phila.gov/services/permits-violations-licenses/get-a-pet-license/</loc>
  </url>
  <url>
    <loc>https://www.phila.gov/programs/</loc>
  </url>
  <url>
    <loc>https://www.phila.gov/programs/camp-philly/</loc>
  </url>
  <url>
    <loc>https://www.phila.gov/programs/community-life-improvement-program-clip/</loc>
  </url>
  <url>
    <loc>https://www.phila.gov/programs/philly-counts/</loc>
  </url>
  <url>
    <loc>https://www.phila.gov/departments/</loc>
  </url>
  <url>
    <loc>https://www.phila.gov/news/some-press-release/</loc>
  </url>
</urlset>
```

That's 14 entries: 5 services leaves, 3 programs leaves, 2 category roots (`/services/`, `/programs/`), 1 services intermediate index (`/services/water-gas-utilities/`), the site root, departments, and a news page.

- [ ] **Step 2: Write the failing test**

`apps/crawler/test/discover-sitemap.test.ts`:

```ts
// ABOUTME: Tests for the sitemap-based URL discoverer.
// ABOUTME: Validates XML parsing, URL filtering, and the async-iterable contract.

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createSitemapDiscoverer } from '../src/discover/sitemap'

const sitemapXml = readFileSync(join(__dirname, 'fixtures/sitemap-snippet.xml'), 'utf-8')

function fakeFetch(body: string = sitemapXml, status: number = 200): typeof fetch {
  return (async (_url: string) => {
    return new Response(body, { status, headers: { 'content-type': 'application/xml' } })
  }) as unknown as typeof fetch
}

const PHILA_LEAF_FILTER = (url: URL): boolean => {
  const p = url.pathname
  // Services leaves: /services/<category>/<leaf>/ — at least 3 total path segments
  if (p.startsWith('/services/')) {
    const segments = p.split('/').filter(Boolean)
    return segments.length >= 3
  }
  // Programs leaves: /programs/<leaf>/ — exactly 2 total path segments
  if (p.startsWith('/programs/')) {
    const segments = p.split('/').filter(Boolean)
    return segments.length === 2
  }
  return false
}

describe('sitemapDiscoverer', () => {
  let collected: string[] = []

  beforeAll(async () => {
    const discoverer = createSitemapDiscoverer({
      url: 'https://www.phila.gov/sitemap.xml',
      filter: PHILA_LEAF_FILTER,
      fetch: fakeFetch(),
    })
    for await (const url of discoverer.discover()) {
      collected.push(url.toString())
    }
  })

  it('includes leaf service URLs', () => {
    expect(collected).toContain('https://www.phila.gov/services/water-gas-utilities/pay-or-dispute-a-water-bill/pay-a-water-bill/')
    expect(collected).toContain('https://www.phila.gov/services/parking/parking-permits/get-a-residential-parking-permit/')
    expect(collected).toContain('https://www.phila.gov/services/birth-marriage-life-events/get-a-marriage-license/')
  })

  it('includes leaf program URLs', () => {
    expect(collected).toContain('https://www.phila.gov/programs/camp-philly/')
    expect(collected).toContain('https://www.phila.gov/programs/philly-counts/')
  })

  it('excludes the services and programs category roots', () => {
    expect(collected).not.toContain('https://www.phila.gov/services/')
    expect(collected).not.toContain('https://www.phila.gov/programs/')
  })

  it('excludes intermediate services category pages', () => {
    expect(collected).not.toContain('https://www.phila.gov/services/water-gas-utilities/')
  })

  it('excludes unrelated paths (departments, news, root)', () => {
    expect(collected).not.toContain('https://www.phila.gov/')
    expect(collected).not.toContain('https://www.phila.gov/departments/')
    expect(collected).not.toContain('https://www.phila.gov/news/some-press-release/')
  })

  it('yields exactly 5 services leaves + 3 programs leaves', () => {
    expect(collected).toHaveLength(8)
  })

  it('throws on non-200 sitemap response', async () => {
    const discoverer = createSitemapDiscoverer({
      url: 'https://www.phila.gov/sitemap.xml',
      filter: PHILA_LEAF_FILTER,
      fetch: fakeFetch('not found', 404),
    })
    await expect(async () => {
      for await (const _ of discoverer.discover()) { /* consume */ }
    }).rejects.toThrow(/sitemap fetch failed: 404/)
  })
})
```

Note: the test injects a `fetch` implementation so it doesn't hit the network. This is the only piece of test scaffolding the discoverer needs to be testable. The PHILA_LEAF_FILTER lives in the test (and in the CLI in Task 14) — the discoverer itself is generic.

- [ ] **Step 3: Run the test and confirm it fails**

```bash
pnpm --filter @phila/search-crawler test discover-sitemap
```

Expected: failure — module `'../src/discover/sitemap'` not found.

- [ ] **Step 4: Implement `discover/sitemap.ts`**

`apps/crawler/src/discover/sitemap.ts`:

```ts
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
```

Cheerio in `xmlMode` parses sitemap XML correctly. We're already a `cheerio` user via `@phila/search-parse`, so no new dep.

- [ ] **Step 5: Run the test and confirm it passes**

```bash
pnpm --filter @phila/search-crawler test discover-sitemap
```

Expected: 5 tests pass.

- [ ] **Step 6: Create the discover registry**

`apps/crawler/src/discover/index.ts`:

```ts
// ABOUTME: DISCOVER constants, the Discoverer type re-export, and named factory exports.

export const DISCOVER = {
  SITEMAP: 'sitemap',
  ENQUEUE: 'enqueue',
} as const

export type DiscoverKey = (typeof DISCOVER)[keyof typeof DISCOVER]

export type { Discoverer } from './types'
export { createSitemapDiscoverer } from './sitemap'
export type { SitemapDiscovererOptions } from './sitemap'
export { enqueueDiscoverer } from './enqueue'
```

Note: the registry shape is slightly different from the spec sketch. The spec shows `Record<DiscoverKey, Discoverer>` with `sitemapDiscoverer` as a singleton. But the sitemap discoverer needs construction parameters (the URL and filter), so it's a factory not a singleton. The `discoverers` map is therefore not literally constructable — instead, the CLI calls `createSitemapDiscoverer(...)` directly. The `DISCOVER` constants and the named exports here are the real public surface.

This is a small drift from the spec but it's the right shape — singletons can't carry construction params, and exposing both `DISCOVER` and the named factories gives the same single-source-of-truth benefit. Document this in the commit message.

- [ ] **Step 7: Re-run the full crawler test suite**

```bash
pnpm --filter @phila/search-crawler test
```

Expected: 21 tests pass (4 route + 5 services + 5 programs + 7 sitemap).

- [ ] **Step 8: Commit**

```bash
git add apps/crawler/test/fixtures/sitemap-snippet.xml apps/crawler/test/discover-sitemap.test.ts apps/crawler/src/discover/sitemap.ts apps/crawler/src/discover/index.ts
git commit -m "feat(crawler): add sitemap discoverer and discover registry

The sitemap discoverer is a factory because it needs URL + filter
construction params. The discover/index.ts exports DISCOVER constants
plus the named factory rather than the Record<key, instance> shape
sketched in the spec — singletons can't carry construction params."
```

---

## Task 12: Implement the HTTP sink (`postDocument`)

**Files:**
- Create: `apps/crawler/src/sink/http.ts`

(No unit test per the spec — exercised by the manual smoke test in Task 15.)

- [ ] **Step 1: Create `sink/http.ts`**

`apps/crawler/src/sink/http.ts`:

```ts
// ABOUTME: HTTP sink for posting parsed documents to the pgsearch ingest API.
// ABOUTME: Maps ParsedDocument to the ingest payload, stamps source_url and content_type.

import type { ParsedDocument } from '@phila/search-parse'
import type { PipelineKey } from '../parse'

export interface SinkConfig {
  endpoint: string
  indexName: string
  indexKey: string
}

export class SinkError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
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

  const url = `${config.endpoint.replace(/\/$/, '')}/index/${encodeURIComponent(config.indexName)}/documents`

  const res = await fetch(url, {
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
```

- [ ] **Step 2: Type-check**

```bash
pnpm --filter @phila/search-crawler exec tsc --noEmit
```

Expected: clean exit.

- [ ] **Step 3: Commit**

```bash
git add apps/crawler/src/sink/
git commit -m "feat(crawler): add HTTP sink for ingest API"
```

---

## Task 13: Implement the `crawl` orchestrator

**Files:**
- Create: `apps/crawler/src/crawl.ts`

- [ ] **Step 1: Create `crawl.ts`**

`apps/crawler/src/crawl.ts`:

```ts
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
```

- [ ] **Step 2: Type-check**

```bash
pnpm --filter @phila/search-crawler exec tsc --noEmit
```

Expected: clean exit. If `crawler.autoscaledPool?.abort()` doesn't type-check (Crawlee API surface drift), look up the current Crawlee API for "abort early" and substitute. The behavior we want: stop processing requests already in the queue. Alternatives: throw a sentinel error from the request handler, or use `crawler.teardown()`.

- [ ] **Step 3: Commit**

```bash
git add apps/crawler/src/crawl.ts
git commit -m "feat(crawler): add CheerioCrawler orchestrator with run summary"
```

---

## Task 14: Implement the CLI entrypoint and `dev:crawl` script

**Files:**
- Create: `apps/crawler/src/cli.ts`
- Modify: `package.json` (root — add `dev:crawl` script)

- [ ] **Step 1: Create `cli.ts`**

`apps/crawler/src/cli.ts`:

```ts
// ABOUTME: CLI entrypoint for @phila/search-crawler.
// ABOUTME: Parses args, constructs the sitemap discoverer, runs the crawl, prints the summary.

import { parseArgs } from 'node:util'
import { createSitemapDiscoverer } from './discover'
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
  sitemap: string
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
      sitemap:     { type: 'string' },
      concurrency: { type: 'string' },
      limit:       { type: 'string' },
    },
    strict: true,
  })

  const endpoint = values.endpoint
  const index = values.index
  const indexKey = values['index-key'] ?? process.env.INDEX_KEY
  const sitemap = values.sitemap
  const concurrency = values.concurrency ? Number(values.concurrency) : 4
  const limit = values.limit ? Number(values.limit) : undefined

  const missing: string[] = []
  if (!endpoint) missing.push('--endpoint')
  if (!index) missing.push('--index')
  if (!indexKey) missing.push('--index-key (or INDEX_KEY env var)')
  if (!sitemap) missing.push('--sitemap')
  if (missing.length) {
    console.error(`error: missing required argument(s): ${missing.join(', ')}`)
    console.error('')
    console.error('usage: pnpm --filter @phila/search-crawler start -- \\')
    console.error('  --endpoint http://localhost:3000 \\')
    console.error('  --index phila-services-programs \\')
    console.error('  --index-key $INDEX_KEY \\')
    console.error('  --sitemap https://www.phila.gov/sitemap.xml \\')
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
    sitemap: sitemap!,
    concurrency,
    limit,
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2))

  const discoverer = createSitemapDiscoverer({
    url: args.sitemap,
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
```

- [ ] **Step 2: Add the `dev:crawl` script to root `package.json`**

```json
"dev:crawl": "pnpm --filter @phila/search-crawler start -- --endpoint http://localhost:3000 --index phila-services-programs --sitemap https://www.phila.gov/sitemap.xml"
```

The user runs `INDEX_KEY=idx_... pnpm dev:crawl` to provide the key from the env. Additional flags can be passed via `pnpm dev:crawl -- --limit 10`.

- [ ] **Step 3: Type-check the crawler**

```bash
pnpm --filter @phila/search-crawler exec tsc --noEmit
```

Expected: clean exit.

- [ ] **Step 4: Sanity-check the CLI argument parsing locally (no real crawl)**

```bash
pnpm --filter @phila/search-crawler start
```

Expected: prints the "missing required argument(s)" usage message and exits 2. This validates the parser without running a crawl.

- [ ] **Step 5: Commit**

```bash
git add apps/crawler/src/cli.ts package.json
git commit -m "feat(crawler): add CLI entrypoint and dev:crawl workspace script"
```

---

## Task 15: End-to-end manual smoke test

This task is the spec's "manual smoke test" acceptance gate. No code changes — it validates that the assembled system works against the real phila.gov sitemap.

- [ ] **Step 1: Bring up the dev DB**

```bash
pnpm dev:db
```

Expected: Postgres container is running on port 5433.

- [ ] **Step 2: Start the local API in another terminal**

```bash
pnpm dev:api
```

Expected: `pgsearch API listening on http://localhost:3000`. Hit it once to trigger migrations:

```bash
curl -s http://localhost:3000/public/health
```

Expected: 200 with a JSON body.

- [ ] **Step 3: Bootstrap the dev index**

In a third terminal:

```bash
pnpm dev:bootstrap
```

If it reports the index already exists from earlier task validation, run:

```bash
pnpm dev:bootstrap -- --force
```

Capture the printed `index_key` and `search_key`.

- [ ] **Step 4: Set the INDEX_KEY env var**

```bash
export INDEX_KEY=idx_<the value from bootstrap>
```

- [ ] **Step 5: Run a small crawl with --limit 10**

```bash
pnpm dev:crawl -- --limit 10
```

Expected output (approximately):

```
[discover] enqueued 412 URLs
[summary] limit 10 reached; stopping
[summary] Discovered: 412
[summary] Fetched:    11
[summary] Parsed:     10
[summary] Ingested:   10
[summary] Failed:     0
[summary] Duration:   12.3s
```

(The `Discovered` number depends on what's in the live sitemap. The point is: no crashes, parsed/ingested counts close to 10, no failures.)

If failures occur: read the `[parse]` or `[sink]` lines to identify which URLs broke and why. Common failures:
- A page exists in the sitemap that doesn't match either pipeline (route returns null) — should be silent, not a failure. If it's counted as a failure, the orchestrator's defensive check is wrong.
- A parse pipeline throws on a real page that the fixture didn't cover. Inspect the URL, save it as a new fixture, write a failing test, fix the pipeline, repeat.

- [ ] **Step 6: Open the test-drive page and run a few searches**

```bash
open apps/api/dev/search.html
```

Paste the `search_key` from bootstrap into the search-key input. Try:
- `water bill`
- `marriage license`
- `camp`
- `parking permit`

Expected: each query returns at least one result (assuming the corresponding pages were among the 10 ingested — if not, run a larger crawl). Each result shows a title, a `service` or `program` badge, a score, and a snippet.

- [ ] **Step 7: Run a full crawl (no `--limit`)**

```bash
pnpm dev:crawl
```

Expected: completes without errors. Run summary printed at the end. Could take a few minutes depending on the sitemap size.

- [ ] **Step 8: Run the searches again**

Same queries from Step 6. Now you should see richer result sets. Verify content_type badges look right (services queries return `service` results, programs queries return `program` results, mixed queries return both).

- [ ] **Step 9: Document any follow-ups discovered**

If anything was surprising or imperfect, capture it via `bd` per project rules:

```bash
bd create "Title of the issue" -t bug -p 2 --deps discovered-from:<this-plan-or-spec> --json
```

Examples of things worth a follow-up:
- A specific page that parses badly (capture the URL and what's wrong).
- A meaningful chunk of pages getting routed but producing empty bodies (suggests the selector needs refinement).
- Unexpected sitemap entries that need additional filter logic.

- [ ] **Step 10: Final commit (only if any code changed during smoke test)**

If smoke testing surfaced a real bug that needed a code fix, commit it as a bugfix on top of Task 14:

```bash
git add <changed files>
git commit -m "fix(crawler): <what>"
```

If nothing changed, this step is a no-op.

---

## Task 16: Implement `createEnqueueDiscoverer` for recursive URL discovery

**Motivation:** The Task 15 smoke test surfaced that phila.gov's sitemap is incomplete — for the `/services/` URL space, it lists ~60 leaves while recursive crawling finds ~150-200. For example, the `water-gas-utilities` category links to 25 service URLs, only 17 of which appear in the sitemap. The `enqueueDiscoverer` stub from Task 10 was deferred to here.

**Files modified:**
- `apps/crawler/src/discover/enqueue.ts` — replaced stub with `createEnqueueDiscoverer` factory
- `apps/crawler/test/discover-enqueue.test.ts` — 6 TDD tests against injected fake fetch
- `apps/crawler/src/discover/index.ts` — exports `createEnqueueDiscoverer` (stub singleton removed)
- `apps/crawler/src/cli.ts` — added `--discover sitemap|enqueue` flag (default `sitemap`) and repeatable `--seed` flag

**Description:** Replaces the Task 10 stub with a real recursive walker. Yields URLs matching a leaf filter by walking the link graph from caller-supplied seed URLs. Uses Crawlee's `enqueueLinks` in production; accepts an optional `fetch` injection for hermetic unit tests (same pattern as `createSitemapDiscoverer`). The CLI's default mode remains `sitemap`, keeping `pnpm dev:crawl` unchanged.

**Test count:** 22 → 28 tests passing.

- [x] **Step 1:** Write failing test (`apps/crawler/test/discover-enqueue.test.ts`)
- [x] **Step 2:** Implement `createEnqueueDiscoverer` in `apps/crawler/src/discover/enqueue.ts`
- [x] **Step 3:** Update `apps/crawler/src/discover/index.ts` — export factory, remove stub
- [x] **Step 4:** Update `apps/crawler/src/cli.ts` — add `--discover` and `--seed` flags
- [x] **Step 5:** `pnpm --filter @phila/search-crawler exec tsc --noEmit` → clean
- [x] **Step 6:** `pnpm --filter @phila/search-crawler test` → 28 tests passing
- [x] **Step 7:** Commit
- [x] **Step 8 (bugfix):** Queue isolation — both `createEnqueueDiscoverer` and the `crawl` orchestrator now open named `RequestQueue` instances (dropped in `finally`) so they never share Crawlee's default persistent queue. Surfaced by the Task 16 smoke test: discoverer walked 904 URLs, marked them handled in the default queue, then the orchestrator opened the same queue and exited with Fetched: 0.

---

## Acceptance criteria

The plan is complete when:

1. All 19+ unit tests pass: `pnpm --filter @phila/search-crawler test`
2. The full api test suite still passes: `pnpm --filter api test`
3. `pnpm dev:db && pnpm dev:api && pnpm dev:bootstrap && INDEX_KEY=... pnpm dev:crawl` runs end-to-end with `Failed: 0` in the summary
4. The test-drive HTML page returns relevant results for at least 3 distinct queries against the populated index
5. Every task ended with a commit; the branch history reads as a coherent narrative of TDD steps + wiring

## Open files at the end

- `apps/crawler/` — new package, fully populated
- `apps/api/index.ts` — one line changed (`export` added)
- `apps/api/local.ts` — new
- `apps/api/scripts/bootstrap-dev-index.ts` — new
- `apps/api/dev/search.html` — new
- `apps/api/package.json` — `@hono/node-server` added
- `docker/postgres-init.sql` — new
- `docker-compose.test.yml` — `volumes` added to postgres service
- `package.json` (root) — `tsx` devDep + four `dev:*` scripts
