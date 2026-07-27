# Search Analytics Design

## Problem

pgsearch answers queries but records nothing about them. Consumers have no way to see what users search for, what results they get, or which results they pick — the raw material for CTR analysis, zero-result detection, and relevance tuning (the Swiftype click-truth eval had to be reconstructed from an external system). The service needs a lightweight capture-and-pull analytics loop: log each query, accept click/feedback postbacks from consumers, and let index owners pull their raw event data.

## Goals

- Log every search query with enough context to compute CTR and zero-click rates later: the query, its parameters, and the ordered result list.
- Return a `query_id` in the search response so consumers can post feedback events (clicks, selections) tied to the originating query.
- One generic event bucket. The engine defines the `search` capture row; consumers define their own `action` vocabulary and `data` payloads. No schema change per new event type.
- A pull endpoint for index owners: raw events by index and date range, keyset-paginated.
- A per-index `analytics_key`, following the existing key-per-capability pattern (`index_key`, `search_key`, `rag_key`).
- Analytics must never break search: a failed log insert degrades to a response without `query_id`, not a failed query.

## Non-Goals (v1)

- Aggregation, rollups, or computed metrics (CTR, top queries). Consumers compute from raw rows. Adding server-side aggregates later is additive.
- Retention / purging. The table grows unboundedly for now. When volume demands it, the designated path is `aws_s3.query_export_to_s3()` (available on Aurora PostgreSQL) — periodic export of old rows to S3 plus delete, archive and purge in one mechanism, no schema change. Per-row Lambda invocation via the `aws_lambda` extension was considered and rejected as disproportionate.
- RAG query logging. The schema accommodates it (another insert site in the RAG route); deferred until wanted.
- Deduplication, sessionization, user/visitor identity. Consumers can carry identity in event `data` if they want it.
- Rate limiting on the feedback endpoint. The search key gates it; revisit if abused.

## Architecture

```
GET /public/search/:name?q=...          (existing, x-search-key)
  ├─ hybridSearch(...) → { results, total, query }
  ├─ INSERT search_events (action='search', data={q, mode, kinds, limit, total, result_ids}) RETURNING event_id
  │    └─ on insert failure: log, omit query_id, still return results
  └─ return { query_id, results, total, query }

POST /public/search/:name/events        (new, x-search-key)
  body: { query_id, action, data? }
  ├─ INSERT ... SELECT from the parent row (WHERE event_id = query_id AND index_id = current index)
  │    └─ zero rows inserted → 404 (unknown query_id or wrong index — indistinguishable by design)
  └─ 201 { event_id }

GET /public/analytics/:name/events      (new, x-analytics-key)
  ?from&to&after&limit
  └─ flat event rows, keyset-paginated on (created_at, event_id)
```

## Data Model

### `search_events` (new)

```sql
CREATE TABLE search_events (
    event_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    index_id    INTEGER NOT NULL REFERENCES search_indexes(index_id) ON DELETE CASCADE,
    query_id    UUID REFERENCES search_events(event_id) ON DELETE CASCADE,
    action      TEXT NOT NULL,
    data        JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_events_index_created ON search_events (index_id, created_at, event_id);
CREATE INDEX idx_events_query ON search_events (query_id);
```

One table, two row shapes distinguished by `query_id`:

- **Query rows** — written by the search route. `query_id IS NULL`, `action = 'search'`, `data = {q, mode, kinds, limit, total, result_ids}` where `result_ids` is the ordered array of returned `external_id`s. `q` lives in `data`, not a column; `data->>'q'` with an expression index is the upgrade path if a query pattern demands it.
- **Feedback rows** — written by the postback endpoint. `query_id` self-references the query row. `action` and `data` are consumer-defined (e.g. `action='selected'`, `data={external_id, rank}`).

`action` is freeform like `kind` — the engine defines no vocabulary beyond its own `'search'`. Validation caps: `action` ≤ 64 chars, serialized `data` ≤ 4KB.

`idx_events_query` exists so the self-referencing FK does not force table scans on future deletes (retention purge).

Ships as a change-set migration (next version after current head) per the existing baseline-plus-deltas scheme in `db/migrations.ts`.

### `search_indexes` (modified)

| Column | Type | Notes |
|--------|------|-------|
| `analytics_key_hash` | `TEXT NULL` | Null = analytics pull disabled. Lazy-minted via admin endpoint, exactly the `rag_key_hash` pattern. |

