# Incremental BM25 Statistic Maintenance — Core Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Maintain BM25 corpus statistics (per-term document frequency and average field lengths) incrementally and transactionally on ingest/delete, replacing the inline materialized-view refresh, with an in-DB SQL reconcile function as the drift backstop.

**Architecture:** `term_document_frequencies` becomes a regular table maintained by per-document deltas inside the existing ingest/delete transaction (TypeScript hot path). A SQL function `reconcile_index_stats(index_id)` recomputes everything from source (cold path) and is the source of truth the incremental path is validated against. Average lengths are kept as running sums on `search_indexes`.

**Tech Stack:** TypeScript, node-postgres (`pg`), Vitest against a dockerized Postgres 15 (`pnpm dev:db`), versioned append-only SQL migrations.

**Scope:** This plan is the database + application code. The pg_cron parameter-group/reboot infra, the cron schedule, deployment, and the one-time `phila-gov` reconcile are a **separate plan** (Plan B), which depends on this one being merged. The reconcile function built here is invocable manually (`SELECT reconcile_index_stats($1)`), so this plan is independently testable.

**Spec:** `docs/superpowers/specs/2026-06-30-incremental-bm25-stats-design.md`

**Branch:** Create `feat/incremental-bm25-stats` off `main` before starting.

---

## File Structure

- `apps/api/db/migrations.ts` — **modify**: append migration version 3 (matview→table, sum columns + backfill, `reconcile_index_stats` function).
- `apps/api/services/stats.ts` — **create**: hot-path maintenance helpers (term-set read, DF delta, length-sum delta, the combined per-document maintenance call).
- `apps/api/services/reconcile.ts` — **create**: thin `reconcileIndex(pool, indexId)` wrapper over `SELECT reconcile_index_stats($1)`.
- `apps/api/services/ingest.ts` — **modify**: wire maintenance into `ingestDocument`; make `deleteDocument` transactional + maintained; remove `checkAndRefresh`; add deadlock retry.
- `apps/api/services/refresh.ts` — **delete**.
- `apps/api/routes/admin.ts` — **modify**: replace `/refresh` route with `/reconcile`.
- `apps/api/config.ts`, `apps/api/types.ts` — **modify**: remove `refresh_threshold`.
- `apps/api/test/setup.ts` — **modify**: `teardownSchema` must drop the table form of `term_document_frequencies`.
- `apps/api/test/stats.test.ts` — **create**: per-operation maintenance tests + the reconcile-equivalence invariant.
- `apps/api/test/refresh.test.ts` — **delete** (replaced by stats.test.ts + reconcile coverage).
- `apps/api/test/config.test.ts` — **modify**: drop the `refresh_threshold` default assertion.
- `apps/api/test/ingest.test.ts` — **modify**: **delete** the "auto-refreshes when ingest crosses the refresh threshold" case (lines ~107-120) — it asserts a `last_refreshed_at` side effect that no longer happens; and drop any `refresh_threshold` from config objects.
- `apps/api/test/search.test.ts`, `apps/api/test/rag.test.ts` — **modify**: remove the `import { refreshIndex } from '../services/refresh'` and the `await refreshIndex(...)` calls (pure setup so BM25 has IDF data — now maintained incrementally on ingest, so the explicit refresh is redundant and the assertions still hold).
- `apps/api/test/e2e-hybrid-search.test.ts` — **modify**: same import/call removal **and additionally delete the entire `it('refreshes materialized views and index stats')` case (~lines 152-168)** — it asserts `docs_changed_since_refresh === 0` and `last_refreshed_at` non-null, side effects only `refreshIndex` produced. Same class as the `ingest.test.ts` deletion.
- `apps/api/test/adapter.test.ts` — **modify**: remove `refresh_threshold: 100` from its config object.
- `apps/api/test/admin.test.ts` — **create**: a route test for `POST /private/key/admin/indexes/:name/reconcile` (no admin route test exists today).
- `apps/api/scripts/ingest-311-kb.ts:251` — **modify**: update the `/refresh` HTTP call to `/reconcile` (operational tooling that 404s after the route rename).

Prerequisite for all test steps: `pnpm dev:db` (dockerized Postgres on :5433) is running. Run tests with `pnpm --filter api test -- <file>`.

---

## Task 1: Migration v3 — convert matview to table, add sum columns, backfill

**Files:**
- Modify: `apps/api/db/migrations.ts` (append to the `migrations` array, after version 2)
- Modify: `apps/api/test/setup.ts:teardownSchema`
- Test: `apps/api/test/migration-v3.test.ts` (create)

- [ ] **Step 1: Update teardownSchema to drop the table form**

In `apps/api/test/setup.ts`, change the matview drop to cover both forms so re-runs are clean. **Order matters:** after v3 the relation is a table, and `DROP MATERIALIZED VIEW IF EXISTS` against a table *raises* `"... is not a materialized view"` (`IF EXISTS` does not suppress a wrong-relkind error). So drop the table form **first**; the matview line is then a harmless no-op:

```ts
await p.query('DROP TABLE IF EXISTS term_document_frequencies CASCADE')
await p.query('DROP MATERIALIZED VIEW IF EXISTS term_document_frequencies CASCADE')
```

