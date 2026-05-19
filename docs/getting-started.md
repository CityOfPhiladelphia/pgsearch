<!-- ABOUTME: Step-by-step guide for engineers integrating pgsearch into a service. -->
<!-- ABOUTME: Covers index creation, document ingestion, refresh, and search via curl and the client SDK.  -->

# Getting Started with pgsearch

This guide walks you through integrating pgsearch into a service. You'll create an index, ingest documents, and run a search query.

## Prerequisites

- Node.js 20+
- AWS CLI configured with SSO
- Access to a deployed pgsearch instance: an API base URL and an admin API key

## Step 1: Create an index

```bash
curl -X POST https://<api-url>/private/key/admin/indexes \
  -H "x-api-key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-index"}'
```

Response:

```json
{
  "name": "my-index",
  "index_key": "idx_...",
  "search_key": "srch_...",
  "created_at": "2026-04-10T..."
}
```

Save both keys from the response:

- `index_key` — used to write documents to this index
- `search_key` — used to query this index

The default configuration is tuned for English content. You can pass a `config` object at creation time to override defaults. See [docs/search.md](search.md) for all tuning parameters.

## Step 2: Ingest a document

```bash
curl -X POST https://<api-url>/public/index/my-index/documents \
  -H "x-index-key: $INDEX_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "external_id": "page-001",
    "title": "Apply for a Parking Permit",
    "body": "You can apply for a residential parking permit online...",
    "metadata": {"source_url": "https://example.com/parking", "content_type": "services"}
  }'
```

Response:

```json
{
  "external_id": "page-001",
  "segments": 3,
  "changed": 3,
  "unchanged": 0,
  "status": "indexed"
}
```

- `external_id` is your unique key for this document. Re-ingesting the same `external_id` performs an upsert — only segments that have changed are re-embedded, so re-ingestion is cheap.
- `body` accepts plain text or markdown.
- `metadata` is arbitrary JSON that is stored and returned with search results unchanged.

See [docs/ingestion.md](ingestion.md) for details on how documents are chunked and which parse library is used.

## Step 3: Refresh the index

```bash
curl -X POST https://<api-url>/private/key/admin/indexes/my-index/refresh \
  -H "x-api-key: $ADMIN_KEY"
```

Response:

```json
{"status": "refreshed"}
```

Refresh materializes the term frequency statistics used by BM25F scoring. You don't need to run it after every document — run it once after a bulk ingestion batch.

An auto-refresh triggers automatically when `refresh_threshold` (default: 100) documents have changed since the last refresh.

## Step 4: Search

```bash
curl "https://<api-url>/public/search/my-index?q=parking+permit&limit=10" \
  -H "x-search-key: $SEARCH_KEY"
```

Response:

```json
{
  "results": [
    {
      "external_id": "page-001",
      "score": 0.033,
      "title": "Apply for a Parking Permit",
      "snippet": "You can apply for a residential parking permit online...",
      "metadata": {"source_url": "https://example.com/parking", "content_type": "services"}
    }
  ],
  "total": 1,
  "query": "parking permit"
}
```

- `score` is a rank-based combination of keyword relevance (BM25F) and semantic similarity (vector) using Reciprocal Rank Fusion.
- `snippet` is the best-matching segment from the document.
- `total` is the count of unique matching documents before the `limit` is applied — not the length of `results`.

See [docs/search.md](search.md) for how scoring works and how to tune it.

## Using the client SDK

```typescript
import { PgsearchClient } from '@phila/pgsearch-client'

const client = new PgsearchClient({
  baseUrl: 'https://<api-url>',
  adminKey: process.env.ADMIN_KEY,
})

// Create an index
const { index_key, search_key } = await client.createIndex({ name: 'my-index' })

// Ingest a document
await client.ingest('my-index', {
  external_id: 'page-001',
  title: 'Apply for a Parking Permit',
  body: 'You can apply for a residential parking permit online...',
  metadata: { source_url: 'https://example.com/parking' },
}, index_key)

// Refresh after bulk ingestion
await client.refreshIndex('my-index')

// Search
const results = await client.search('my-index', 'parking permit', search_key, { limit: 10 })
```

The SDK uses shorter paths than the raw API (e.g., `/search/:name` instead of `/public/search/:name`). Set `baseUrl` to include any gateway stage prefix so the SDK's paths resolve correctly.