No backfill needed — `NULL` is the disabled state.

## API Surface

### Search response (modified)

`GET /public/search/:name` response gains a top-level `query_id` (UUID string). Existing fields unchanged. If the log insert fails, `query_id` is absent and the search succeeds anyway.

### Feedback postback (new)

`POST /public/search/:name/events`, behind existing `searchAuth` (the browser already holds the search key; the unguessable `query_id` plus the parent-row check keeps junk out).

Request body:

```json
{ "query_id": "<uuid>", "action": "selected", "data": { "external_id": "page-1", "rank": 3 } }
```

- `query_id` required, must be a UUID; `action` required, ≤ 64 chars; `data` optional object, ≤ 4KB serialized.
- Insert is a single `INSERT ... SELECT` copying `index_id` from the parent row where `event_id = query_id AND index_id = <authenticated index> AND query_id IS NULL` — the parent must be a query row, so feedback cannot chain to feedback. Zero rows inserted → `404 NOT_FOUND`. This makes existence check and cross-index rejection one statement — a `query_id` from index A posted with index B's search key is a 404, with no FK-violation error mapping.
- Success: `201 { event_id }`.

### Analytics pull (new)

`GET /public/analytics/:name/events?from=<iso>&to=<iso>&after=<cursor>&limit=<n>`, behind new `analyticsAuth` middleware (`x-analytics-key` → `analytics_key_hash`) — one union-member and one exported const added to the existing `keyAuth` factory in `middleware/auth.ts`.

- `from`/`to` optional ISO 8601 timestamps filtering `created_at`, half-open: `created_at >= from AND created_at < to`.
- Keyset pagination on `(created_at, event_id)`: `limit` defaults to 500, max 500; response includes `next` cursor (opaque encoding of the last row's `created_at` + `event_id`) when more rows exist. Offset pagination is excluded: API Gateway REST v1 buffers responses with a 10MB cap, so unbounded pages are not an option.
- Returns flat rows — query rows and feedback rows interleaved in `created_at` order; consumers group by `query_id` client-side. No server-side nesting: flat rows keep pagination trivial (no parent/child straddling page boundaries) and make single-action pulls ("all `selected` events this month") the same endpoint.

Row shape: `{ event_id, query_id, action, data, created_at }` (`index_id` omitted — it is the route's `:name`).

### Admin key management (new)

Mirrors `rag-key` exactly:

- `POST /private/key/admin/indexes/:name/analytics-key` → `201 { analytics_key: "anly_..." }` (mints/rotates via existing `mintKey`)
- `DELETE /private/key/admin/indexes/:name/analytics-key` → `{ revoked: true }` (via existing `revokeKey`)

Key prefix `anly_`, generated by the existing `generateKey`/`hashKey` helpers.

## Error Handling

- Log-insert failure during search: caught, logged to console (Lambda → CloudWatch), response returned without `query_id`. Search never fails because of analytics.
- Feedback postback: standard `VALIDATION_ERROR` (400) for malformed body / oversize payloads; `404 NOT_FOUND` for unknown or cross-index `query_id`; `401` from `searchAuth` as today.
- Analytics pull: `VALIDATION_ERROR` for unparseable `from`/`to`/`after`/`limit`; `401` when `analytics_key_hash` is null or the key is wrong (same collapsed-401 behavior as `rag_key`).

## Testing

TDD throughout, real database (existing docker-compose test harness), no mocks:

- **Migration**: new table + column exist after migrate; idempotent re-run.
- **Capture**: a search inserts one `action='search'` row with `q`, params, `total`, ordered `result_ids` in `data`; response carries a `query_id` matching the row.
- **Capture degradation**: insert failure (e.g. table dropped mid-test) still returns search results, without `query_id`, with the error captured and asserted in output.
- **Feedback**: valid postback inserts a row copying the parent's `index_id` and returns `201 { event_id }`; unknown `query_id` → 404; `query_id` belonging to another index → 404; missing/long `action` → 400; oversize `data` → 400; missing search key → 401.
- **Pull**: date-range filter; keyset pagination walks all rows exactly once across pages; limit clamped at 500; flat rows include both row shapes; no analytics key minted (null hash) → 401; wrong key → 401.
- **Admin**: mint returns `anly_`-prefixed key that then authenticates the pull route; revoke → subsequent pulls 401; mint on missing index → 404.
