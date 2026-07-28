# Search Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a capture-and-pull analytics loop: log each search as an event, accept feedback postbacks tied to a `query_id`, and let index owners pull raw events behind a new per-index analytics key.

**Architecture:** One generic `search_events` table holds query rows (`action='search'`, `query_id IS NULL`) and consumer feedback rows (self-FK `query_id`). The search route inserts a query row after `hybridSearch` and returns its `event_id` as `query_id`; a postback endpoint inserts feedback rows via `INSERT ... SELECT` from the parent row; a pull endpoint returns flat rows keyset-paginated on `(created_at, event_id)`. Spec: `docs/superpowers/specs/2026-07-27-search-analytics-design.md`.

**Tech Stack:** Hono routes on Lambda, node-postgres (`pg`), the repo's own schema validator (`middleware/validate.ts`), vitest against the docker-compose test Postgres (port 5433). No new dependencies.

**Conventions that apply to every task:**
- Every new file starts with two `// ABOUTME:` comment lines.
- Tests run with `pnpm --filter api test -- <file>` from the repo root (vitest; the test DB must be up via `docker compose -f docker-compose.test.yml up -d`).
- Route tests follow the existing pattern (`test/admin.test.ts`, `test/search-route.test.ts`): set `DB_*` env to the `TEST_DB_*` values in `beforeAll`, mount routes on a fresh `Hono()` app, drive via `app.request(...)`.
- `mode=lexical` searches never call the embedding adapter, so route tests exercise the full 200 path against the real DB with no Bedrock access.
- Commit after every green test, with the trailer lines the repo uses (Co-Authored-By + Claude-Session).

---

### Task 0: WIP branch

- [ ] **Step 0.1:** From a clean `main`, create the working branch:

```bash
git checkout -b analytics
```

(`.beads/beads.base.jsonl` may show as modified — leave it alone; it is synced separately.)

---

### Task 1: Migration — `search_events` table + `analytics_key_hash` column

**Files:**
- Modify: `apps/api/db/migrations.ts` (append version 10)
- Modify: `apps/api/test/setup.ts` (teardown + cleanup know the new table)
- Test: `apps/api/test/analytics.test.ts` (create)

- [ ] **Step 1.1: Write the failing test**

Create `apps/api/test/analytics.test.ts`:

