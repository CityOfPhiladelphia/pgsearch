# pgsearch — Hybrid Search Service Design

## Overview

pgsearch is a PostgreSQL-backed hybrid search microservice that combines BM25F keyword scoring with vector similarity search. It replaces OpenSearch with a simpler operational model while maintaining equivalent relevance quality at municipal document scale (tens to hundreds of thousands of documents per index).

The service is multi-tenant by design, supporting multiple independent search indexes (e.g., phila.gov English pages, phila.gov Spanish pages, 311 knowledge base articles) through a single schema with per-index configuration and authentication.

## Goals

- Consolidate keyword and semantic search into a single PostgreSQL service (Aurora PostgreSQL)
- Provide a shared search microservice that municipal developers can adopt with minimal integration effort
- Support multiple languages via per-index configuration (text search config, embedding model)
- Maintain clean separation between search infrastructure and content parsing/crawling
- Reduce operational overhead compared to OpenSearch (no cluster management, shard tuning, JVM config)

## Non-Goals

- Content crawling (separate service)
- Document format parsing (companion library, not the service itself)
- Cross-index search (Phase 2+ if needed)
- Metadata facet filtering (Phase 2 — schema supports it, just not indexed yet)
- Full RBAC / user-level auth (per-index keys are sufficient)

---

## Monorepo Structure

```
pgsearch/
├── apps/api/                  # Lambda — all endpoints (search, ingest, admin)
├── packages/client/           # @phila/pgsearch-client — typed HTTP client
├── packages/ingest/           # @phila/search-ingest — content parsers (HTML, text)
├── packages/embeddings/       # Embedding adapters (Bedrock, local ONNX)
├── cdk/                       # AWS CDK infrastructure
├── package.json               # Monorepo workspace root
└── pnpm-workspace.yaml
```

### Package Responsibilities

**apps/api** — The Lambda function. Handles all HTTP endpoints: index management, document ingestion, search queries. Owns the database schema, query pipeline, and ingest pipeline. Calls embedding adapters to generate vectors.

**packages/client** — Typed TypeScript client for the pgsearch API. Municipal developers install this to interact with the service. Handles auth headers, request construction, response typing.

**packages/ingest** — Content parsing utilities. Converts raw HTML, plain text, and other formats into the structured document format that pgsearch accepts (title, body, metadata). Shipped as a convenience — callers can also construct documents directly.

**packages/embeddings** — Pluggable embedding generation. Defines the adapter interface and provides implementations for AWS Bedrock and local ONNX inference. Used internally by the API at ingest time.

---

## Authentication Model

Three tiers of access, using hashed keys stored per-index:

| Tier | Header | Scope | Operations |
|------|--------|-------|------------|
| Admin | `x-api-key` | Global | Create/delete indexes, manage config, trigger refresh |
| Index | `x-index-key` | Single index | Ingest and delete documents |
| Search | `x-search-key` | Single index | Query the index |

- The **admin key** is stored in AWS Secrets Manager (existing pattern from `@phila/constructs`)
- **Index and search keys** are generated when an index is created and returned once in the response. Their hashes (bcrypt or argon2) are stored in the `search_indexes` table.
- Auth lookup: extract index name from URL path → load index row → hash provided key → compare against stored hash.

---

## API Surface

### Admin Endpoints (requires `x-api-key`)

**POST /admin/indexes** — Create a new search index.

Request:
```json
{
  "name": "phila-site-en",
  "description": "Phila.gov English language pages",
  "config": {
    "text_search_config": "english",
    "embedding": {
      "provider": "local",
      "model": "all-MiniLM-L6-v2",
      "dimensions": 384
    },
    "bm25_k1": 1.2,
    "bm25_b": 0.75,
    "field_weights": { "title": 3.0, "body": 1.0 },
    "blend_alpha": 0.6,
    "max_segment_tokens": 500,
    "max_segments_per_document": 100,
    "refresh_threshold": 100
  }
}
```

All `config` fields are optional with sensible defaults. Most callers only provide `name` and `description`.

Response:
```json
{
  "name": "phila-site-en",
  "index_key": "idx_a1b2c3...",
  "search_key": "srch_x9y8z7...",
  "created_at": "2026-04-06T..."
}
```

Keys are returned once at creation time. If lost, admin can regenerate via a key rotation endpoint.

