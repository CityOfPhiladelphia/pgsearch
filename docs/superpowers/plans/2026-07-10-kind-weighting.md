# Kind Weighting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Documents carry a freeform `kind` label; per-index `kind_weights` config (with request-level override) multiplies the fused RRF score so content strata can be gently boosted or damped. govsync classifies phila.gov pages by URL path segment.

**Architecture:** Three concerns per the design in bd issue pgsearch-2ft: (1) classification at ingest — a first-class nullable `kind` column on `search_documents`, freeform string; (2) preference — `kind_weights: Record<string, number>` in index config, request override via `kind_weights=` query param; (3) mechanics — fused RRF score multiplied by the kind's weight; missing kind or unlisted kind = 1.0. Engine ships no default weights. `w/(k+r)` scaling ≈ uniform rank shift (0.85 ≈ ~10 ranks at k=60).

**Tech Stack:** TypeScript, Hono, Postgres (pg), vitest. Two repos: `~/pgsearch` (engine) and `~/Projects/govsync` (classifier wiring).

**Design decisions locked:**
- Freeform `kind` only in v1 — declared-vocabulary validation deferred (additive later).
- `kind_weights` replaces wholesale on config update (freeform keys; merge would make removal impossible). `mergeConfig`'s existing `...overrides` spread already does this — only `DEFAULT_CONFIG` changes.
- Weight `0` is legal (near-filter). Negative weights rejected at the route boundary.
- Query param format: `kind_weights=services:1.2,documents:0.8`.
- `kind` is returned on `SearchResult` so callers can facet.
- govsync mapping: first path segment `services|documents|departments|programs` → that kind; root pages slugged `YYYY-MM-DD-…` → `posts`; anything else → no kind.

---

### Task 1: Schema — `kind` column on search_documents

**Files:**
- Modify: `apps/api/db/migrations.ts`
- Test: `apps/api/test/migrations.test.ts`

- [ ] **Step 1: Write the failing test** — in `migrations.test.ts`, following its existing style, assert `search_documents` has a `kind` column of type `text`:

```ts
it('search_documents has a nullable kind column', async () => {
  const result = await pool.query(`
    SELECT data_type, is_nullable FROM information_schema.columns
    WHERE table_name = 'search_documents' AND column_name = 'kind'
  `)
  expect(result.rows).toEqual([{ data_type: 'text', is_nullable: 'YES' }])
})
```

- [ ] **Step 2: Run it** — `cd apps/api && pnpm vitest run test/migrations.test.ts` — expect FAIL (0 rows).
- [ ] **Step 3: Implement** — append migration version 6 to the `migrations` array:

```ts
{
  version: 6,
  description: 'Document kind label for result-type weighting',
  sql: `ALTER TABLE search_documents ADD COLUMN IF NOT EXISTS kind TEXT;`,
},
```

Update the two version-set assertions in `migrations.test.ts` that pin the migration list: 'a fresh database records exactly the baseline version' now expects `[5, 6]`, and 're-running the migration set is a no-op' now expects count 2.

- [ ] **Step 4: Run it** — expect PASS (whole file, including the two updated assertions).
- [ ] **Step 5: Commit** — `feat: add kind column to search_documents (pgsearch-2ft)`

### Task 2: Types + config default

**Files:**
- Modify: `apps/api/types.ts` (IndexConfig, SearchDocument, IngestRequest, SearchResult)
- Modify: `apps/api/config.ts` (DEFAULT_CONFIG)
- Test: `apps/api/test/config.test.ts`

- [ ] **Step 1: Write the failing test** — in `config.test.ts`:

```ts
it('defaults kind_weights to empty (engine has no label opinions)', () => {
  expect(mergeConfig({}).kind_weights).toEqual({})
})

it('replaces kind_weights wholesale on override', () => {
  const base = mergeConfig({ kind_weights: { services: 1.2, documents: 0.8 } })
  expect(mergeConfig({ kind_weights: { posts: 0.9 } }, base).kind_weights).toEqual({ posts: 0.9 })
})
```

- [ ] **Step 2: Run it** — expect FAIL.
- [ ] **Step 3: Implement** —
  - `types.ts`: add `kind_weights: Record<string, number>` to `IndexConfig`; `kind: string | null` to `SearchDocument`; `kind?: string` to `IngestRequest`; `kind: string | null` to `SearchResult`.
  - `config.ts`: add `kind_weights: {}` to `DEFAULT_CONFIG`. Do NOT deep-merge it in `mergeConfig` — wholesale replacement is the contract.
Note: `SearchResult.kind` lands in Task 4 alongside the result mapping — adding it here would break compile with nothing to populate it.

- [ ] **Step 4: Run it** — expect PASS. Also `pnpm tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat: kind_weights index config with empty default (pgsearch-2ft)`

### Task 3: Ingest stores kind