```typescript
// ABOUTME: Tests for the analytics event log: schema, capture, feedback postback, and pull.
// ABOUTME: Runs against the real test database; searches use mode=lexical (no Bedrock).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { getTestPool, setupSchema, teardownSchema, cleanupTestData, closePool } from './setup'

describe('analytics schema', () => {
  let pool: Pool

  beforeAll(async () => {
    await setupSchema()
    pool = await getTestPool()
  })
  afterAll(async () => { await cleanupTestData(); await teardownSchema(); await closePool() })

  it('creates search_events with the expected columns', async () => {
    const result = await pool.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'search_events' ORDER BY column_name`,
    )
    const columns = Object.fromEntries(result.rows.map(r => [r.column_name, r.is_nullable]))
    expect(columns).toEqual({
      action: 'NO',
      created_at: 'NO',
      data: 'NO',
      event_id: 'NO',
      index_id: 'NO',
      query_id: 'YES',
    })
  })

  it('adds analytics_key_hash to search_indexes', async () => {
    const result = await pool.query(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'search_indexes' AND column_name = 'analytics_key_hash'`,
    )
    expect(result.rows).toEqual([{ is_nullable: 'YES' }])
  })
})
```

- [ ] **Step 1.2: Run it to confirm it fails**

Run: `pnpm --filter api test -- analytics`
Expected: FAIL — both `it` blocks (empty column sets; table and column don't exist).

- [ ] **Step 1.3: Append migration 10**

In `apps/api/db/migrations.ts`, append to the `migrations` array after version 9:

```typescript
  {
    version: 10,
    description: 'Analytics event log and per-index analytics key',
    sql: `CREATE TABLE IF NOT EXISTS search_events (
              event_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
              index_id    INTEGER NOT NULL REFERENCES search_indexes(index_id) ON DELETE CASCADE,
              query_id    UUID REFERENCES search_events(event_id) ON DELETE CASCADE,
              action      TEXT NOT NULL,
              data        JSONB NOT NULL DEFAULT '{}',
              created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          CREATE INDEX IF NOT EXISTS idx_events_index_created ON search_events (index_id, created_at, event_id);
          CREATE INDEX IF NOT EXISTS idx_events_query ON search_events (query_id);
          ALTER TABLE search_indexes ADD COLUMN IF NOT EXISTS analytics_key_hash TEXT;`,
  },
```

- [ ] **Step 1.4: Teach the test harness about the table**

In `apps/api/test/setup.ts`:
- In `teardownSchema()`, add **before** the `search_indexes` drop:

```typescript
  await p.query('DROP TABLE IF EXISTS search_events CASCADE')
```

- In `cleanupTestData()`, add **before** the `search_indexes` delete:

```typescript
  await p.query('DELETE FROM search_events')
```

- [ ] **Step 1.5: Run the test to confirm it passes**

Run: `pnpm --filter api test -- analytics`
Expected: PASS (2 tests).

Also run the full suite once — migration ordering and setup changes touch everything:

Run: `pnpm --filter api test`
Expected: all green.

- [ ] **Step 1.6: Commit**

```bash
git add apps/api/db/migrations.ts apps/api/test/setup.ts apps/api/test/analytics.test.ts
git commit -m "Add search_events table and analytics_key_hash column"
```

---

### Task 2: `maxLength` validation rule

The postback endpoint caps `action` at 64 chars. The shared validator has no length rule; add one rather than an inline check.

**Files:**
- Modify: `apps/api/middleware/validate.ts`
- Test: `apps/api/test/validate.test.ts` (extend)

- [ ] **Step 2.1: Write the failing tests**

Append to the existing describe block structure in `apps/api/test/validate.test.ts` (match the file's local style when editing):

```typescript
describe('maxLength rule', () => {
  it('accepts a string at the limit', () => {
    const result = validate({ action: 'a'.repeat(64) }, { action: ['maxLength', 64] })
    expect(result.ok).toBe(true)
  })

  it('rejects a string over the limit', () => {
    const result = validate({ action: 'a'.repeat(65) }, { action: ['maxLength', 64] })
    expect(result).toEqual({ ok: false, message: 'action must be at most 64 characters' })
  })
})
```

- [ ] **Step 2.2: Run to confirm failure**

Run: `pnpm --filter api test -- validate`
Expected: FAIL — TypeScript/runtime rejects the unknown rule verb.

- [ ] **Step 2.3: Implement the rule**

In `apps/api/middleware/validate.ts`:
- Add to the `Rule` union:

```typescript
  | readonly ['maxLength', number]
```

- Add a case in `applyRule`:

```typescript
    case 'maxLength':
      if (typeof value !== 'string' || value.length > rule[1]) {
        return `${key} must be at most ${rule[1]} characters`
      }
      return null
```

- [ ] **Step 2.4: Run to confirm pass**

Run: `pnpm --filter api test -- validate`
Expected: PASS, including all pre-existing validate tests.

- [ ] **Step 2.5: Commit**

```bash
git add apps/api/middleware/validate.ts apps/api/test/validate.test.ts
git commit -m "Add maxLength rule to the request validator"
```

---

### Task 3: Analytics service — `logQuery`

**Files:**
- Create: `apps/api/services/analytics.ts`
- Test: `apps/api/test/analytics.test.ts` (extend)

- [ ] **Step 3.1: Write the failing test**

Add to `apps/api/test/analytics.test.ts`. This and later describe blocks need an index; create one per block with `createIndex` (import from `../services/indexes`).

```typescript
import { createIndex } from '../services/indexes'
import { logQuery } from '../services/analytics'

describe('logQuery', () => {
  let pool: Pool
  let indexId: number

  beforeAll(async () => {
    await setupSchema()
    pool = await getTestPool()
    await createIndex(pool, { name: 'analytics-svc-idx' })
    const row = await pool.query(`SELECT index_id FROM search_indexes WHERE name = 'analytics-svc-idx'`)
    indexId = row.rows[0].index_id
  })
  afterAll(async () => { await cleanupTestData(); await teardownSchema(); await closePool() })

  it('inserts a query row and returns its event_id', async () => {
    const data = { q: 'parking permit', mode: 'lexical', kinds: null, limit: 10, total: 2, result_ids: ['a', 'b'] }
    const eventId = await logQuery(pool, indexId, data)

    const row = await pool.query('SELECT * FROM search_events WHERE event_id = $1', [eventId])
    expect(row.rows).toHaveLength(1)
    expect(row.rows[0].index_id).toBe(indexId)
    expect(row.rows[0].query_id).toBeNull()
    expect(row.rows[0].action).toBe('search')
    expect(row.rows[0].data).toEqual(data)
  })
})
```

Note: each describe block in this file runs `setupSchema`/`teardownSchema` in its own lifecycle, same as sibling test files — vitest runs test files in separate workers, but blocks within a file run sequentially, so this is safe.

- [ ] **Step 3.2: Run to confirm failure**

Run: `pnpm --filter api test -- analytics`
Expected: FAIL — `services/analytics` module does not exist.

- [ ] **Step 3.3: Create the service**

Create `apps/api/services/analytics.ts`:

```typescript
// ABOUTME: Analytics event log: query capture, feedback postbacks, and paginated pulls.
// ABOUTME: One generic search_events bucket; query rows are action='search' with null query_id.

import type { Pool } from 'pg'

// Returns the new query row's event_id — the query_id consumers post feedback against.
export async function logQuery(
  pool: Pool,
  indexId: number,
  data: Record<string, unknown>,
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO search_events (index_id, action, data)
     VALUES ($1, 'search', $2)
     RETURNING event_id`,
    [indexId, JSON.stringify(data)],
  )
  return result.rows[0].event_id
}
```

- [ ] **Step 3.4: Run to confirm pass**

Run: `pnpm --filter api test -- analytics`
Expected: PASS.

- [ ] **Step 3.5: Commit**

```bash
git add apps/api/services/analytics.ts apps/api/test/analytics.test.ts
git commit -m "Add analytics service with query capture"
```

---

### Task 4: Search route capture — `query_id` in the search response

**Files:**
- Modify: `apps/api/routes/search.ts`
- Modify: `apps/api/types.ts` (SearchResponse gains optional `query_id`)
- Test: `apps/api/test/analytics.test.ts` (extend)

- [ ] **Step 4.1: Write the failing tests**

Add to `apps/api/test/analytics.test.ts` (imports: `Hono` from `hono`, `searchRoutes` from `../routes/search`, `vi` from `vitest`; the route needs `DB_*` env pointed at the test DB — copy the `beforeAll` env block from `test/search-route.test.ts` verbatim):

```typescript
describe('search capture', () => {
  let pool: Pool
  let searchKey: string

  beforeAll(async () => {
    process.env.DB_HOST = process.env.TEST_DB_HOST || 'localhost'
    process.env.DB_PORT = process.env.TEST_DB_PORT || '5433'
    process.env.DB_NAME = process.env.TEST_DB_NAME || 'pgsearch_test'
    process.env.DB_USER = process.env.TEST_DB_USER || 'pgsearch'
    process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD || 'testpassword'

    await setupSchema()
    pool = await getTestPool()
    const created = await createIndex(pool, { name: 'analytics-capture-idx' })
    searchKey = created!.search_key
  })
  afterAll(async () => { await cleanupTestData(); await teardownSchema(); await closePool() })

  const app = new Hono()
  app.route('/', searchRoutes)

  const search = (query: string) =>
    app.request(`/public/search/analytics-capture-idx?${query}`, { headers: { 'x-search-key': searchKey } })

  it('logs the query and returns a query_id', async () => {
    const res = await search('q=water&mode=lexical&limit=5')
    expect(res.status).toBe(200)
    const body = await res.json() as { query_id?: string; total: number }
    expect(body.query_id).toMatch(/^[0-9a-f-]{36}$/)

    const row = await pool.query('SELECT * FROM search_events WHERE event_id = $1', [body.query_id])
    expect(row.rows).toHaveLength(1)
    expect(row.rows[0].action).toBe('search')
    expect(row.rows[0].data).toEqual({
      q: 'water', mode: 'lexical', kinds: null, limit: 5, total: 0, result_ids: [],
    })
  })

  // Must stay the LAST test in this block: it drops search_events and the only
  // way to get it back is a full teardown + setup — schema_migrations still
  // records version 10 after the DROP, so a bare setupSchema() would skip
  // recreating the table (runMigrations skips recorded versions). The rebuild
  // also wipes this block's index, which no later test in this block may rely on.
  it('returns results without query_id when the log insert fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await pool.query('DROP TABLE search_events CASCADE')
    try {
      const res = await search('q=water&mode=lexical')
      expect(res.status).toBe(200)
      const body = await res.json() as { query_id?: string }
      expect(body.query_id).toBeUndefined()
      expect(errors).toHaveBeenCalledOnce()
      expect(String(errors.mock.calls[0][0])).toContain('analytics')
    } finally {
      errors.mockRestore()
      await teardownSchema()
      await setupSchema()
    }
  })
})
```

(The dropped-table test intentionally triggers an error; the spy both silences it — keeping test output pristine — and asserts it was reported, per house testing rules.)

- [ ] **Step 4.2: Run to confirm failure**

Run: `pnpm --filter api test -- analytics`
Expected: FAIL — `query_id` is undefined on the 200 response in the first test.

- [ ] **Step 4.3: Implement capture in the route**

In `apps/api/types.ts`, add to `SearchResponse`:

```typescript
export interface SearchResponse {
  query_id?: string
  results: SearchResult[]
  total: number
  query: string
}
```

In `apps/api/routes/search.ts`, import `logQuery` from `../services/analytics`, then replace the final two lines of the GET handler:

```typescript
  const adapter = getAdapter(index.config)
  const results = await hybridSearch(pool, index, adapter, q.trim(), { limit, mode: modeParam, kindWeights, recency, kinds })

  // Capture failures degrade to a response without query_id — analytics never breaks search.
  let queryId: string | undefined
  try {
    queryId = await logQuery(pool, index.index_id, {
      q: q.trim(),
      mode: modeParam ?? 'hybrid',
      kinds: kinds ?? null,
      limit,
      total: results.total,
      result_ids: results.results.map(r => r.external_id),
    })
  } catch (err) {
    console.error('analytics capture failed:', err)
  }

  return c.json(queryId ? { query_id: queryId, ...results } : results, 200)
```

- [ ] **Step 4.4: Run to confirm pass**

Run: `pnpm --filter api test -- analytics`
Expected: PASS. Also run `pnpm --filter api test -- search-route` — the existing validation tests must stay green.

- [ ] **Step 4.5: Commit**

```bash
git add apps/api/routes/search.ts apps/api/types.ts apps/api/test/analytics.test.ts
git commit -m "Log searches and return query_id in the search response"
```

---

### Task 5: Feedback postback endpoint

**Files:**
- Modify: `apps/api/services/analytics.ts` (add `logEvent`)
- Modify: `apps/api/routes/search.ts` (add POST route)
- Test: `apps/api/test/analytics.test.ts` (extend)

- [ ] **Step 5.1: Write the failing tests**

Add to `apps/api/test/analytics.test.ts`. Setup mirrors the capture block but creates **two** indexes (`analytics-fb-idx`, `analytics-fb-other`) so cross-index rejection is testable; keep both search keys. Get a real `query_id` by running one `mode=lexical` search in `beforeAll`.

```typescript
describe('feedback postback', () => {
  let pool: Pool
  let searchKey: string
  let otherSearchKey: string
  let queryId: string

  const app = new Hono()
  app.route('/', searchRoutes)

  beforeAll(async () => {
    process.env.DB_HOST = process.env.TEST_DB_HOST || 'localhost'
    process.env.DB_PORT = process.env.TEST_DB_PORT || '5433'
    process.env.DB_NAME = process.env.TEST_DB_NAME || 'pgsearch_test'
    process.env.DB_USER = process.env.TEST_DB_USER || 'pgsearch'
    process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD || 'testpassword'

    await setupSchema()
    pool = await getTestPool()
    const created = await createIndex(pool, { name: 'analytics-fb-idx' })
    searchKey = created!.search_key
    const other = await createIndex(pool, { name: 'analytics-fb-other' })
    otherSearchKey = other!.search_key

    const res = await app.request('/public/search/analytics-fb-idx?q=water&mode=lexical', {
      headers: { 'x-search-key': searchKey },
    })
    queryId = ((await res.json()) as { query_id: string }).query_id
  })
  afterAll(async () => { await cleanupTestData(); await teardownSchema(); await closePool() })

  const post = (body: unknown, key = searchKey, index = 'analytics-fb-idx') =>
    app.request(`/public/search/${index}/events`, {
      method: 'POST',
      headers: { 'x-search-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('records a feedback event against a query row', async () => {
    const res = await post({ query_id: queryId, action: 'selected', data: { external_id: 'page-1', rank: 3 } })
    expect(res.status).toBe(201)
    const body = await res.json() as { event_id: string }

    const row = await pool.query('SELECT * FROM search_events WHERE event_id = $1', [body.event_id])
    expect(row.rows[0].query_id).toBe(queryId)
    expect(row.rows[0].action).toBe('selected')
    expect(row.rows[0].data).toEqual({ external_id: 'page-1', rank: 3 })
    // index_id copied from the parent query row
    const parent = await pool.query('SELECT index_id FROM search_events WHERE event_id = $1', [queryId])
    expect(row.rows[0].index_id).toBe(parent.rows[0].index_id)
  })

  it('404s an unknown query_id', async () => {
    const res = await post({ query_id: '00000000-0000-0000-0000-000000000000', action: 'selected' })
    expect(res.status).toBe(404)
  })

  it('404s a query_id belonging to another index', async () => {
    const res = await post({ query_id: queryId, action: 'selected' }, otherSearchKey, 'analytics-fb-other')
    expect(res.status).toBe(404)
  })

  it('404s a query_id that points at a feedback row, not a query row', async () => {
    const first = await post({ query_id: queryId, action: 'selected' })
    const { event_id } = await first.json() as { event_id: string }
    const res = await post({ query_id: event_id, action: 'selected' })
    expect(res.status).toBe(404)
  })

  it('400s a missing action', async () => {
    const res = await post({ query_id: queryId })
    expect(res.status).toBe(400)
  })

  it('400s an action over 64 characters', async () => {
    const res = await post({ query_id: queryId, action: 'a'.repeat(65) })
    expect(res.status).toBe(400)
  })

  it('400s a non-uuid query_id', async () => {
    const res = await post({ query_id: 'not-a-uuid', action: 'selected' })
    expect(res.status).toBe(400)
  })

  it('400s data over 4KB serialized', async () => {
    const res = await post({ query_id: queryId, action: 'selected', data: { blob: 'x'.repeat(5000) } })
    expect(res.status).toBe(400)
  })

  it('401s without a search key', async () => {
    const res = await app.request('/public/search/analytics-fb-idx/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query_id: queryId, action: 'selected' }),
    })
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 5.2: Run to confirm failure**

Run: `pnpm --filter api test -- analytics`
Expected: FAIL — POST route doesn't exist (404s where 201/400 expected; the two genuine-404 tests may pass by accident, that's fine).

- [ ] **Step 5.3: Implement `logEvent` and the route**

In `apps/api/services/analytics.ts`, append:

```typescript
// Inserts a feedback event by copying index_id from the parent query row.
// The WHERE clause is the whole contract: parent must exist, belong to the
// authenticated index, and itself be a query row (query_id IS NULL) — feedback
// cannot chain to feedback. Returns null when no parent matched.
export async function logEvent(
  pool: Pool,
  indexId: number,
  queryId: string,
  action: string,
  data: Record<string, unknown>,
): Promise<string | null> {
  const result = await pool.query(
    `INSERT INTO search_events (index_id, query_id, action, data)
     SELECT index_id, event_id, $3, $4
     FROM search_events
     WHERE event_id = $1 AND index_id = $2 AND query_id IS NULL
     RETURNING event_id`,
    [queryId, indexId, action, JSON.stringify(data)],
  )
  return result.rows[0]?.event_id ?? null
}
```

In `apps/api/routes/search.ts`, register auth for the new path and add the route (imports: `logEvent` from `../services/analytics`, `parseBody`, `ValidationError` from `../middleware/validate`):

```typescript
searchRoutes.use('/public/search/:name/events', searchAuth)

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_EVENT_DATA_BYTES = 4096

interface FeedbackBody {
  query_id: string
  action: string
  data?: Record<string, unknown>
}

searchRoutes.post('/public/search/:name/events', withIndex(async ({ pool, index }, c) => {
  const body = await parseBody<FeedbackBody>(c, {
    query_id: [['typeof', 'string'], ['nonEmpty']],
    action: [['typeof', 'string'], ['nonEmpty'], ['maxLength', 64]],
    'data?': ['object'],
  })
  if (!UUID_PATTERN.test(body.query_id)) throw new ValidationError('query_id must be a UUID')
  const data = body.data ?? {}
  if (JSON.stringify(data).length > MAX_EVENT_DATA_BYTES) {
    throw new ValidationError(`data must serialize to at most ${MAX_EVENT_DATA_BYTES} bytes`)
  }

  const eventId = await logEvent(pool, index.index_id, body.query_id, body.action, data)
  if (!eventId) return apiError(c, 'NOT_FOUND', 'Unknown query_id')
  return c.json({ event_id: eventId }, 201)
}))
```

The UUID pre-check exists because a malformed UUID would otherwise throw a Postgres cast error (500) instead of a 400.

**Required for this block's tests:** the feedback route throws `ValidationError` and relies on the global `onError` in `index.ts` to map it to a 400 — a bare `Hono()` app has no such handler and returns 500. In the feedback describe block's app construction, add the `onError` block from `index.ts` verbatim (the `ValidationError` → `apiError` branch plus the 500 fallback) after `app.route('/', searchRoutes)` — this needs `ValidationError` imported from `../middleware/validate` and `apiError` from `../middleware/error` in the test file. That is the production wiring; without it the four 400-expecting tests fail. The other blocks don't need it — their routes return `apiError` directly.

- [ ] **Step 5.4: Run to confirm pass**

Run: `pnpm --filter api test -- analytics`
Expected: PASS (all feedback tests green).

- [ ] **Step 5.5: Commit**

```bash
git add apps/api/services/analytics.ts apps/api/routes/search.ts apps/api/test/analytics.test.ts
git commit -m "Add feedback postback endpoint tied to logged queries"
```

---

### Task 6: Analytics key — auth middleware, key type, admin mint/revoke

**Files:**
- Modify: `apps/api/middleware/auth.ts`
- Modify: `apps/api/services/indexes.ts`
- Modify: `apps/api/types.ts` (SearchIndex gains `analytics_key_hash`)
- Modify: `apps/api/routes/admin.ts`
- Test: `apps/api/test/analytics.test.ts` (extend)

- [ ] **Step 6.1: Write the failing tests**

Add to `apps/api/test/analytics.test.ts` (import `adminRoutes` from `../routes/admin`):

```typescript
describe('analytics key admin', () => {
  let pool: Pool

  const app = new Hono()
  app.route('/', adminRoutes)

  beforeAll(async () => {
    process.env.DB_HOST = process.env.TEST_DB_HOST || 'localhost'
    process.env.DB_PORT = process.env.TEST_DB_PORT || '5433'
    process.env.DB_NAME = process.env.TEST_DB_NAME || 'pgsearch_test'
    process.env.DB_USER = process.env.TEST_DB_USER || 'pgsearch'
    process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD || 'testpassword'

    await setupSchema()
    pool = await getTestPool()
    await createIndex(pool, { name: 'analytics-key-idx' })
  })
  afterAll(async () => { await cleanupTestData(); await teardownSchema(); await closePool() })

  it('mints an anly_-prefixed analytics key and stores its hash', async () => {
    const res = await app.request('/private/key/admin/indexes/analytics-key-idx/analytics-key', { method: 'POST' })
    expect(res.status).toBe(201)
    const body = await res.json() as { analytics_key: string }
    expect(body.analytics_key).toMatch(/^anly_/)

    const row = await pool.query(`SELECT analytics_key_hash FROM search_indexes WHERE name = 'analytics-key-idx'`)
    expect(row.rows[0].analytics_key_hash).not.toBeNull()
  })

  it('revokes the analytics key', async () => {
    const res = await app.request('/private/key/admin/indexes/analytics-key-idx/analytics-key', { method: 'DELETE' })
    expect(res.status).toBe(200)
    const row = await pool.query(`SELECT analytics_key_hash FROM search_indexes WHERE name = 'analytics-key-idx'`)
    expect(row.rows[0].analytics_key_hash).toBeNull()
  })

  it('404s minting for a missing index', async () => {
    const res = await app.request('/private/key/admin/indexes/nope/analytics-key', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 6.2: Run to confirm failure**

Run: `pnpm --filter api test -- analytics`
Expected: FAIL — admin route doesn't exist (404 where 201 expected).

- [ ] **Step 6.3: Implement**

`apps/api/types.ts` — add to `SearchIndex` after `rag_key_hash`:

```typescript
  analytics_key_hash: string | null
```

`apps/api/services/indexes.ts` — extend the key maps:

```typescript
export type KeyType = 'index' | 'search' | 'rag' | 'analytics'

const KEY_HASH_COLUMNS: Record<KeyType, 'index_key_hash' | 'search_key_hash' | 'rag_key_hash' | 'analytics_key_hash'> = {
  index: 'index_key_hash',
  search: 'search_key_hash',
  rag: 'rag_key_hash',
  analytics: 'analytics_key_hash',
}

const KEY_PREFIXES: Record<KeyType, string> = {
  index: 'idx',
  search: 'srch',
  rag: 'rag',
  analytics: 'anly',
}
```

(Update the comment above `KeyType` if it says "three" literal column names — it now lists four.)

`apps/api/middleware/auth.ts` — extend the union and export the middleware:

```typescript
type KeyHashField = 'index_key_hash' | 'search_key_hash' | 'rag_key_hash' | 'analytics_key_hash'
```

```typescript
export const analyticsAuth = keyAuth({ header: 'x-analytics-key', hashField: 'analytics_key_hash', keyLabel: 'analytics' })
```

`apps/api/routes/admin.ts` — mirror the rag-key pair exactly:

```typescript
adminRoutes.post('/private/key/admin/indexes/:name/analytics-key', withPool(async ({ pool }, c) => {
  const name = c.req.param('name')!
  const result = await mintKey(pool, name, 'analytics')
  if (!result) return apiError(c, 'NOT_FOUND', `Index '${name}' not found`)
  return c.json({ analytics_key: result.key }, 201)
}))

adminRoutes.delete('/private/key/admin/indexes/:name/analytics-key', withPool(async ({ pool }, c) => {
  const name = c.req.param('name')!
  const revoked = await revokeKey(pool, name, 'analytics')
  if (!revoked) return apiError(c, 'NOT_FOUND', `Index '${name}' not found`)
  return c.json({ revoked: true })
}))
```

- [ ] **Step 6.4: Run to confirm pass**

Run: `pnpm --filter api test -- analytics`
Expected: PASS. Also run `pnpm --filter api test -- admin auth indexes` to confirm nothing existing broke.

- [ ] **Step 6.5: Commit**

```bash
git add apps/api/middleware/auth.ts apps/api/services/indexes.ts apps/api/types.ts apps/api/routes/admin.ts apps/api/test/analytics.test.ts
git commit -m "Add per-index analytics key with admin mint and revoke"
```

---

### Task 7: Pull endpoint — flat events, keyset-paginated

**Files:**
- Modify: `apps/api/services/analytics.ts` (add `pullEvents` + cursor helpers)
- Create: `apps/api/routes/analytics.ts`
- Modify: `apps/api/index.ts` (mount route, add `x-analytics-key` to CORS)
- Test: `apps/api/test/analytics.test.ts` (extend)

**Keyset precision note (why the cursor is not built from JS dates):** node-postgres parses `TIMESTAMPTZ` into a JS `Date`, which has millisecond precision, while Postgres stores microseconds. A cursor built from a parsed `Date` would compare `(X.123000, id)` against a stored `X.123456` and re-return the cursor row. The service therefore selects `created_at::text` (full microsecond precision, e.g. `2026-07-27 14:03:07.123456+00`) alongside the parsed value and builds cursors from the text form, casting back with `::timestamptz` in the WHERE clause.

- [ ] **Step 7.1: Write the failing tests**

Add to `apps/api/test/analytics.test.ts` (import `analyticsRoutes` from `../routes/analytics`, `logEvent` from `../services/analytics`):

```typescript
describe('analytics pull', () => {
  let pool: Pool
  let analyticsKey: string
  let queryIds: string[] = []

  const app = new Hono()
  app.route('/', analyticsRoutes)

  const adminApp = new Hono()
  adminApp.route('/', adminRoutes)

  beforeAll(async () => {
    process.env.DB_HOST = process.env.TEST_DB_HOST || 'localhost'
    process.env.DB_PORT = process.env.TEST_DB_PORT || '5433'
    process.env.DB_NAME = process.env.TEST_DB_NAME || 'pgsearch_test'
    process.env.DB_USER = process.env.TEST_DB_USER || 'pgsearch'
    process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD || 'testpassword'

    await setupSchema()
    pool = await getTestPool()
    await createIndex(pool, { name: 'analytics-pull-idx' })
    const idxRow = await pool.query(`SELECT index_id FROM search_indexes WHERE name = 'analytics-pull-idx'`)
    const indexId = idxRow.rows[0].index_id

    const mint = await adminApp.request('/private/key/admin/indexes/analytics-pull-idx/analytics-key', { method: 'POST' })
    analyticsKey = ((await mint.json()) as { analytics_key: string }).analytics_key

    // 5 query rows, one with a feedback child → 6 events total
    queryIds = []
    for (let i = 0; i < 5; i++) {
      queryIds.push(await logQuery(pool, indexId, { q: `query ${i}`, total: 0, result_ids: [] }))
    }
    await logEvent(pool, indexId, queryIds[0], 'selected', { external_id: 'x', rank: 1 })
  })
  afterAll(async () => { await cleanupTestData(); await teardownSchema(); await closePool() })

  const pull = (qs = '', key = analyticsKey) =>
    app.request(`/public/analytics/analytics-pull-idx/events${qs ? `?${qs}` : ''}`, {
      headers: { 'x-analytics-key': key },
    })

  it('returns flat rows of both shapes in created_at order', async () => {
    const res = await pull()
    expect(res.status).toBe(200)
    const body = await res.json() as { events: any[]; next: string | null }
    expect(body.events).toHaveLength(6)
    expect(body.next).toBeNull()
    const actions = body.events.map(e => e.action)
    expect(actions.filter(a => a === 'search')).toHaveLength(5)
    expect(actions.filter(a => a === 'selected')).toHaveLength(1)
    const feedback = body.events.find(e => e.action === 'selected')
    expect(feedback.query_id).toBe(queryIds[0])
    // row shape: index_id omitted
    expect(Object.keys(body.events[0]).sort()).toEqual(['action', 'created_at', 'data', 'event_id', 'query_id'])
  })

  it('walks every row exactly once across pages', async () => {
    const seen: string[] = []
    let cursor: string | null = null
    for (let page = 0; page < 10; page++) {
      const res = await pull(`limit=2${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`)
      const body = await res.json() as { events: any[]; next: string | null }
      seen.push(...body.events.map(e => e.event_id))
      cursor = body.next
      if (!cursor) break
    }
    expect(seen).toHaveLength(6)
    expect(new Set(seen).size).toBe(6)
  })

  it('filters by half-open date range', async () => {
    const mid = await pool.query(
      `SELECT created_at::text AS ts FROM search_events ORDER BY created_at, event_id OFFSET 3 LIMIT 1`,
    )
    const ts = mid.rows[0].ts
    const before = await pull(`to=${encodeURIComponent(ts)}`)
    const after = await pull(`from=${encodeURIComponent(ts)}`)
    const beforeBody = await before.json() as { events: any[] }
    const afterBody = await after.json() as { events: any[] }
    expect(beforeBody.events.length + afterBody.events.length).toBe(6)
    expect(beforeBody.events).toHaveLength(3)   // to is exclusive
  })

  it('400s an unparseable from', async () => {
    const res = await pull('from=yesterday')
    expect(res.status).toBe(400)
  })

  it('400s a malformed after cursor', async () => {
    const res = await pull('after=garbage')
    expect(res.status).toBe(400)
  })

  it('401s with no analytics key minted', async () => {
    await createIndex(pool, { name: 'analytics-pull-nokey' })
    const res = await app.request('/public/analytics/analytics-pull-nokey/events', {
      headers: { 'x-analytics-key': analyticsKey },
    })
    expect(res.status).toBe(401)
  })

  it('401s a wrong key', async () => {
    const res = await pull('', 'anly_wrong')
    expect(res.status).toBe(401)
  })

  // Must stay the LAST test in this block: it seeds 600 extra rows, which would
  // break the earlier tests' row-count assertions if it ran before them.
  it('clamps limit to 500', async () => {
    const idxRow = await pool.query(`SELECT index_id FROM search_indexes WHERE name = 'analytics-pull-idx'`)
    await pool.query(
      `INSERT INTO search_events (index_id, action, data)
       SELECT $1, 'search', '{}' FROM generate_series(1, 600)`,
      [idxRow.rows[0].index_id],
    )
    const res = await pull('limit=9999')
    expect(res.status).toBe(200)
    const body = await res.json() as { events: any[]; next: string | null }
    expect(body.events).toHaveLength(500)
    expect(body.next).not.toBeNull()
  })
})
```

- [ ] **Step 7.2: Run to confirm failure**

Run: `pnpm --filter api test -- analytics`
Expected: FAIL — `routes/analytics` module does not exist.

- [ ] **Step 7.3: Implement `pullEvents` and the route**

Append to `apps/api/services/analytics.ts`:

```typescript
export interface AnalyticsEvent {
  event_id: string
  query_id: string | null
  action: string
  data: Record<string, unknown>
  created_at: string
}

export interface PullOptions {
  from?: string
  to?: string
  after?: string
  limit: number
}

export interface PullResult {
  events: AnalyticsEvent[]
  next: string | null
}

// Cursors carry the row's created_at::text (microsecond precision — a JS Date
// would truncate to milliseconds and re-return the boundary row) plus event_id,
// base64url-encoded as an opaque token.
function encodeCursor(createdAtText: string, eventId: string): string {
  return Buffer.from(JSON.stringify([createdAtText, eventId])).toString('base64url')
}

// Returns null on any malformed token; callers translate to a validation error.
export function decodeCursor(cursor: string): { createdAt: string; eventId: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString())
    if (!Array.isArray(parsed) || parsed.length !== 2) return null
    const [createdAt, eventId] = parsed
    if (typeof createdAt !== 'string' || typeof eventId !== 'string') return null
    return { createdAt, eventId }
  } catch {
    return null
  }
}

export async function pullEvents(pool: Pool, indexId: number, options: PullOptions): Promise<PullResult> {
  const after = options.after ? decodeCursor(options.after) : null
  // Fetch one extra row to know whether a next page exists.
  const result = await pool.query(
    `SELECT event_id, query_id, action, data, created_at, created_at::text AS created_at_text
     FROM search_events
     WHERE index_id = $1
       AND ($2::timestamptz IS NULL OR created_at >= $2)
       AND ($3::timestamptz IS NULL OR created_at < $3)
       AND ($4::timestamptz IS NULL OR (created_at, event_id) > ($4::timestamptz, $5::uuid))
     ORDER BY created_at, event_id
     LIMIT $6`,
    [
      indexId,
      options.from ?? null,
      options.to ?? null,
      after?.createdAt ?? null,
      after?.eventId ?? null,
      options.limit + 1,
    ],
  )

  const page = result.rows.slice(0, options.limit)
  const last = page[page.length - 1]
  const next = result.rows.length > options.limit && last
    ? encodeCursor(last.created_at_text, last.event_id)
    : null

  return {
    events: page.map(row => ({
      event_id: row.event_id,
      query_id: row.query_id,
      action: row.action,
      data: row.data,
      created_at: row.created_at.toISOString(),
    })),
    next,
  }
}
```

Create `apps/api/routes/analytics.ts`:

```typescript
// ABOUTME: Analytics pull route for index owners to export raw search events.
// ABOUTME: Flat rows behind the per-index analytics key, keyset-paginated.

import { Hono } from 'hono'
import { analyticsAuth } from '../middleware/auth'
import { withIndex } from '../middleware/deps'
import { apiError } from '../middleware/error'
import { pullEvents, decodeCursor } from '../services/analytics'
import type { AppEnv } from '../types'

const MAX_PULL_LIMIT = 500

export const analyticsRoutes = new Hono<AppEnv>()
analyticsRoutes.use('/public/analytics/:name/events', analyticsAuth)

analyticsRoutes.get('/public/analytics/:name/events', withIndex(async ({ pool, index }, c) => {
  const from = c.req.query('from')
  const to = c.req.query('to')
  for (const [label, value] of [['from', from], ['to', to]] as const) {
    if (value !== undefined && Number.isNaN(Date.parse(value))) {
      return apiError(c, 'VALIDATION_ERROR', `${label} must be an ISO 8601 timestamp`)
    }
  }

  const after = c.req.query('after')
  if (after !== undefined && !decodeCursor(after)) {
    return apiError(c, 'VALIDATION_ERROR', 'after must be a cursor from a previous response')
  }

  const limitParam = c.req.query('limit')
  let limit = limitParam ? parseInt(limitParam, 10) : MAX_PULL_LIMIT
  if (isNaN(limit) || limit < 1) return apiError(c, 'VALIDATION_ERROR', 'limit must be a positive integer')
  limit = Math.min(limit, MAX_PULL_LIMIT)

  const result = await pullEvents(pool, index.index_id, { from, to, after, limit })
  return c.json(result, 200)
}))
```

Modify `apps/api/index.ts`:
- Import and mount: `import { analyticsRoutes } from './routes/analytics'` and `app.route('/', analyticsRoutes)` after the `ragRoutes` mount.
- Add `'x-analytics-key'` to the CORS `allowHeaders` array.

- [ ] **Step 7.4: Run to confirm pass**

Run: `pnpm --filter api test -- analytics`
Expected: PASS — all pull tests, including the pagination walk.

Then the full suite:

Run: `pnpm --filter api test`
Expected: all green.

- [ ] **Step 7.5: Commit**

```bash
git add apps/api/services/analytics.ts apps/api/routes/analytics.ts apps/api/index.ts apps/api/test/analytics.test.ts
git commit -m "Add analytics pull endpoint with keyset pagination"
```

---

### Task 8: Documentation

**Files:**
- Create: `docs/analytics.md`
- Modify: `README.md` (docs table + key concepts)

- [ ] **Step 8.1: Write `docs/analytics.md`**

Cover, in the voice and depth of the existing `docs/rag.md`: the event model (one bucket, two row shapes), the capture data fields (`q`, `mode`, `kinds`, `limit`, `total`, `result_ids`), the postback contract with a curl example, the pull endpoint with cursor semantics and the half-open date range, key minting/revocation curl examples, and the deferred-retention note (S3 export path). Keep it under ~120 lines.

- [ ] **Step 8.2: Update `README.md`**

- Add a row to the documentation table: `| [Analytics](docs/analytics.md) | Query logging, click feedback, and raw event export. |`
- Add a key-concepts bullet for **Event** mirroring the existing bullet style: queries are logged with a returned `query_id`; consumers post feedback actions against it; index owners pull raw events with the `x-analytics-key`.

- [ ] **Step 8.3: Commit**

```bash
git add docs/analytics.md README.md
git commit -m "Document the analytics event loop"
```

---

### Task 9: Finish

- [ ] **Step 9.1:** Run the full suite one last time: `pnpm --filter api test` — all green, pristine output.
- [ ] **Step 9.2:** Use superpowers:finishing-a-development-branch to decide merge/PR handling with Darren.