**GET /admin/indexes** — List all indexes with summary stats.

**GET /admin/indexes/:name** — Get index details including config and document count.

**PATCH /admin/indexes/:name** — Update index configuration (BM25 params, blend alpha, etc.).

**DELETE /admin/indexes/:name** — Delete index and all associated documents/segments.

**POST /admin/indexes/:name/refresh** — Manually trigger materialized view refresh for term document frequencies.

### Index Endpoints (requires `x-index-key`)

**POST /index/:name/documents** — Ingest a document (upsert by external_id).

Request:
```json
{
  "external_id": "press-123",
  "title": "City Announces Parks Initiative",
  "body": "The City of Philadelphia is pleased to announce...",
  "metadata": {
    "url": "https://phila.gov/press/parks-initiative",
    "department": "parks-rec",
    "published": "2026-04-01"
  }
}
```

Response:
```json
{
  "external_id": "press-123",
  "segments": 3,
  "changed": 2,
  "unchanged": 1,
  "status": "indexed"
}
```

The response reports how many segments were created/updated vs unchanged, giving callers visibility into whether re-ingests are doing meaningful work.

**DELETE /index/:name/documents/:external_id** — Remove a document and all its segments.

### Search Endpoints (requires `x-search-key`)

**GET /search/:name** — Query an index.

Query parameters:
- `q` (required) — Search query text
- `limit` (optional, default 10) — Max results to return

Response:
```json
{
  "results": [
    {
      "external_id": "page-456",
      "score": 0.847,
      "title": "Parking Permits",
      "snippet": "Apply for a residential parking permit online...",
      "metadata": {
        "url": "https://phila.gov/services/parking-permits",
        "department": "streets"
      }
    }
  ],
  "total": 12,
  "query": "parking permits"
}
```

Results are deduplicated by document — each result represents the best-matching segment from a distinct document.

### Public Endpoints (no auth)

**GET /public/health** — Health check with database connectivity status.

---

## Database Schema

### search_indexes

Index registry with per-index configuration and authentication.

```sql
CREATE TABLE search_indexes (
    index_id            SERIAL PRIMARY KEY,
    name                TEXT UNIQUE NOT NULL,
    description         TEXT,
    config              JSONB NOT NULL DEFAULT '{}',
    index_key_hash      TEXT NOT NULL,
    search_key_hash     TEXT NOT NULL,
    total_documents     INTEGER NOT NULL DEFAULT 0,
    last_refreshed_at   TIMESTAMPTZ,
    docs_changed_since_refresh INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**config** JSONB stores all tuning parameters with application-level defaults:

```json
{
  "text_search_config": "english",
  "embedding": {
    "provider": "local",
    "model": "all-MiniLM-L6-v2",
    "dimensions": 384
  },
  "bm25_k1": 1.2,
  "bm25_b": 0.75,
  "field_weights": { "title": 3.0, "body": 1.0 },
  "blend_alpha": 0.6,
  "max_segment_tokens": 500,
  "max_segments_per_document": 100,
  "refresh_threshold": 100
}
```

### search_documents

Parent document record. One per external_id per index.

```sql
CREATE TABLE search_documents (
    document_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    index_id        INTEGER NOT NULL REFERENCES search_indexes(index_id) ON DELETE CASCADE,
    external_id     TEXT NOT NULL,
    title           TEXT NOT NULL,
    title_tsvector  TSVECTOR,
    title_length    INTEGER NOT NULL DEFAULT 0,
    metadata        JSONB DEFAULT '{}',
    segment_count   INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (index_id, external_id)
);