- [ ] **Step 2: Write the failing migration test**

Create `apps/api/test/migration-v3.test.ts`:

```ts
// ABOUTME: Verifies migration v3 converts the term-frequency matview to a table
// ABOUTME: and adds the running-sum columns used for incremental average maintenance.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, closePool } from './setup'
import type { Pool } from 'pg'

describe('migration v3', () => {
  let pool: Pool
  beforeAll(async () => { await setupSchema(); pool = await getTestPool() })
  afterAll(async () => { await teardownSchema(); await closePool() })

  it('term_document_frequencies is a base table, not a matview', async () => {
    const r = await pool.query(
      "SELECT relkind FROM pg_class WHERE relname = 'term_document_frequencies'"
    )
    expect(r.rows[0].relkind).toBe('r') // 'r' = ordinary table ('m' = matview)
  })

  it('term_document_frequencies has a primary key on (index_id, term)', async () => {
    const r = await pool.query(`
      SELECT a.attname FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'term_document_frequencies'::regclass AND i.indisprimary
      ORDER BY a.attname`)
    expect(r.rows.map(x => x.attname)).toEqual(['index_id', 'term'])
  })

  it('search_indexes has the running-sum columns', async () => {
    const r = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'search_indexes'
        AND column_name IN ('total_title_length','total_body_length','total_segments')`)
    expect(r.rows.map(x => x.column_name).sort()).toEqual(
      ['total_body_length', 'total_segments', 'total_title_length'])
  })
})
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm --filter api test -- test/migration-v3.test.ts`
Expected: FAIL (`relkind` is `'m'`; columns missing).

- [ ] **Step 4: Append migration version 3**

In `apps/api/db/migrations.ts`, add after the version 2 object:

```ts
  {
    version: 3,
    description: 'Incremental BM25 stats: matview -> table, running-sum columns, reconcile function',
    sql: `
-- Convert the term-frequency materialized view to a maintained table.
CREATE TABLE term_document_frequencies_tbl (
  index_id           INTEGER NOT NULL REFERENCES search_indexes(index_id) ON DELETE CASCADE,
  term               TEXT NOT NULL,
  document_frequency INTEGER NOT NULL,
  PRIMARY KEY (index_id, term)
);
INSERT INTO term_document_frequencies_tbl (index_id, term, document_frequency)
  SELECT index_id, term, document_frequency FROM term_document_frequencies;
DROP MATERIALIZED VIEW term_document_frequencies;
ALTER TABLE term_document_frequencies_tbl RENAME TO term_document_frequencies;

-- Running sums so averages are maintained, not recomputed.
ALTER TABLE search_indexes
  ADD COLUMN total_title_length BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN total_body_length  BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN total_segments     BIGINT NOT NULL DEFAULT 0;

UPDATE search_indexes si SET
  total_title_length = COALESCE((SELECT SUM(title_length)  FROM search_documents d WHERE d.index_id = si.index_id), 0),
  total_segments     = COALESCE((SELECT SUM(segment_count) FROM search_documents d WHERE d.index_id = si.index_id), 0),
  total_body_length  = COALESCE((SELECT SUM(body_length)   FROM search_segments  s WHERE s.index_id = si.index_id), 0);

UPDATE search_indexes SET
  avg_title_length = COALESCE(total_title_length::float / NULLIF(total_documents, 0), 0),
  avg_body_length  = COALESCE(total_body_length::float  / NULLIF(total_segments, 0), 0);

-- Cold-path reconcile: recompute DF + sums + averages from source for one index.
CREATE OR REPLACE FUNCTION reconcile_index_stats(p_index_id INTEGER)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  DELETE FROM term_document_frequencies WHERE index_id = p_index_id;
  INSERT INTO term_document_frequencies (index_id, term, document_frequency)
  SELECT p_index_id, sub.term, COUNT(DISTINCT sub.document_id)::int
  FROM (
    SELECT d.document_id, unnest(tsvector_to_array(s.body_tsvector)) AS term
    FROM search_documents d JOIN search_segments s ON s.document_id = d.document_id
    WHERE d.index_id = p_index_id AND s.body_tsvector IS NOT NULL
    UNION
    SELECT d.document_id, unnest(tsvector_to_array(d.title_tsvector))
    FROM search_documents d
    WHERE d.index_id = p_index_id AND d.title_tsvector IS NOT NULL
  ) sub
  GROUP BY sub.term;

  UPDATE search_indexes si SET
    total_title_length = COALESCE((SELECT SUM(title_length)  FROM search_documents d WHERE d.index_id = p_index_id), 0),
    total_segments     = COALESCE((SELECT SUM(segment_count) FROM search_documents d WHERE d.index_id = p_index_id), 0),
    total_body_length  = COALESCE((SELECT SUM(body_length)   FROM search_segments  s WHERE s.index_id = p_index_id), 0)
  WHERE si.index_id = p_index_id;

  UPDATE search_indexes SET
    avg_title_length = COALESCE(total_title_length::float / NULLIF(total_documents, 0), 0),
    avg_body_length  = COALESCE(total_body_length::float  / NULLIF(total_segments, 0), 0)
  WHERE index_id = p_index_id;
END;
$fn$;
`,
  },
