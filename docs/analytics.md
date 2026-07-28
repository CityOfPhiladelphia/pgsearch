<!-- ABOUTME: Guide to the analytics event log — query capture, feedback postbacks, raw event export. -->
<!-- ABOUTME: Covers the event model, the postback and pull contracts, and key management. -->

# Analytics

Every search is logged as an event, and consumers can post feedback against it (a click, a dismissal, anything with a name). Index owners pull the raw event log for their own aggregation — pgsearch does no rollups or dashboards of its own.

The engine defines only the `search` action; your `action` names and `data` payloads are stored and returned verbatim, never interpreted. That's what keeps the surface small: adding a new event type to your frontend is a naming decision, not a schema change or an API request.

## Key concepts

- **Event** — a row in the single `events` table. Two shapes share the bucket: anchor rows (`action='search'`, `group_id` equal to their own `event_id`) written automatically by search, and feedback rows (consumer-defined `action`, carrying the anchor's `group_id`). Events can only join a group at its anchor — feedback cannot chain to feedback.
- **Group ID** — returned to the caller as `group_id` on a successful search. It's the anchor event's id, and every event from that interaction shares it; timestamps sequence the events within a group.
- **Analytics key** — `x-analytics-key`, minted lazily by admin per index. Gates the pull endpoint. Separate from `x-search-key`, which only lets you search and post feedback — it can't read the event log back.

## Query capture

Every `GET /public/search/:name` call logs an anchor event: `q`, `mode`, `kinds`, `limit`, `total`, and `result_ids` (the returned result order, by `external_id`). The response carries a `group_id` alongside the normal search response body:

```json
{
  "group_id": "3fa2c1a0-1e2d-4b3a-9c5e-1234567890ab",
  "query": "parking permit",
  "total": 8,
  "results": [ { "external_id": "page-1", "score": 0.83, "...": "..." } ]
}
```

Capture is best-effort: if the insert fails, the response is returned without `group_id` and the failure is logged server-side. Search never fails because of an analytics write.

The caller's half of that bargain: treat `group_id` as optional. When it's absent, that interaction simply can't take feedback — skip the postback rather than queueing or retrying it. Nothing server-side references the interaction, so there's nothing to attach feedback to later.

## Post feedback

```bash
curl -X POST https://<api-url>/public/search/my-index/events \
  -H "x-search-key: $SEARCH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "group_id": "3fa2c1a0-1e2d-4b3a-9c5e-1234567890ab",
    "action": "click",
    "data": { "external_id": "page-1", "position": 1 }
  }'
# → 201 {"event_id":"..."}
```

- `action` is required, non-empty, and capped at 64 characters; `data` is optional and capped at 4KB of serialized JSON.
- The `group_id` must reference an anchor event in the authenticated index. An unknown ID, a malformed one, a group_id from another index, and a group_id that's actually a feedback row all return the same `404 NOT_FOUND` — the endpoint doesn't distinguish them, so it can't leak whether an ID exists elsewhere.

## Pull events

```bash
curl "https://<api-url>/public/analytics/my-index/events?from=2026-07-01T00:00:00Z&to=2026-07-02T00:00:00Z&limit=200" \
  -H "x-analytics-key: $ANALYTICS_KEY"
```

```json
{
  "events": [
    { "event_id": "3fa2c1a0-...", "group_id": "3fa2c1a0-...", "action": "search", "data": { "q": "parking permit", "...": "..." }, "created_at": "2026-07-01T12:03:04.123Z" },
    { "event_id": "8c41d7b2-...", "group_id": "3fa2c1a0-...", "action": "click", "data": { "external_id": "page-1" }, "created_at": "2026-07-01T12:03:09.881Z" }
  ],
  "next": "WyIyMDI2LTA3…"
}
```

- `from`/`to` bound a half-open range (`created_at >= from`, `created_at < to`); both are optional. Postgres parses them, so anything it reads as a timestamp works — `2026-07-01`, full ISO 8601, or relative strings like `yesterday`; unreadable values are a `400 VALIDATION_ERROR`.
- `after` is the opaque cursor from a previous response's `next`; pass it back verbatim to continue. Malformed cursors are rejected as a `400 VALIDATION_ERROR`.
- `limit` defaults to 500 and is clamped to a maximum of 500 — API Gateway buffers whole responses under a hard 10MB cap, so page size is bounded where the platform bounds it, not where your patience does.
- Rows are flat — anchor and feedback rows come back interleaved in `created_at, event_id` order. Consumers reassemble interactions by grouping on `group_id`; anchors are the rows where `group_id` equals `event_id`.

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

`events` has no automatic retention — it grows unboundedly. When volume demands it, the designated path is Aurora's `aws_s3.query_export_to_s3()`: periodic export of old rows to S3 followed by delete, archiving and purging in one mechanism with no schema change.

One stewardship note: anchor events store raw user query text, verbatim. Pulling events transfers custody of that data to you — apply your own retention and handling policies to what you export, the same as you would to any log containing user input.
