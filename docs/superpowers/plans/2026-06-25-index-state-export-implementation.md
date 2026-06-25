# Index State Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a keyset-paginated, index-key-gated `GET /public/index/:name/documents` endpoint that returns each document's `external_id`, `updated_at`, and `metadata` so consumers can reconcile deletions and detect staleness against their upstream source.

**Architecture:** A focused `services/documents.ts` owns the keyset query and page-termination logic plus a pure `clampLimit` helper; a thin handler in `routes/ingest.ts` parses/clamps query params and delegates. No schema change — the existing `UNIQUE (index_id, external_id)` btree serves the cursor walk, and the read returns columns already on `search_documents`.

**Tech Stack:** Hono on Lambda (`hono/aws-lambda`), `pg`, vitest against a live `pgvector/pg17` container, the repo's tuple-based validator (body only; query params parsed inline as in `routes/search.ts`).

**Design reference:** `docs/superpowers/specs/2026-06-25-index-state-export-design.md`

---

## Context the implementer needs

- **Platform constraint that drove the design:** API Gateway REST v1 buffers responses and hard-caps them at 10MB. Streaming is a no-op here. Pagination is therefore mandatory, not optional. Default page size 1000, max 5000 (≈2MB/page at 2KB/doc, comfortable headroom).
- **Timestamps:** `pg` returns `timestamptz` as a JS `Date`. The codebase normalizes to ISO strings at the service boundary with `.toISOString()` (see `services/indexes.ts` `rowToIndex`). The service does the same so the wire shape is a string.
- **`metadata`:** JSONB comes back from `pg` already parsed into a JS object — no `JSON.parse`. Returned verbatim.
- **Cursor key:** `external_id` is unique and immutable (it's the `ON CONFLICT` target in `services/ingest.ts`), so it's safe as a keyset cursor. Order ascending. Alphabetical order is fine — keyset needs a stable total order, not a monotonic one.
- **Testing convention (follow it):** real-DB tests call **service functions directly** (see `test/prompts.test.ts`), seeding via `createIndex` + direct SQL. HTTP-layer tests use a **minimal Hono app** and assert auth rejection (see `test/routes.test.ts`); the auth middleware short-circuits on a missing header before any DB access, so those tests need no live DB. The route handler is deliberately thin glue — its logic lives in the tested service + helper.
- **Auth is automatic:** `routes/ingest.ts` already registers `ingestRoutes.use('/public/index/:name/*', indexAuth)`, so a new `GET …/documents` handler is gated with no extra wiring. `x-index-key` is already in the CORS `allowHeaders` — no `index.ts` change.

## Prerequisite: test database running

- [ ] **Start the test Postgres** (idempotent; skip if already up)

Run: `pnpm dev:db`
Expected: `docker compose -f docker-compose.test.yml up -d postgres` brings up `pgvector/pgvector:pg17` on `localhost:5433`.

All test commands below run from `apps/api/`.

---

## File Structure

- **Create** `apps/api/services/documents.ts` — `clampLimit` (pure) + `listDocumentState` (keyset page). One responsibility: reading index state for sync.
- **Create** `apps/api/test/documents.test.ts` — service + helper tests against the live DB.
- **Modify** `apps/api/types.ts` — add `DocumentState`, `DocumentStateResponse`.
- **Modify** `apps/api/routes/ingest.ts` — add the `GET /public/index/:name/documents` handler.
- **Modify** `apps/api/test/routes.test.ts` — add the auth-gating wiring test for the new route.

---

## Task 1: `listDocumentState` service + page types

**Files:**
- Modify: `apps/api/types.ts` (append after `IngestResponse`, around line 81)
- Create: `apps/api/services/documents.ts`
- Test: `apps/api/test/documents.test.ts`

- [ ] **Step 1: Add the response types**

In `apps/api/types.ts`, after the `IngestResponse` interface:

```typescript
export interface DocumentState {
  external_id: string
  updated_at: string
  metadata: Record<string, unknown>
}

export interface DocumentStateResponse {
  documents: DocumentState[]
  next_cursor: string | null
}
```

- [ ] **Step 2: Write the failing service test**

Create `apps/api/test/documents.test.ts`:

```typescript
// ABOUTME: Tests for the document state listing service.
// ABOUTME: Verifies keyset pagination, ordering, cursor termination, payload shape, and index isolation.

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { getTestPool, setupSchema, teardownSchema, cleanupTestData, closePool } from './setup'
import { createIndex } from '../services/indexes'
import { listDocumentState, clampLimit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../services/documents'
import type { DocumentState } from '../types'

async function makeIndex(pool: Pool, name: string): Promise<number> {
  await createIndex(pool, { name })
  const row = await pool.query('SELECT index_id FROM search_indexes WHERE name = $1', [name])
  return row.rows[0].index_id
}

async function seedDoc(
  pool: Pool,
  indexId: number,
  externalId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO search_documents (index_id, external_id, title, metadata)
     VALUES ($1, $2, $3, $4)`,
    [indexId, externalId, `Title for ${externalId}`, JSON.stringify(metadata)],
  )
}

