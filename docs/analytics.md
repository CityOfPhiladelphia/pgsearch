<!-- ABOUTME: Guide to the analytics event log — query capture, feedback postbacks, raw event export. -->
<!-- ABOUTME: Covers the event model, the postback and pull contracts, and key management. -->

# Analytics

Every search is logged as an event, and consumers can post feedback against it (a click, a dismissal, anything with a name). Index owners pull the raw event log for their own aggregation — pgsearch does no rollups or dashboards of its own.

## Key concepts

- **Event** — a row in the single `search_events` table. Two shapes share the bucket: query rows (`action='search'`, `query_id` null) written automatically by search, and feedback rows (consumer-defined `action`, `query_id` pointing back at the query row they respond to). Feedback cannot chain to feedback — the parent must itself be a query row.
- **Query ID** — returned to the caller as `query_id` on a successful search. It's the event_id of the query row, and the handle consumers post feedback against.
- **Analytics key** — `x-analytics-key`, minted lazily by admin per index. Gates the pull endpoint. Separate from `x-search-key`, which only lets you search and post feedback — it can't read the event log back.

## Query capture

Every `GET /public/search/:name` call logs a query row: `q`, `mode`, `kinds`, `limit`, `total`, and `result_ids` (the returned result order, by `external_id`). The response carries a `query_id` alongside the normal search response body:

```json
{
  "query_id": "3fa2c1a0-1e2d-4b3a-9c5e-1234567890ab",
  "query": "parking permit",
  "total": 8,
  "results": [ { "external_id": "page-1", "score": 0.83, "...": "..." } ]
}
```

Capture is best-effort: if the insert fails, the response is returned without `query_id` and the failure is logged server-side. Search never fails because of an analytics write.

## Post feedback

```bash
curl -X POST https://<api-url>/public/search/my-index/events \
  -H "x-search-key: $SEARCH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query_id": "3fa2c1a0-1e2d-4b3a-9c5e-1234567890ab",
    "action": "click",
    "data": { "external_id": "page-1", "position": 1 }
  }'
# → 201 {"event_id":"..."}
```

- `query_id` must be a UUID; `action` is required, non-empty, and capped at 64 characters; `data` is optional and capped at 4KB of serialized JSON.
- The parent `query_id` must belong to the authenticated index and must itself be a query row. An unknown ID, a query_id from another index, and a query_id that's actually a feedback row all return the same `404 NOT_FOUND` — the endpoint doesn't distinguish them, so it can't leak whether an ID exists elsewhere.

## Pull events

```bash
curl "https://<api-url>/public/analytics/my-index/events?from=2026-07-01T00:00:00Z&to=2026-07-02T00:00:00Z&limit=200" \
  -H "x-analytics-key: $ANALYTICS_KEY"
```

```json
{
  "events": [
    { "event_id": "...", "query_id": null, "action": "search", "data": { "q": "parking permit", "...": "..." }, "created_at": "2026-07-01T12:03:04.123Z" },
    { "event_id": "...", "query_id": "3fa2c1a0-...", "action": "click", "data": { "external_id": "page-1" }, "created_at": "2026-07-01T12:03:09.881Z" }
  ],
  "next": "WyIyMDI2LTA3…"
}
```

- `from`/`to` bound a half-open ISO 8601 range (`created_at >= from`, `created_at < to`); both are optional.
- `after` is the opaque cursor from a previous response's `next`; pass it back verbatim to continue. Malformed cursors are rejected as a `400 VALIDATION_ERROR`.
- `limit` defaults to 500 and is clamped to a maximum of 500.
- Rows are flat and ungrouped — query rows and feedback rows come back interleaved in `created_at, event_id` order. Consumers group feedback under its query by matching `query_id` back to the query row's `event_id` client-side.

## Key management

Same pattern as the RAG key: minted lazily, revoked by nulling the stored hash.

```bash
# Mint (or rotate) the analytics key
curl -X POST https://<api-url>/private/key/admin/indexes/my-index/analytics-key \
  -H "x-api-key: $ADMIN_KEY"
# → 201 {"analytics_key":"anly_..."}

# Revoke
curl -X DELETE https://<api-url>/private/key/admin/indexes/my-index/analytics-key \
  -H "x-api-key: $ADMIN_KEY"
# → {"revoked":true}
```

A null hash disables the key: the pull endpoint returns `401 UNAUTHORIZED` until a new one is minted. Rotating overwrites the previous key — only the plaintext returned at mint time is ever shown.

## Retention

`search_events` has no automatic retention — it grows unboundedly. When volume demands it, the designated path is Aurora's `aws_s3.query_export_to_s3()`: periodic export of old rows to S3 followed by delete, archiving and purging in one mechanism with no schema change.
