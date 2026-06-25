# Index State Export Design

## Problem

pgsearch is write-through: consumers `POST` documents and `DELETE` them by `external_id`, but the index is otherwise opaque. A consumer that crawls an upstream source — phila.gov services/programs, an S3 bucket, a CMS — has no way to ask "what does the index currently hold?" That gap blocks the half of sync that ingest can't cover: **deletions**. When an article is removed upstream, nothing tells the index to drop it, so it lingers in search results indefinitely. The 311-KB spec already flagged this as deferred work — *"list upstream ids, compare with indexed ids, delete the difference"* (specs/2026-04-13-311-kb-index-design.md).

Sync is the consumer's responsibility. The service's responsibility is to **expose current index state** so the consumer can run that reconciliation. The minimal state a consumer needs is the set of `external_id`s present, plus enough per-document signal to decide what is stale and what is gone.

## Goals

- Expose the current state of an index — `external_id`, `updated_at`, and `metadata` per document — through the existing multi-tenant, index-key-gated surface.
- Cover both halves of sync: **deletion reconciliation** (the set of `external_id`s) and **staleness detection** (a per-document change signal).
- Stay safely within the platform's response envelope at the project's target scale (up to 100K documents/index) without a confusing failure mode at the ceiling.
- Add no new index, no new table, no schema migration. The data and the access path already exist.
- Keep the consumer in control of sync policy. The service reports state; it does not diff, decide, or push.

## Non-Goals (v1)

- **Response streaming / NDJSON.** The service runs on Lambda behind API Gateway REST v1 (docs/architecture.md:8), which buffers the entire integration response and caps it at a hard 10MB. `hono/aws-lambda`'s `handle` buffers too. Streaming would change nothing end-to-end here and would require the same `HttpApi` / `streamifyResponse` / upstream `LambdaPostgresApi` change the RAG spec deferred (specs/2026-05-18-rag-endpoint-design.md:20). Pagination solves the size problem without any of that.
- **A stored or pre-generated manifest artifact.** A persisted manifest is a cache: it adds a staleness problem and a storage/lifecycle problem we don't have. The endpoint generates state on request, straight from `search_documents`. The endpoint *is* the manifest.
- **Server-side diffing or deletion.** The service returns state; the consumer compares against its own source of truth and issues `DELETE`s through the existing endpoint. No "delete everything not in this list" bulk operation — too sharp an edge to expose.
- **Push / webhooks / change feeds.** Consumers poll on their own cadence. No subscription model.
- **A document-content read API.** This exposes index *state* (ids + metadata + timestamp), not document bodies or segments. Retrieving full content is what search is for.
- **Cross-index export.** Single-index only, matching the rest of the service.
- **Exposing the internal segment content hash.** It exists for ingest idempotency (embed-cost avoidance), not as a consumer-facing contract. See Tradeoffs.

## Architecture

```
GET /public/index/:name/documents?limit=<N>&after=<external_id>
  e.g. GET /public/index/phila-services-programs/documents?limit=1000
  ├─ auth: x-index-key (same gate as ingest/delete/prompts)
  ├─ keyset query:
  │     SELECT external_id, updated_at, metadata
  │     FROM search_documents
  │     WHERE index_id = $1 AND ($2::text IS NULL OR external_id > $2)
  │     ORDER BY external_id ASC
  │     LIMIT $3
  ├─ served by the existing UNIQUE (index_id, external_id) btree — index range scan, no sort node
  └─ return { documents: [{ external_id, updated_at, metadata }], next_cursor }
```

All other routes unchanged. No schema change.

## Why Pagination, Not a Single Dump

The platform forces the decision. A full-index response must fit under API Gateway's hard 10MB cap, and the cap is non-configurable on REST v1.

| Per-doc serialized size | Docs before 10MB cap |
|---|---|
| ~400 B (sparse metadata) | ~26,000 |
| ~1–2 KB (rich metadata, e.g. S3 ETag + consumer fields) | ~5,000–10,000 |

phila.gov today is likely under that, but the project's stated target ceiling is 100K documents/index (README.md:6) — 4–20× over the cap depending on metadata weight. An unpaginated dump would work in dev and then fail in production at scale with an opaque 502, not a clean error. Pagination makes the size of any single response a function of `limit`, not of index size, so the endpoint is correct at 1K docs and at 100K docs with no redesign.

### Keyset, not offset

Pagination is **keyset** (cursor on `external_id`), never offset:

- **Correctness under concurrent writes.** Offset pagination skips or duplicates rows when documents are inserted or deleted mid-walk. Keyset on an immutable unique key does not.
- **Efficiency.** `OFFSET n` scans and discards `n` rows per page — O(n²) over a full walk. Keyset seeks directly via the btree — O(log n) per page.
- **The index already exists.** `UNIQUE (index_id, external_id)` (schema.sql) creates a btree on `(index_id, external_id)` in exactly the order `WHERE index_id=$1 AND external_id > $after ORDER BY external_id` needs. No new index, no migration.