**Files:**
- Modify: `apps/api/services/ingest.ts` (document upsert SQL)
- Modify: `apps/api/routes/ingest.ts` (schema: `'kind?'`)
- Test: `apps/api/test/ingest.test.ts`

- [ ] **Step 1: Write the failing test** — in `ingest.test.ts`:

```ts
it('stores kind on the document and clears it when absent on re-ingest', async () => {
  await ingestDocument(pool, indexId, adapter, {
    external_id: 'kind-doc', title: 'Kind Doc', body: 'Body text for kind test.', kind: 'services',
  }, config)
  let row = await pool.query("SELECT kind FROM search_documents WHERE external_id = 'kind-doc'")
  expect(row.rows[0].kind).toBe('services')

  await ingestDocument(pool, indexId, adapter, {
    external_id: 'kind-doc', title: 'Kind Doc', body: 'Body text for kind test.',
  }, config)
  row = await pool.query("SELECT kind FROM search_documents WHERE external_id = 'kind-doc'")
  expect(row.rows[0].kind).toBeNull()
})
```

(Absent-on-re-ingest clears: ingest is a full-document upsert everywhere else — metadata and title already overwrite — so kind follows the same semantics.)

- [ ] **Step 2: Run it** — expect FAIL (column ignored).
- [ ] **Step 3: Implement** —
  - `services/ingest.ts`: add `kind` to the upsert INSERT columns/VALUES (appended as `$9`; existing params keep their numbers) and `ON CONFLICT ... SET kind = $9`; pass `request.kind ?? null`.
  - `routes/ingest.ts`: add `'kind?': [['typeof', 'string'], ['nonEmpty']]` to `ingestSchema`.
- [ ] **Step 4: Run it** — expect PASS. Run full `test/ingest.test.ts`.
- [ ] **Step 5: Commit** — `feat: ingest accepts and stores document kind (pgsearch-2ft)`

### Task 4: Search applies kind weights

**Files:**
- Modify: `apps/api/services/search.ts`
- Test: `apps/api/test/search-kind-weights.test.ts` (create; model setup on `test/search-dedup.test.ts` — real DB, `createTestAdapter`)

- [ ] **Step 1: Write the failing test** — ingest two docs with near-identical relevance but different kinds (same title/body shape so base RRF ties or near-ties), then:

```ts
it('damps a kind below an undamped competitor', async () => {
  // config kind_weights: { reports: 0.5 } — 'reports' doc ranks below 'services' doc
})
it('missing kind and unlisted kind are neutral (1.0)', async () => { /* no weights → order unchanged */ })
it('request-level kindWeights override config', async () => {
  // config damps services; options.kindWeights = {} restores neutral order
})
it('returns kind on results', async () => { /* result.kind === 'services' */ })
```

Write these as real assertions against `hybridSearch(pool, index, adapter, q, { kindWeights })` output ordering (compare `results.map(r => r.external_id)`).

- [ ] **Step 2: Run it** — expect FAIL.
- [ ] **Step 3: Implement** in `services/search.ts`:
  - Add `kindWeights?: Record<string, number>` to `HybridSearchOptions`.
  - Select `d.kind` in the bm25 query and the vector-only doc-info query; carry `kind: row.kind ?? null` into `ScoredSegment`.
  - Resolve `const kindWeights = options.kindWeights ?? config.kind_weights ?? {}` next to the other config reads.
  - In the `scored` map: `const score = computeRRF({...}) * (s.kind != null ? kindWeights[s.kind] ?? 1 : 1)`.
  - Include `kind: s.kind` in the final `results` mapping (and add `kind` to `SearchResult` here if deferred from Task 2).
- [ ] **Step 4: Run it** — expect PASS. Run the whole api suite: `pnpm vitest run` (search-dedup, search-lexical, e2e untouched — weights default empty).
- [ ] **Step 5: Commit** — `feat: multiply fused score by configured kind weight (pgsearch-2ft)`

### Task 5: Search route override param

**Files:**
- Modify: `apps/api/routes/search.ts`
- Test: `apps/api/test/routes.test.ts` — but model the tests on the authenticated-route pattern in `test/documents.test.ts` (real DB, `createIndex`-issued key). `routes.test.ts`'s DB-less style short-circuits to 401 before validation runs; if adding authenticated tests there is awkward, put them in a new `test/search-route.test.ts` instead.

No 200-path test: the search route calls `getAdapter`, which requires the bedrock provider — no existing test exercises the route to 200 for this reason. Override pass-through is already covered at the service seam by Task 4. Parse and validate `kind_weights` BEFORE the `getAdapter` call so the 400s are reachable in tests.

- [ ] **Step 1: Write the failing test** — validation tests for the search endpoint:

```ts
// kind_weights=services:abc → 400 VALIDATION_ERROR
// kind_weights=services:-1 → 400 VALIDATION_ERROR
// kind_weights=services → 400 VALIDATION_ERROR (no separator)
```