```

> Note for fresh databases: version 1 creates the (empty) matview, then version 3 converts it to an empty table and backfills zeros. For the existing DB, version 3 converts the populated matview. Same end state. Do **not** edit version 1. Do **not** drop `docs_changed_since_refresh` here (see spec Deploy ordering).

- [ ] **Step 5: Run the migration test to verify it passes**

Run: `pnpm --filter api test -- test/migration-v3.test.ts`
Expected: PASS (all three).

- [ ] **Step 6: Commit**

```bash
git add apps/api/db/migrations.ts apps/api/test/setup.ts apps/api/test/migration-v3.test.ts
git commit -m "feat(stats): migration v3 — term_document_frequencies table + sum columns + reconcile fn"
```

---

## Task 2: Reconcile service wrapper + reconcile-correctness test

**Files:**
- Create: `apps/api/services/reconcile.ts`
- Test: `apps/api/test/reconcile.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/reconcile.test.ts`:

```ts
// ABOUTME: Verifies reconcile_index_stats recomputes DF + averages from source.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, closePool, cleanupTestData } from './setup'
import { createIndex } from '../services/indexes'
import { ingestDocument } from '../services/ingest'
import { reconcileIndex } from '../services/reconcile'
import { createTestAdapter } from '@phila/search-embeddings'
import { mergeConfig } from '../config'
import type { Pool } from 'pg'