`external_id` is the right cursor key specifically because it is **unique and immutable** — it's the `ON CONFLICT` target in the ingest upsert (services/ingest.ts), so it never changes for a given document. Ordering is alphabetical (it's typically a URL); that's irrelevant to correctness, because keyset pagination needs only a *stable total order*, not a semantically meaningful or monotonic one. `document_id` is a random `gen_random_uuid()` and would also be unique, but carries no benefit over `external_id` and isn't the column we filter on.

Ordering by a *mutable* column (e.g. `updated_at`) would be a bug: a row updated mid-walk would change position and be skipped or repeated. `updated_at` is carried as payload, never as the sort key.

## Data Model

No changes. Every field returned already exists on `search_documents`:

| Column | Type | Role in export |
|--------|------|----------------|
| `external_id` | `TEXT` | The consumer's stable id; the set of these drives deletion reconciliation. Also the cursor key. |
| `updated_at` | `TIMESTAMPTZ` | Service-side change signal — bumped on every upsert (services/ingest.ts). |
| `metadata` | `JSONB` | The consumer's own change channel — see below. |

### Two change signals, two purposes

The export carries two independent ways to detect staleness, and they answer different questions:

- **`updated_at`** answers *"when did the index last write this document?"* It's free, always present, and bumped by the upsert. Good for "has the index seen my latest push."
- **`metadata`** answers *"is the index's copy current against the upstream source?"* — but only because the consumer put a fingerprint there. Example: a consumer iterating S3 objects stores each object's **ETag** in `metadata` at ingest. On the next sync it lists the bucket, compares live ETags against the exported `metadata.etag`, and re-ingests only what changed — doc-level change detection for free, computed by the consumer's own pipeline at the consumer's own granularity, with zero coupling to how pgsearch chunks or transforms content.

This is why the export returns the **full** `metadata` blob rather than a service-chosen subset: the service can't predict which field the consumer will lean on. `metadata` is small JSONB, so the cost is low and the flexibility is the point.

The internal per-segment SHA256 (services/ingest.ts) is deliberately **not** exposed. It guards embed costs during ingest; surfacing it would invite consumers to couple to our chunking, the opposite of what the metadata channel is for.

## HTTP Route

Added to `apps/api/routes/ingest.ts`, under the same `x-index-key` gate as the existing document write/delete routes — the team that owns the index owns its state.

```
GET /public/index/:name/documents?limit=<N>&after=<external_id>
Headers: x-index-key: <index key>
```

Query parameters:

| Param | Required | Default | Bounds | Notes |
|-------|----------|---------|--------|-------|
| `limit` | no | `1000` | `1`–`5000` | Page size. Default ~2MB at 2KB/doc — comfortable headroom under the 10MB cap. Max 5000 stays under even with heavy metadata. Out-of-range values are clamped, not rejected. |
| `after` | no | — | — | Exclusive lower bound: return documents with `external_id > after`. Omitted on the first page. |

`GET` (not `POST`): the request carries no body, only the cursor in the query string. `x-index-key` is already in the CORS `allowHeaders` (used by ingest), so no `apps/api/index.ts` CORS change is needed.

## Response Shape

```json
{
  "documents": [
    {
      "external_id": "apply-for-a-parking-permit",
      "updated_at": "2026-06-20T14:03:11.482Z",
      "metadata": { "etag": "\"9b2cf5...\"", "source": "phila.gov", "section": "services" }
    },
    {
      "external_id": "veterans-benefits",
      "updated_at": "2026-06-22T09:11:40.118Z",
      "metadata": { "etag": "\"1ad44e...\"" }
    }
  ],
  "next_cursor": "veterans-benefits"
}
```

- **`documents`** — one entry per document in this page, ordered by `external_id` ascending. `metadata` is returned verbatim as stored.
- **`next_cursor`** — the `external_id` to pass as `after` for the next page, or `null` when the walk is complete. Termination rule: if the page returned exactly `limit` rows, `next_cursor` is the last row's `external_id`; otherwise `null`. A consumer loops, passing `next_cursor` back as `after`, until it receives `null`.

Worst case, an index whose size is an exact multiple of `limit` costs one extra request that returns an empty `documents` array and `next_cursor: null`. Standard keyset behavior; cheap and unambiguous.

## Consumer Reconciliation Flow

The reference flow the export is built to serve (entirely consumer-side):