// Page through the whole index, returning every visited document in order.
async function walk(pool: Pool, indexId: number, limit: number): Promise<DocumentState[]> {
  const all: DocumentState[] = []
  let after: string | undefined
  for (;;) {
    const page = await listDocumentState(pool, indexId, { limit, after })
    all.push(...page.documents)
    if (page.next_cursor === null) break
    after = page.next_cursor
  }
  return all
}

describe('listDocumentState service', () => {
  let pool: Pool
  let indexId: number

  beforeAll(async () => {
    await setupSchema()
    pool = await getTestPool()
  })
  afterAll(async () => { await teardownSchema(); await closePool() })
  afterEach(async () => { await cleanupTestData() })

  beforeEach(async () => {
    indexId = await makeIndex(pool, 'test-idx')
  })

  it('returns an empty page with null cursor for an empty index', async () => {
    const page = await listDocumentState(pool, indexId, { limit: 10 })
    expect(page.documents).toEqual([])
    expect(page.next_cursor).toBeNull()
  })

  it('returns all docs ascending with null cursor when under the limit', async () => {
    await seedDoc(pool, indexId, 'c')
    await seedDoc(pool, indexId, 'a')
    await seedDoc(pool, indexId, 'b')
    const page = await listDocumentState(pool, indexId, { limit: 10 })
    expect(page.documents.map(d => d.external_id)).toEqual(['a', 'b', 'c'])
    expect(page.next_cursor).toBeNull()
  })

  it('walks multiple pages visiting every doc exactly once in ascending order', async () => {
    for (const id of ['e', 'a', 'd', 'b', 'c']) await seedDoc(pool, indexId, id)
    const visited = await walk(pool, indexId, 2)
    expect(visited.map(d => d.external_id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('terminates with an empty final page when count is an exact multiple of limit', async () => {
    for (const id of ['a', 'b', 'c', 'd']) await seedDoc(pool, indexId, id)
    const p1 = await listDocumentState(pool, indexId, { limit: 2 })
    expect(p1.documents.map(d => d.external_id)).toEqual(['a', 'b'])
    expect(p1.next_cursor).toBe('b')
    const p2 = await listDocumentState(pool, indexId, { limit: 2, after: p1.next_cursor! })
    expect(p2.documents.map(d => d.external_id)).toEqual(['c', 'd'])
    expect(p2.next_cursor).toBe('d')
    const p3 = await listDocumentState(pool, indexId, { limit: 2, after: p2.next_cursor! })
    expect(p3.documents).toEqual([])
    expect(p3.next_cursor).toBeNull()
  })

  it('treats after as an exclusive lower bound', async () => {
    for (const id of ['a', 'b', 'c']) await seedDoc(pool, indexId, id)
    const page = await listDocumentState(pool, indexId, { limit: 10, after: 'a' })
    expect(page.documents.map(d => d.external_id)).toEqual(['b', 'c'])
  })

  it('returns updated_at as an ISO string and metadata verbatim', async () => {
    await seedDoc(pool, indexId, 'doc-1', { etag: '"abc123"', nested: { section: 'services' } })
    const page = await listDocumentState(pool, indexId, { limit: 10 })
    const doc = page.documents[0]
    expect(doc.metadata).toEqual({ etag: '"abc123"', nested: { section: 'services' } })
    expect(typeof doc.updated_at).toBe('string')
    expect(doc.updated_at).toBe(new Date(doc.updated_at).toISOString())
  })

  it('lists only the requested index', async () => {
    const otherId = await makeIndex(pool, 'other-idx')
    await seedDoc(pool, indexId, 'mine')
    await seedDoc(pool, otherId, 'theirs')
    const page = await listDocumentState(pool, indexId, { limit: 10 })
    expect(page.documents.map(d => d.external_id)).toEqual(['mine'])
  })
})

describe('clampLimit', () => {
  it('defaults when the param is absent', () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_PAGE_SIZE)
  })
  it('defaults when the param is not a number', () => {
    expect(clampLimit('abc')).toBe(DEFAULT_PAGE_SIZE)
  })
  it('raises values below 1 to 1', () => {
    expect(clampLimit('0')).toBe(1)
    expect(clampLimit('-5')).toBe(1)
  })
  it('caps values above the max', () => {
    expect(clampLimit('99999')).toBe(MAX_PAGE_SIZE)
  })
  it('passes through an in-range value', () => {
    expect(clampLimit('500')).toBe(500)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run test/documents.test.ts`
Expected: FAIL — `Failed to resolve import "../services/documents"` (module not created yet).

- [ ] **Step 4: Implement the service**

Create `apps/api/services/documents.ts`:

```typescript
// ABOUTME: Document state listing for index sync / reconciliation.
// ABOUTME: Keyset-paginated read of external_id + updated_at + metadata, ordered by external_id.

import type { Pool } from 'pg'
import type { DocumentState, DocumentStateResponse } from '../types'

export const DEFAULT_PAGE_SIZE = 1000
export const MAX_PAGE_SIZE = 5000

// Clamp a raw ?limit query value into [1, MAX_PAGE_SIZE]. Absent or unparseable
// values fall back to DEFAULT_PAGE_SIZE — the endpoint favors a usable default
// over a 400 on a malformed page size.
export function clampLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PAGE_SIZE
  const n = parseInt(raw, 10)
  if (isNaN(n)) return DEFAULT_PAGE_SIZE
  return Math.max(1, Math.min(n, MAX_PAGE_SIZE))
}

// One keyset page of index state ordered by external_id. `after` is an
// exclusive lower bound (the previous page's last external_id). next_cursor is
// the last external_id when the page is full, else null to end the walk.
export async function listDocumentState(
  pool: Pool,
  indexId: number,
  options: { limit: number; after?: string },
): Promise<DocumentStateResponse> {
  const { limit, after } = options
  const result = await pool.query(
    `SELECT external_id, updated_at, metadata
     FROM search_documents
     WHERE index_id = $1 AND ($2::text IS NULL OR external_id > $2)
     ORDER BY external_id ASC
     LIMIT $3`,
    [indexId, after ?? null, limit],
  )

  const documents: DocumentState[] = result.rows.map(row => ({
    external_id: row.external_id,
    updated_at: row.updated_at.toISOString(),
    metadata: row.metadata,
  }))

  const next_cursor = documents.length === limit
    ? documents[documents.length - 1].external_id
    : null

  return { documents, next_cursor }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run test/documents.test.ts`
Expected: PASS — all `listDocumentState` and `clampLimit` cases green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/types.ts apps/api/services/documents.ts apps/api/test/documents.test.ts
git commit -m "feat: add keyset-paginated document state listing service"
```

---

## Task 2: `GET /public/index/:name/documents` route

**Files:**
- Modify: `apps/api/routes/ingest.ts:1-40`
- Test: `apps/api/test/routes.test.ts` (add to the existing `ingest route wiring` describe block)

- [ ] **Step 1: Write the failing route-wiring test**

In `apps/api/test/routes.test.ts`, inside the `describe('ingest route wiring', ...)` block, add:

```typescript
  it('mounts GET /public/index/:name/documents behind indexAuth', async () => {
    const res = await app.request('/public/index/any-index/documents')
    // indexAuth short-circuits on missing x-index-key → 401, proving the route is mounted.
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run test/routes.test.ts -t "GET /public/index/:name/documents"`
Expected: FAIL — no GET handler registered, so Hono returns 404, not 401.

- [ ] **Step 3: Add the route handler**

In `apps/api/routes/ingest.ts`, update the import from `../services/documents` and add the handler after the existing POST route (before the DELETE route is fine; method+path are distinct so order doesn't matter).

Add to imports:

```typescript
import { listDocumentState, clampLimit } from '../services/documents'
```

Add the handler:

```typescript
ingestRoutes.get('/public/index/:name/documents', withIndex(async ({ pool, index }, c) => {
  const limit = clampLimit(c.req.query('limit'))
  const after = c.req.query('after') || undefined
  const result = await listDocumentState(pool, index.index_id, { limit, after })
  return c.json(result, 200)
}))
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run test/routes.test.ts -t "GET /public/index/:name/documents"`
Expected: PASS — 401 with `UNAUTHORIZED`, proving the route is mounted behind `indexAuth`.

- [ ] **Step 5: Run the full api suite to confirm no regressions**

Run: `pnpm test`
Expected: PASS — entire `apps/api` suite green, including `documents.test.ts` and `routes.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/routes/ingest.ts apps/api/test/routes.test.ts
git commit -m "feat: expose GET /public/index/:name/documents for index state export"
```

---

## Done criteria

- `GET /public/index/:name/documents` returns `{ documents: [{ external_id, updated_at, metadata }], next_cursor }`, gated by `x-index-key`.
- A consumer can walk the full index by following `next_cursor` until `null`, visiting every document exactly once in `external_id` order.
- `limit` clamps to `[1, 5000]`, defaulting to `1000`; `after` is an exclusive cursor.
- No schema migration; the existing `UNIQUE (index_id, external_id)` btree serves the walk.
- Full `apps/api` test suite passes.

## Out of scope (per design, do not build)

Streaming/NDJSON, a stored manifest, server-side diffing or bulk delete, push/webhooks, content read, cross-index export, exposing the internal segment hash, a count endpoint, metadata filtering. These are documented in the design's Non-Goals / Open Questions.