describe('reconcileIndex', () => {
  let pool: Pool
  let indexId: number
  const adapter = createTestAdapter(384)
  const config = mergeConfig({})
  beforeAll(async () => {
    await setupSchema(); pool = await getTestPool()
    await createIndex(pool, { name: 'recon' })
    indexId = (await pool.query("SELECT index_id FROM search_indexes WHERE name='recon'")).rows[0].index_id
    await ingestDocument(pool, indexId, adapter,
      { external_id: 'd1', title: 'Parking Permits', body: 'Apply for a residential parking permit today.' }, config)
  })
  afterAll(async () => { await teardownSchema(); await closePool() })

  it('rebuilds DF and averages from source', async () => {
    // Corrupt the maintained state, then reconcile should restore it.
    await pool.query('DELETE FROM term_document_frequencies WHERE index_id = $1', [indexId])
    await pool.query('UPDATE search_indexes SET avg_title_length = 0, avg_body_length = 0 WHERE index_id = $1', [indexId])

    await reconcileIndex(pool, indexId)

    const tdf = await pool.query('SELECT COUNT(*)::int AS n FROM term_document_frequencies WHERE index_id = $1', [indexId])
    expect(tdf.rows[0].n).toBeGreaterThan(0)
    const idx = await pool.query('SELECT avg_title_length, avg_body_length FROM search_indexes WHERE index_id = $1', [indexId])
    expect(Number(idx.rows[0].avg_title_length)).toBeGreaterThan(0)
    expect(Number(idx.rows[0].avg_body_length)).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `pnpm --filter api test -- test/reconcile.test.ts`
Expected: FAIL (`reconcileIndex` not found).

- [ ] **Step 3: Implement the wrapper**

Create `apps/api/services/reconcile.ts`:

```ts
// ABOUTME: Thin wrapper over the in-database reconcile_index_stats function.
// ABOUTME: Recomputes DF + average lengths from source for one index (drift backstop).
import type { Pool } from 'pg'

export async function reconcileIndex(pool: Pool, indexId: number): Promise<void> {
  await pool.query('SELECT reconcile_index_stats($1)', [indexId])
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter api test -- test/reconcile.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/services/reconcile.ts apps/api/test/reconcile.test.ts
git commit -m "feat(stats): reconcileIndex service over reconcile_index_stats"
```

---

## Task 3: Hot-path maintenance module (`stats.ts`)

This module holds the per-document maintenance, operating on a transaction client. It is the unit that ingest/delete call.

**Files:**
- Create: `apps/api/services/stats.ts`
- Test: `apps/api/test/stats.test.ts` (create)

Interface:

```ts
import type { PoolClient } from 'pg'

/** Distinct lexemes in a document's title_tsvector ∪ its segments' body_tsvector. */
export async function documentTermSet(client: PoolClient, documentId: string): Promise<string[]>

/** Document length stats captured before/after a write: title tokens, Σ segment body tokens, segment count. */
export interface DocStats { titleLength: number; bodyLength: number; segments: number }
export async function documentStats(client: PoolClient, documentId: string): Promise<DocStats>

/** Apply a document's term-set change and length deltas to the index, inside the caller's txn. */
export async function applyMaintenance(client: PoolClient, args: {
  indexId: number
  oldTerms: string[]
  newTerms: string[]
  deltaTitle: number
  deltaBody: number
  deltaSegments: number
}): Promise<void>
```

- [ ] **Step 1: Write failing tests**

Create `apps/api/test/stats.test.ts`:

```ts
// ABOUTME: Unit tests for hot-path stat maintenance helpers (term set, stats, deltas).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, closePool, cleanupTestData } from './setup'
import { createIndex } from '../services/indexes'
import { ingestDocument } from '../services/ingest'
import { documentTermSet, applyMaintenance } from '../services/stats'
import { createTestAdapter } from '@phila/search-embeddings'
import { mergeConfig } from '../config'
import type { Pool } from 'pg'

describe('stats helpers', () => {
  let pool: Pool
  let indexId: number
  const adapter = createTestAdapter(384)
  const config = mergeConfig({})
  beforeAll(async () => {
    await setupSchema(); pool = await getTestPool()
    await createIndex(pool, { name: 'stats' })
    indexId = (await pool.query("SELECT index_id FROM search_indexes WHERE name='stats'")).rows[0].index_id
  })
  afterAll(async () => { await teardownSchema(); await closePool() })

  it('documentTermSet returns distinct title+body lexemes', async () => {
    await ingestDocument(pool, indexId, adapter,
      { external_id: 't1', title: 'Parking Permits', body: 'Apply for a parking permit.' }, config)
    const docId = (await pool.query("SELECT document_id FROM search_documents WHERE external_id='t1'")).rows[0].document_id
    const client = await pool.connect()
    try {
      const terms = await documentTermSet(client, docId)
      expect(terms).toContain('park')   // 'parking' -> 'park' under english stemming
      expect(terms).toContain('permit')
      expect(new Set(terms).size).toBe(terms.length) // distinct
    } finally { client.release() }
  })

  it('applyMaintenance adds and removes DF and updates averages', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await applyMaintenance(client, {
        indexId, oldTerms: [], newTerms: ['alpha', 'beta'],
        deltaTitle: 2, deltaBody: 4, deltaSegments: 1,
      })
      await client.query('COMMIT')
    } finally { client.release() }
    const df = await pool.query(
      "SELECT term, document_frequency FROM term_document_frequencies WHERE index_id=$1 AND term=ANY($2) ORDER BY term",
      [indexId, ['alpha', 'beta']])
    expect(df.rows).toEqual([
      { term: 'alpha', document_frequency: 1 },
      { term: 'beta', document_frequency: 1 },
    ])

    // Remove 'beta' -> its row drops to 0 and is deleted.
    const client2 = await pool.connect()
    try {
      await client2.query('BEGIN')
      await applyMaintenance(client2, {
        indexId, oldTerms: ['beta'], newTerms: [],
        deltaTitle: 0, deltaBody: 0, deltaSegments: 0,
      })
      await client2.query('COMMIT')
    } finally { client2.release() }
    const after = await pool.query(
      "SELECT term FROM term_document_frequencies WHERE index_id=$1 AND term='beta'", [indexId])
    expect(after.rows).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run to confirm it fails**

Run: `pnpm --filter api test -- test/stats.test.ts`
Expected: FAIL (`documentTermSet`/`applyMaintenance` not found).

- [ ] **Step 3: Implement `stats.ts`**

Create `apps/api/services/stats.ts`:

```ts
// ABOUTME: Hot-path BM25 stat maintenance: per-document term-set + length deltas.
// ABOUTME: Applies DF and average-length changes inside the caller's ingest/delete transaction.
import type { PoolClient } from 'pg'

export interface DocStats { titleLength: number; bodyLength: number; segments: number }

export async function documentTermSet(client: PoolClient, documentId: string): Promise<string[]> {
  const r = await client.query(
    `SELECT array_agg(DISTINCT term) AS terms FROM (
       SELECT unnest(tsvector_to_array(body_tsvector)) AS term
       FROM search_segments WHERE document_id = $1 AND body_tsvector IS NOT NULL
       UNION
       SELECT unnest(tsvector_to_array(title_tsvector))
       FROM search_documents WHERE document_id = $1 AND title_tsvector IS NOT NULL
     ) t`,
    [documentId],
  )
  return r.rows[0].terms ?? []
}

export async function documentStats(client: PoolClient, documentId: string): Promise<DocStats> {
  const r = await client.query(
    `SELECT
       COALESCE(d.title_length, 0)                         AS title_length,
       COALESCE(SUM(s.body_length), 0)                     AS body_length,
       COALESCE(d.segment_count, 0)                        AS segments
     FROM search_documents d
     LEFT JOIN search_segments s ON s.document_id = d.document_id
     WHERE d.document_id = $1
     GROUP BY d.title_length, d.segment_count`,
    [documentId],
  )
  if (r.rows.length === 0) return { titleLength: 0, bodyLength: 0, segments: 0 }
  return {
    titleLength: Number(r.rows[0].title_length),
    bodyLength: Number(r.rows[0].body_length),
    segments: Number(r.rows[0].segments),
  }
}

export async function applyMaintenance(client: PoolClient, args: {
  indexId: number
  oldTerms: string[]
  newTerms: string[]
  deltaTitle: number
  deltaBody: number
  deltaSegments: number
}): Promise<void> {
  const { indexId, oldTerms, newTerms } = args
  const oldSet = new Set(oldTerms)
  const newSet = new Set(newTerms)
  // Sort for a consistent lock order across concurrent transactions (deadlock guard).
  const added = newTerms.filter(t => !oldSet.has(t)).sort()
  const removed = oldTerms.filter(t => !newSet.has(t)).sort()

  if (added.length > 0) {
    await client.query(
      `INSERT INTO term_document_frequencies (index_id, term, document_frequency)
       SELECT $1, t, 1 FROM unnest($2::text[]) t
       ON CONFLICT (index_id, term)
       DO UPDATE SET document_frequency = term_document_frequencies.document_frequency + 1`,
      [indexId, added],
    )
  }
  if (removed.length > 0) {
    await client.query(
      `UPDATE term_document_frequencies SET document_frequency = document_frequency - 1
       WHERE index_id = $1 AND term = ANY($2::text[])`,
      [indexId, removed],
    )
    await client.query(
      `DELETE FROM term_document_frequencies WHERE index_id = $1 AND document_frequency <= 0`,
      [indexId],
    )
  }

  // Length sums first, then recompute averages from current column values
  // (total_documents is maintained by the caller's existing insert logic).
  await client.query(
    `UPDATE search_indexes SET
       total_title_length = total_title_length + $2,
       total_body_length  = total_body_length  + $3,
       total_segments     = total_segments     + $4
     WHERE index_id = $1`,
    [indexId, args.deltaTitle, args.deltaBody, args.deltaSegments],
  )
  await client.query(
    `UPDATE search_indexes SET
       avg_title_length = COALESCE(total_title_length::float / NULLIF(total_documents, 0), 0),
       avg_body_length  = COALESCE(total_body_length::float  / NULLIF(total_segments, 0), 0)
     WHERE index_id = $1`,
    [indexId],
  )
}

// Note: averages are wrapped in COALESCE(..., 0) because avg_title_length /
// avg_body_length are FLOAT NOT NULL. Without it, an empty index, a delete of
// the last document, or a doc with zero body segments would assign NULL and
// violate the not-null constraint. This matches the old refreshIndex's
// COALESCE(AVG(...), 0) behavior.
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter api test -- test/stats.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/services/stats.ts apps/api/test/stats.test.ts
git commit -m "feat(stats): hot-path maintenance helpers (term set, DF + length deltas)"
```

---

## Task 4: Wire maintenance into `ingestDocument`; remove `checkAndRefresh`

**Files:**
- Modify: `apps/api/services/ingest.ts` (`ingestDocument`, lines ~21-189)
- Test: `apps/api/test/ingest-stats.test.ts` (create)

- [ ] **Step 1: Write failing integration tests**

Create `apps/api/test/ingest-stats.test.ts`:

```ts
// ABOUTME: Verifies ingestDocument maintains DF and averages incrementally (no refresh).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, closePool, cleanupTestData } from './setup'
import { createIndex } from '../services/indexes'
import { ingestDocument, deleteDocument } from '../services/ingest'
import { createTestAdapter } from '@phila/search-embeddings'
import { mergeConfig } from '../config'
import type { Pool } from 'pg'

const adapter = createTestAdapter(384)
const config = mergeConfig({})

async function df(pool: Pool, indexId: number, term: string): Promise<number> {
  const r = await pool.query(
    'SELECT document_frequency FROM term_document_frequencies WHERE index_id=$1 AND term=$2', [indexId, term])
  return r.rows.length ? r.rows[0].document_frequency : 0
}

describe('ingest maintains stats incrementally', () => {
  let pool: Pool
  let indexId: number
  beforeAll(async () => { await setupSchema(); pool = await getTestPool() })
  afterAll(async () => { await teardownSchema(); await closePool() })
  beforeEach(async () => {
    await cleanupTestData()
    await createIndex(pool, { name: 'inc' })
    indexId = (await pool.query("SELECT index_id FROM search_indexes WHERE name='inc'")).rows[0].index_id
  })

  it('new doc populates DF and averages without any refresh call', async () => {
    await ingestDocument(pool, indexId, adapter,
      { external_id: 'a', title: 'Parking Permits', body: 'Apply for a parking permit.' }, config)
    expect(await df(pool, indexId, 'park')).toBe(1)
    const idx = await pool.query('SELECT avg_title_length, avg_body_length, total_documents FROM search_indexes WHERE index_id=$1', [indexId])
    expect(Number(idx.rows[0].avg_title_length)).toBeGreaterThan(0)
    expect(Number(idx.rows[0].avg_body_length)).toBeGreaterThan(0)
    expect(idx.rows[0].total_documents).toBe(1)
  })

  it('a term shared by two docs has DF 2', async () => {
    await ingestDocument(pool, indexId, adapter, { external_id: 'a', title: 'Parking', body: 'parking permit' }, config)
    await ingestDocument(pool, indexId, adapter, { external_id: 'b', title: 'Parking', body: 'parking garage' }, config)
    expect(await df(pool, indexId, 'park')).toBe(2)
  })

  it('re-ingesting with a removed term decrements its DF', async () => {
    await ingestDocument(pool, indexId, adapter, { external_id: 'a', title: 'X', body: 'parking garage downtown' }, config)
    expect(await df(pool, indexId, 'garag')).toBe(1)
    await ingestDocument(pool, indexId, adapter, { external_id: 'a', title: 'X', body: 'parking downtown' }, config)
    expect(await df(pool, indexId, 'garag')).toBe(0)
    expect(await df(pool, indexId, 'park')).toBe(1)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter api test -- test/ingest-stats.test.ts`
Expected: FAIL (DF empty / averages 0 — current code only writes DF on refresh).

- [ ] **Step 3: Modify `ingestDocument`**

In `apps/api/services/ingest.ts`:

1. Add imports near the top:
```ts
import { documentTermSet, documentStats, applyMaintenance } from './stats'
```
2. Remove the `checkAndRefresh` import and its call at the end of the function (the block after the transaction). Delete the `import { checkAndRefresh } from './refresh'` line and the `await checkAndRefresh(...)` line.
3. Replace the existing-document lookup so it also captures the old title (for the unchanged-skip) and we can compute old maintenance state. The current lookup (`SELECT document_id ...`) becomes:
```ts
  const existingDoc = await pool.query(
    'SELECT document_id, title FROM search_documents WHERE index_id = $1 AND external_id = $2',
    [indexId, request.external_id],
  )
  const existingDocumentId: string | undefined = existingDoc.rows[0]?.document_id
  const oldTitle: string | undefined = existingDoc.rows[0]?.title
```
   (Keep the existing `content_hash` diff logic that follows, using `existingDocumentId`.)
4. **Inside the transaction, before** the document upsert, capture old maintenance state when the doc exists:
```ts
    let oldTerms: string[] = []
    let oldStats = { titleLength: 0, bodyLength: 0, segments: 0 }
    if (existingDocumentId) {
      oldTerms = await documentTermSet(client, existingDocumentId)
      oldStats = await documentStats(client, existingDocumentId)
    }
```
5. Keep the existing upsert/segment writes. The existing `isInsert` counter and `docs_changed_since_refresh` UPDATE stay as-is (we are not dropping that column in this migration). Leave them.
6. **After** the segment writes and counter updates, **before COMMIT**, apply maintenance — but skip when nothing changed:
```ts
    const titleUnchanged = existingDocumentId !== undefined && oldTitle === request.title
    const segmentsUnchanged = changed.size === 0 && removedHashes.length === 0
    if (!(titleUnchanged && segmentsUnchanged)) {
      const newTerms = await documentTermSet(client, documentId)
      const newStats = await documentStats(client, documentId)
      await applyMaintenance(client, {
        indexId,
        oldTerms,
        newTerms,
        deltaTitle: newStats.titleLength - oldStats.titleLength,
        deltaBody: newStats.bodyLength - oldStats.bodyLength,
        deltaSegments: newStats.segments - oldStats.segments,
      })
    }
```
7. Leave the `try/catch/finally` and `COMMIT`/`ROLLBACK` as they are.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter api test -- test/ingest-stats.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/services/ingest.ts apps/api/test/ingest-stats.test.ts
git commit -m "feat(stats): maintain DF + averages in ingestDocument; drop inline refresh"
```

---

## Task 5: Make `deleteDocument` transactional + maintained

**Files:**
- Modify: `apps/api/services/ingest.ts` (`deleteDocument`, lines ~191-207)
- Test: extend `apps/api/test/ingest-stats.test.ts`

- [ ] **Step 1: Add a failing delete test** (append to `ingest-stats.test.ts`):

```ts
  it('delete decrements DF, removes zeroed terms, and subtracts lengths', async () => {
    await ingestDocument(pool, indexId, adapter, { external_id: 'a', title: 'Parking', body: 'parking permit garage' }, config)
    await ingestDocument(pool, indexId, adapter, { external_id: 'b', title: 'Parking', body: 'parking permit' }, config)
    await deleteDocument(pool, indexId, 'a')
    expect(await df(pool, indexId, 'park')).toBe(1)    // still in b
    expect(await df(pool, indexId, 'garag')).toBe(0)   // only in a -> removed
    const idx = await pool.query('SELECT total_documents FROM search_indexes WHERE index_id=$1', [indexId])
    expect(idx.rows[0].total_documents).toBe(1)
  })
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm --filter api test -- test/ingest-stats.test.ts`
Expected: FAIL (`garag` DF still 1; current delete doesn't touch DF).

- [ ] **Step 3: Rewrite `deleteDocument`** transactionally:

```ts
export async function deleteDocument(
  pool: Pool,
  indexId: number,
  externalId: string,
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const found = await client.query(
      'SELECT document_id FROM search_documents WHERE index_id = $1 AND external_id = $2',
      [indexId, externalId],
    )
    if (found.rows.length === 0) { await client.query('COMMIT'); return }
    const documentId = found.rows[0].document_id

    const oldTerms = await documentTermSet(client, documentId)
    const oldStats = await documentStats(client, documentId)

    await client.query('DELETE FROM search_documents WHERE document_id = $1', [documentId]) // segments cascade

    await client.query(
      `UPDATE search_indexes
       SET total_documents = total_documents - 1,
           docs_changed_since_refresh = docs_changed_since_refresh + 1
       WHERE index_id = $1`,
      [indexId],
    )
    await applyMaintenance(client, {
      indexId,
      oldTerms,
      newTerms: [],
      deltaTitle: -oldStats.titleLength,
      deltaBody: -oldStats.bodyLength,
      deltaSegments: -oldStats.segments,
    })

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
```

> `applyMaintenance` recomputes the averages after the `total_documents` decrement, so order is correct (decrement first).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter api test -- test/ingest-stats.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add apps/api/services/ingest.ts apps/api/test/ingest-stats.test.ts
git commit -m "feat(stats): transactional deleteDocument with DF + length maintenance"
```

---

## Task 6: The invariant test — incremental == reconcile

This is the primary correctness guard.

**Files:**
- Test: `apps/api/test/stats-invariant.test.ts` (create)

- [ ] **Step 1: Write the invariant test**

```ts
// ABOUTME: After an arbitrary ingest/delete sequence, reconcile must produce zero changes.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, closePool, cleanupTestData } from './setup'
import { createIndex } from '../services/indexes'
import { ingestDocument, deleteDocument } from '../services/ingest'
import { reconcileIndex } from '../services/reconcile'
import { createTestAdapter } from '@phila/search-embeddings'
import { mergeConfig } from '../config'
import type { Pool } from 'pg'

const adapter = createTestAdapter(384)
const config = mergeConfig({})

async function snapshot(pool: Pool, indexId: number) {
  const df = await pool.query(
    'SELECT term, document_frequency FROM term_document_frequencies WHERE index_id=$1 ORDER BY term', [indexId])
  const idx = await pool.query(
    'SELECT total_title_length, total_body_length, total_segments, total_documents, avg_title_length, avg_body_length FROM search_indexes WHERE index_id=$1', [indexId])
  return { df: df.rows, idx: idx.rows[0] }
}

describe('incremental maintenance equals from-scratch reconcile', () => {
  let pool: Pool
  let indexId: number
  beforeAll(async () => {
    await setupSchema(); pool = await getTestPool()
    await createIndex(pool, { name: 'inv' })
    indexId = (await pool.query("SELECT index_id FROM search_indexes WHERE name='inv'")).rows[0].index_id

    // Arbitrary sequence: inserts, an update (term added + removed), a delete.
    await ingestDocument(pool, indexId, adapter, { external_id: 'a', title: 'Parking Permits', body: 'parking permit garage downtown' }, config)
    await ingestDocument(pool, indexId, adapter, { external_id: 'b', title: 'Trash Pickup', body: 'trash recycling schedule' }, config)
    await ingestDocument(pool, indexId, adapter, { external_id: 'a', title: 'Parking', body: 'parking permit residential' }, config) // update
    await ingestDocument(pool, indexId, adapter, { external_id: 'c', title: 'Permits', body: 'building permit application' }, config)
    await deleteDocument(pool, indexId, 'b')
  })
  afterAll(async () => { await teardownSchema(); await closePool() })

  it('reconcile changes nothing', async () => {
    const before = await snapshot(pool, indexId)
    await reconcileIndex(pool, indexId)
    const after = await snapshot(pool, indexId)
    expect(after.df).toEqual(before.df)
    expect(after.idx).toEqual(before.idx)
  })
})
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter api test -- test/stats-invariant.test.ts`
Expected: PASS. If it fails, the diff between snapshots pinpoints the incremental bug — fix in `stats.ts`/`ingest.ts`, not by weakening the test.

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/stats-invariant.test.ts
git commit -m "test(stats): invariant — incremental maintenance equals reconcile"
```

---

## Task 7: Deadlock retry on the ingest transaction

**Files:**
- Modify: `apps/api/services/ingest.ts` (`ingestDocument`)

- [ ] **Step 1: Wrap the transaction body in a bounded retry on serialization/deadlock**

Extract the existing `const client = await pool.connect() … finally { client.release() }` block into an inner function and call it with a retry helper. Add near the top of `ingest.ts`:

```ts
async function withDeadlockRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn() }
    catch (err: any) {
      // 40P01 deadlock_detected, 40001 serialization_failure
      if ((err?.code === '40P01' || err?.code === '40001') && i < attempts - 1) continue
      throw err
    }
  }
}
```

Then wrap the transaction: the `client.connect()/BEGIN…COMMIT/finally release` becomes the body of `withDeadlockRetry(async () => { … })`, returning `response`.

- [ ] **Step 2: Run the full stats suite to confirm no regression**

Run: `pnpm --filter api test -- test/ingest-stats.test.ts test/stats.test.ts test/stats-invariant.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/services/ingest.ts
git commit -m "feat(stats): retry ingest transaction on deadlock/serialization"
```

---

## Task 8: Swap admin `/refresh` → `/reconcile`; delete `refresh.ts`; remove `refresh_threshold`

**Files:**
- Modify: `apps/api/routes/admin.ts` (the `/refresh` route, ~line 57)
- Delete: `apps/api/services/refresh.ts`, `apps/api/test/refresh.test.ts`
- Modify: `apps/api/config.ts` (remove `refresh_threshold` from `DEFAULT_CONFIG`)
- Modify: `apps/api/types.ts` (remove `refresh_threshold` from `IndexConfig`)
- Create: `apps/api/test/admin.test.ts`
- Modify: `apps/api/test/config.test.ts`, `apps/api/test/ingest.test.ts`, `apps/api/test/search.test.ts`, `apps/api/test/rag.test.ts`, `apps/api/test/e2e-hybrid-search.test.ts`, `apps/api/test/adapter.test.ts`, `apps/api/scripts/ingest-311-kb.ts`

- [ ] **Step 1: Write a failing route test for `/reconcile`** (no admin route test exists today)

Create `apps/api/test/admin.test.ts` following the Hono app-wiring pattern used in `routes.test.ts`. Mount the app, create an index, and assert:

```ts
// POST /private/key/admin/indexes/:name/reconcile returns 200 { status: 'reconciled' }
const res = await app.request(`/private/key/admin/indexes/${name}/reconcile`, { method: 'POST' }, env)
expect(res.status).toBe(200)
expect(await res.json()).toEqual({ status: 'reconciled' })
// and a missing index returns 404
```

(Read `routes.test.ts` for how this repo constructs the test app + env / how admin API-key auth is satisfied in tests, and mirror it. If admin routes are gated by an API-key the test app bypasses, follow whatever `routes.test.ts` does for protected paths.)

Run: `pnpm --filter api test -- test/admin.test.ts` → Expected: FAIL (route is still `/refresh`).

- [ ] **Step 2: Replace the route** in `apps/api/routes/admin.ts`

```ts
adminRoutes.post('/private/key/admin/indexes/:name/reconcile', withPool(async ({ pool }, c) => {
  const name = c.req.param('name')!
  const index = await getIndex(pool, name)
  if (!index) return apiError(c, 'NOT_FOUND', `Index '${name}' not found`)
  await reconcileIndex(pool, index.index_id)
  return c.json({ status: 'reconciled' })
}))
```
Replace the `import { refreshIndex } from '../services/refresh'` with `import { reconcileIndex } from '../services/reconcile'`.

- [ ] **Step 3: Delete dead files and references**

```bash
git rm apps/api/services/refresh.ts apps/api/test/refresh.test.ts
```
Source:
- `apps/api/config.ts`: remove the `refresh_threshold: 1000,` line from `DEFAULT_CONFIG`.
- `apps/api/types.ts`: remove `refresh_threshold: number` from `IndexConfig`.
- `apps/api/scripts/ingest-311-kb.ts:251`: change the `/refresh` HTTP call to `/reconcile`.

Tests (these will break the build/suite if missed — the reviewer confirmed each):
- `apps/api/test/config.test.ts`: remove the `expect(config.refresh_threshold)...` assertion.
- `apps/api/test/ingest.test.ts`: **delete** the entire "auto-refreshes when ingest crosses the refresh threshold" test case (~lines 107-120) — it asserts `last_refreshed_at` becomes non-null after ingest, a side effect that no longer exists; also remove any `refresh_threshold` from config objects.
- `apps/api/test/search.test.ts`, `apps/api/test/rag.test.ts`: remove the `import { refreshIndex } from '../services/refresh'` and delete the `await refreshIndex(pool, indexId)` calls. Their `refreshIndex` is pure setup (IDF data for BM25), now maintained incrementally by the `ingestDocument` these tests already run, so the assertions still pass.
- `apps/api/test/e2e-hybrid-search.test.ts`: remove the import and the `await refreshIndex(...)` setup call, **and delete the entire `it('refreshes materialized views and index stats')` test case (~lines 152-168)**. It asserts `docs_changed_since_refresh === 0` (incremental ingest increments and never resets it) and `last_refreshed_at` non-null (only `refreshIndex` set it) — both fail once refresh is gone. Same handling as the `ingest.test.ts` auto-refresh case.
- `apps/api/test/adapter.test.ts`: remove `refresh_threshold: 100` from its config object.

Then grep to catch stragglers:
```bash
grep -rn "refresh_threshold\|refreshIndex\|checkAndRefresh" apps/api --include='*.ts' | grep -v node_modules
# test-only sweep for the side-effect assertions that no longer hold:
grep -rn "last_refreshed_at\|docs_changed_since_refresh" apps/api/test --include='*.ts'
```
Expected: the first grep yields no matches. The second should surface **only** legitimate references (there should be none left in tests asserting them as post-ingest side effects — any that remain are the same delete-the-case class). Note `last_refreshed_at`/`docs_changed_since_refresh` legitimately remain in the schema, types, and `indexes.ts`; this sweep is test-only. (Leave `docs_changed_since_refresh` *writes* in ingest/delete — that column is intentionally kept until the squash.)

- [ ] **Step 4: Run the full api test suite**

Run: `pnpm --filter api test`
Expected: PASS, no references to removed symbols. (TypeScript build must also pass: `pnpm --filter api build`.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(stats): replace /refresh with /reconcile; remove refresh path + refresh_threshold"
```

---

## Done criteria

- `pnpm --filter api test` green, including the invariant test.
- `pnpm --filter api build` clean; no remaining `refreshIndex`/`checkAndRefresh`/`refresh_threshold` references.
- `term_document_frequencies` is a table maintained incrementally; `reconcile_index_stats` exists and the invariant holds.
- **Not yet deployed** and pg_cron not yet involved — that is Plan B.