1. Page through `GET …/documents` accumulating `{ external_id → { updated_at, metadata } }` until `next_cursor` is `null`.
2. **Deletions:** `indexed_ids − upstream_ids` → `DELETE /public/index/:name/documents/:external_id` for each.
3. **Staleness:** for each id in both sets, compare the consumer's fingerprint (e.g. live S3 ETag) against exported `metadata.etag` (or `updated_at`); re-`POST` the changed ones. Ingest's diff-based embedding means unchanged segments aren't re-embedded, so over-calling ingest is cheap but avoidable.
4. **Additions:** `upstream_ids − indexed_ids` → `POST` as normal.

The service participates only in steps that already exist (`GET` state, `POST`/`DELETE` documents). It owns no part of the comparison.

## Documented Tradeoffs

- **Consistent walk, not a point-in-time snapshot.** Keyset pagination guarantees each row is visited at most once in `external_id` order, but the walk spans many requests over wall-clock time. A document inserted with an `external_id` *below* where the cursor has already passed won't appear until the next sync run. For deletion reconciliation this is benign: a brand-new document is invisible for at most one cycle, and is never wrongly deleted (it simply isn't in the export yet, and the consumer's upstream set knows it's new). True snapshot semantics would require wrapping the whole multi-request walk in one long-lived transaction — incompatible with stateless Lambda invocations and not worth it.
- **Pagination is mandatory, not optional.** Driven by the 10MB REST API cap, not preference. The upside: the keyset design is load-bearing from v1, and because the `UNIQUE` constraint already supplies the btree, it costs no schema change.
- **Streaming is dropped, not deferred-with-intent.** On this platform NDJSON streaming buys nothing — the response is buffered and capped regardless. Revisiting it only makes sense bundled with a broader move to `HttpApi` + response streaming (same prerequisite the RAG spec named), and only if some future need actually wants progressive transfer. Pagination is the correct answer for bulk state export specifically.
- **Full `metadata` returned, by design.** The service can't know which field a consumer uses for change detection, so it returns the whole blob rather than guessing a subset. Cost is low (small JSONB); flexibility is the entire point of the metadata channel.
- **Internal segment hash stays internal.** It's an ingest idempotency mechanism, not a sync contract. `updated_at` + consumer-owned `metadata` cover staleness without coupling consumers to our chunking.
- **Text collation.** Ordering and the `> after` comparison both use `external_id`'s column collation, so a single walk is internally self-consistent. The only theoretical break is a glibc collation-version change mid-walk — a general Postgres operational concern, not specific to this endpoint. If byte-deterministic ordering ever becomes a hard requirement, the comparison and `ORDER BY` can be pinned with `COLLATE "C"`. Flagged, not acted on.

## Testing

Tests run on a live PostgreSQL container (docker-compose.test.yml, vitest), consistent with existing integration tests — no mocked DB behavior.

1. **Empty index.** `GET …/documents` on an index with no documents returns `{ documents: [], next_cursor: null }`.
2. **Single page.** Fewer than `limit` documents returns them all, ordered by `external_id` ascending, with `next_cursor: null`.
3. **Multi-page walk.** Seed more than `limit` documents (use a small `limit`, e.g. 2). Walk with the returned `next_cursor` until `null`; assert every seeded `external_id` is visited exactly once and order is strictly ascending across page boundaries.
4. **Exact-multiple boundary.** Seed exactly `2 * limit` documents; assert the walk terminates with a final empty page and `next_cursor: null`, and no id is missed or duplicated.
5. **`after` cursor semantics.** An explicit `after` returns only `external_id > after` (exclusive bound verified).
6. **Payload fields.** `updated_at` and full `metadata` are returned verbatim; a document with non-trivial nested `metadata` round-trips intact.
7. **Limit clamping.** `limit=0`, negative, non-numeric, and `limit` above max all clamp into `[1, 5000]` rather than erroring.
8. **Index isolation.** Documents from a different index never appear; the `WHERE index_id` scoping holds across the cursor.
9. **Auth gating.** Missing/invalid `x-index-key` returns 401; the wrong index's key does not read another index's state.

## Open Questions / Future Work

- **Filtered export.** A `?metadata.<key>=<value>` filter (e.g. only one upstream section) could narrow large reconciliations. Out of v1; add when a consumer needs it.
- **Count endpoint.** A cheap `HEAD`/count so consumers can size a sync before walking. `search_indexes.total_documents` already tracks this; a thin read could expose it later.
- **Snapshot consistency.** If a consumer ever needs exactly-as-of-T semantics, revisit transaction-wrapped export or a logical-snapshot mechanism. Not needed for reconciliation.
- **Streaming bulk export.** Only relevant if the service moves to `HttpApi` + response streaming for other reasons (e.g. RAG). Would let a single call walk the whole index; pagination remains the fallback.