- [ ] **Step 2: Run it** — expect FAIL.
- [ ] **Step 3: Implement** in `routes/search.ts` (before the `getAdapter` call):

```ts
const kindWeightsParam = c.req.query('kind_weights')
let kindWeights: Record<string, number> | undefined
if (kindWeightsParam) {
  kindWeights = {}
  for (const pair of kindWeightsParam.split(',')) {
    const sep = pair.lastIndexOf(':')
    const kind = pair.slice(0, sep).trim()
    const weight = Number(pair.slice(sep + 1))
    if (sep < 1 || !kind || !Number.isFinite(weight) || weight < 0) {
      return apiError(c, 'VALIDATION_ERROR', 'kind_weights must be comma-separated kind:weight pairs with weights >= 0')
    }
    kindWeights[kind] = weight
  }
}
```

Pass `kindWeights` into the `hybridSearch` options.

- [ ] **Step 4: Run it** — expect PASS.
- [ ] **Step 5: Commit** — `feat: kind_weights search param overrides index config (pgsearch-2ft)`

### Task 6: Client package types

**Files:**
- Modify: `packages/client/src/types.ts`

- [ ] **Step 1:** Add `kind_weights?: Record<string, number>` to `IndexConfig`, `kind?: string` to `IngestRequest`, `kind: string | null` to `SearchResult`. Types-only mirror of the API contract; no behavior, no test.
- [ ] **Step 2:** `pnpm tsc --noEmit` in packages/client — expect clean.
- [ ] **Step 3: Commit** — `feat: client types carry document kind and kind_weights (pgsearch-2ft)`

### Task 7: Docs

**Files:**
- Modify: `docs/search.md` (config table + kind weighting section)
- Modify: `docs/ingestion.md` (kind field on ingest body)

- [ ] **Step 1:** Add `kind_weights` row to the config table (default `{}`). Add a "Result-type weighting" section: what kind is, that the engine ships no default weights, the fused-score multiplier mechanics (0.85 ≈ ~10 ranks at k=60), request override + example, and a recommended gentle palette with the phila.gov worked example:

```json
{ "kind_weights": { "services": 1.15, "programs": 1.0, "departments": 0.95, "documents": 0.85, "posts": 0.85 } }
```

- [ ] **Step 2:** Document `kind` in the ingest request body table in `docs/ingestion.md`.
- [ ] **Step 3: Commit** — `docs: kind weighting configuration and palette (pgsearch-2ft)`

### Task 8: govsync classification wiring (repo: ~/Projects/govsync)

**Files:**
- Modify: `apps/sync/dispatch.ts`
- Test: `apps/sync/__tests__/dispatch.test.ts`

Check `git status` in govsync first; if dirty, stop and ask Darren.

- [ ] **Step 1: Write the failing test** — pure-function tests for `kindFromLink`:

```ts
// '/services/water/pay-a-water-bill/' → 'services'
// 'https://www.phila.gov/documents/report-2024/' → 'documents'
// '/departments/water/' → 'departments'; '/programs/tap/' → 'programs'
// '/2025-03-13-mayor-parker-delivers-budget-address/' → 'posts'
// '/city-holidays-and-closures/' → undefined
```

- [ ] **Step 2: Run it** — expect FAIL.
- [ ] **Step 3: Implement** in `dispatch.ts`:

```ts
// phila.gov's IA encodes content strata in the first path segment; news posts
// live at the root with date-slugged paths.
const KIND_SEGMENTS = new Set(['services', 'documents', 'departments', 'programs']);

/** Maps a page link to its pgsearch kind label; unrecognized shapes get none. */
export function kindFromLink(link: string): string | undefined {
  const seg = link.replace(/^https?:\/\/[^/]*/, '').split('/').filter(Boolean)[0] ?? '';
  if (KIND_SEGMENTS.has(seg)) return seg;
  if (/^\d{4}-\d{2}-\d{2}-/.test(seg)) return 'posts';
  return undefined;
}
```

Add `kind: kindFromLink(item.externalId)` to the upsert payload in `upsertDocument` (JSON.stringify drops `undefined`).

- [ ] **Step 4: Run it** — expect PASS. Run govsync's full test suite.
- [ ] **Step 5: Commit** (in govsync) — `feat: classify pages into pgsearch kind from URL path`

### Task 9: Close out

- [ ] Run both repos' full test suites.
- [ ] `bd comment pgsearch-2ft` recording what shipped and the deferred vocabulary validation; `bd close pgsearch-2ft` (or leave open if eval re-run is wanted first — Darren's call at review).
- [ ] Note the recency follow-up: pgsearch-yvq recency decay becomes "applies to kinds […]" per-index config; requires pinning down which "last updated" is authoritative (CMS `last_updated` vs S3 ETag change vs pgsearch `updated_at`).