CREATE INDEX idx_documents_title_tsvector ON search_documents USING GIN (title_tsvector);
CREATE INDEX idx_documents_index_id ON search_documents (index_id);
```

### search_segments

Chunks of document body text. Many-to-one relationship with documents.

```sql
CREATE TABLE search_segments (
    segment_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES search_documents(document_id) ON DELETE CASCADE,
    segment_index   INTEGER NOT NULL,
    body            TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    embedding       VECTOR,  -- dimension set per-index based on embedding model
    body_tsvector   TSVECTOR,
    body_length     INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_segments_body_tsvector ON search_segments USING GIN (body_tsvector);
CREATE INDEX idx_segments_document_id ON search_segments (document_id);
CREATE INDEX idx_segments_embedding ON search_segments USING ivfflat (embedding vector_cosine_ops);
```

### term_document_frequencies (Materialized View)

Precomputed IDF inputs per index, refreshed on threshold or manually.

```sql
CREATE MATERIALIZED VIEW term_document_frequencies AS
SELECT
    d.index_id,
    word AS term,
    ndoc AS document_frequency
FROM search_documents d
JOIN search_segments s ON s.document_id = d.document_id
, LATERAL ts_stat('SELECT body_tsvector FROM search_segments WHERE document_id = ''' || d.document_id || '''')
GROUP BY d.index_id, word
WITH DATA;

CREATE UNIQUE INDEX idx_tdf_pk ON term_document_frequencies (index_id, term);
```

Note: The exact materialized view query will need refinement during implementation to correctly aggregate term frequencies across all segments within each index. The above illustrates intent.

---

## Query Pipeline

Two independent scoring paths, merged and blended.

### Step 1: Parse & Embed Query

- Apply the index's `text_search_config` to produce a `tsquery` from the raw query text
- Generate a query embedding using the index's configured embedding adapter

### Step 2a: BM25F Candidate Retrieval

- Match against `search_segments.body_tsvector` and `search_documents.title_tsvector` via GIN index using `@@ tsquery`
- Limit to ~200 candidate segments by basic `ts_rank`
- Join to parent document for title scoring data

### Step 2b: Vector Candidate Retrieval

- Use pgvector nearest-neighbor query on `search_segments.embedding`
- Retrieve ~200 candidates by cosine similarity to query embedding

### Step 3: Score

For BM25F candidates:
- Compute field-weighted BM25F score using title term frequency (from document), body term frequency (from segment), IDF (from `term_document_frequencies`), and corpus stats (from index)
- Apply field weights (default: title=3.0, body=1.0) and BM25 parameters (k1=1.2, b=0.75)

For vector candidates:
- Cosine similarity between query embedding and segment embedding

### Step 4: Merge, Normalize, Blend

- Union both candidate sets (deduplicate by segment_id)
- Segments appearing in only one path receive a score of 0 for the other path
- Normalize scores within each path using min-max normalization
- Blend: `score = α * bm25f_normalized + (1 - α) * vector_normalized` (α from index config, default 0.6)

### Step 5: Deduplicate & Return

- Group by `document_id`, select the segment with the highest blended score per document
- The selected segment's `body` text becomes the result snippet
- Return top K results ordered by score

### BM25F Scoring Formula

```
score(D, Q) = Σᵢ IDF(qᵢ) · weighted_tf(qᵢ, D)

IDF(q) = ln((N - df(q) + 0.5) / (df(q) + 0.5) + 1)

weighted_tf(q, D) = (tf_combined * (k1 + 1)) / (tf_combined + k1 * (1 - b + b * dl_combined / avgdl_combined))

tf_combined  = w_title * tf_title(q) + w_body * tf_body(q)
dl_combined  = w_title * title_length + w_body * body_length
avgdl_combined = w_title * avg_title_length + w_body * avg_body_length
```

---

## Ingest Pipeline

On `POST /index/:name/documents`:

1. **Validate** — verify index key, validate payload (external_id, title, body required; metadata optional)
2. **Chunk** — split body on paragraph boundaries (`\n\n`) targeting `max_segment_tokens` (default 500). Single paragraphs exceeding the max are split on sentence boundaries (`. ` / `? ` / `! `). Trailing segments under 50 tokens merge into the previous segment.
3. **Guardrail** — if segment count exceeds `max_segments_per_document` (default 100), reject with error
4. **Hash** — SHA-256 each segment's body text
5. **Diff** — if document with this `external_id` exists in this index, compare new segment hashes against stored `content_hash` values
6. **Embed** — generate embeddings only for segments with new or changed hashes. Each segment is embedded as `"{title}\n\n{segment_body}"` to include title context.
7. **Tsvector** — generate tsvectors only for changed segments using the index's `text_search_config`
8. **Upsert** — within a transaction:
   - Upsert `search_documents` row (title, metadata, title_tsvector, title_length, updated_at)
   - Delete segments that no longer exist (removed or repositioned)
   - Insert new / update changed segments (body, content_hash, embedding, body_tsvector, body_length)
   - Update `segment_count` on document
   - Increment `docs_changed_since_refresh` on index
9. **Refresh check** — if `docs_changed_since_refresh` exceeds the index's `refresh_threshold`, execute `REFRESH MATERIALIZED VIEW CONCURRENTLY term_document_frequencies` and reset counter
10. **Respond** — return external_id, segment counts (total, changed, unchanged), status

---

## Materialized View Refresh

Self-managing refresh triggered by ingest activity.

Two fields on `search_indexes`:
- `last_refreshed_at` — timestamp of last refresh
- `docs_changed_since_refresh` — counter incremented on each ingest

On every ingest, after upserting the document:
1. Increment `docs_changed_since_refresh`
2. If counter ≥ `refresh_threshold` (from index config, default 100):
   - `REFRESH MATERIALIZED VIEW CONCURRENTLY term_document_frequencies`
   - Reset counter to 0
   - Update `last_refreshed_at`

`CONCURRENTLY` ensures searches are not blocked during refresh — they read the previous version of the view until the refresh completes.

Manual refresh is always available via `POST /admin/indexes/:name/refresh`.

For bulk loads: the threshold batches refreshes naturally (refreshing every ~100 documents rather than every document). Callers can also skip threshold-based refresh and call the manual endpoint once after the full bulk load completes.

---

## Embedding Adapter

Pluggable embedding generation configured per index.

### Interface

```typescript
interface EmbeddingAdapter {
  embed(texts: string[]): Promise<number[][]>
  dimensions: number
}
```

Batch input allows embedding multiple segments per call. Each adapter handles provider-specific batching internally.

### Implementations

**Bedrock adapter** — calls AWS Bedrock API for inference. Supports Titan Embeddings V2, Cohere Embed, and other Bedrock-hosted models. Configuration:

```json
{
  "provider": "bedrock",
  "model": "amazon.titan-embed-text-v2:0",
  "dimensions": 1024
}
```

**Local adapter** — loads ONNX model and runs inference in-process using `@huggingface/transformers`. Configuration:

```json
{
  "provider": "local",
  "model": "all-MiniLM-L6-v2",
  "dimensions": 384
}
```

### Model Storage

Local models stored in S3 Express One Zone. Loaded to Lambda ephemeral storage (`/tmp`) on cold start and cached for the lifetime of the execution environment. Lambda memory right-sized based on benchmarked inference performance (memory scales CPU and network proportionally).

### Dimension Handling

pgvector column dimensions are effectively per-index since each index can use a different embedding model. The `dimensions` value in index config determines the vector size at index creation.

---

## Chunking Strategy

Paragraph-boundary chunking with sentence-level fallback.

1. Split body text on double newlines (`\n\n`) to extract paragraphs
2. Accumulate paragraphs into segments targeting `max_segment_tokens` (default 500, configurable per index)
3. If adding the next paragraph would exceed the max, close the current segment and start a new one
4. If a single paragraph exceeds the max, split on sentence boundaries (`. ` / `? ` / `! `)
5. Trailing segments under 50 tokens merge into the previous segment

Token counting uses whitespace-split approximation — close enough for sizing without requiring the embedding model's specific tokenizer.

Before embedding, each segment's text is prepended with the document title: `"{title}\n\n{segment_body}"`. This embeds title context into every segment's vector without requiring a separate title embedding column.

---

## Infrastructure Notes

- **Database:** Aurora PostgreSQL (Serverless v2) with `pgvector` extension enabled
- **Lambda:** Node.js 22, ARM64, memory right-sized based on embedding model benchmarks
- **API Gateway:** REST API with path-based routing to single Lambda
- **Secrets:** Admin API key in AWS Secrets Manager via `@phila/constructs`
- **Model storage:** S3 Express One Zone for ONNX model files
- **CDK:** Uses `@phila/constructs` `LambdaPostgresApi` pattern with additional S3 bucket for model storage

---

## Phase 2 Candidates (Not In Scope)

- Cross-index search (federated queries across multiple indexes)
- Metadata facet filtering (GIN index on metadata jsonb — schema already supports it)
- Embedding-driven keyword expansion (synthetic terms from embedding neighbors)
- Query autocomplete / suggestion
- Per-query blend weight override
- Relevance feedback loops (click-through tracking)
- Key rotation endpoints for index/search keys
