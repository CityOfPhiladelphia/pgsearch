<!-- ABOUTME: Internals guide covering system design, database schema, auth model, and architectural decisions. -->
<!-- ABOUTME: Intended for contributors and engineers extending or operating the pgsearch service. -->

# Architecture

## System Overview

pgsearch runs as a single AWS Lambda function behind API Gateway. The Lambda handles all routes — admin, ingest, search, and health. PostgreSQL with the pgvector extension provides both relational storage and vector similarity search.

Infrastructure is defined in `cdk/app.ts` using AWS CDK with [phila constructs](https://github.com/CityOfPhiladelphia/phila-ctl). The stack includes API Gateway (with WAF), Lambda, RDS PostgreSQL, Secrets Manager, and supporting IAM/KMS resources.

The Lambda is stateless. Database migrations run idempotently on cold start via `db/migrate.ts` — a versioned migration runner that tracks applied migrations in a `schema_migrations` table.

### Deployment

```bash
pnpm install && pnpm run build
city deploy dev    # or test, prod
```

See the [phila-ctl documentation](https://github.com/CityOfPhiladelphia/phila-ctl) for CLI details.

---

## Database Schema

Three tables and one materialized view:

```
search_indexes
  ├── index_id (PK)
  ├── name (unique)
  ├── config (JSONB) — all per-index settings
  ├── index_key_hash, search_key_hash — bcrypt
  ├── total_documents, avg_title_length, avg_body_length — statistics
  └── docs_changed_since_refresh — triggers auto-refresh

search_documents
  ├── document_id (UUID PK)
  ├── index_id (FK) + external_id — UNIQUE together
  ├── title, title_tsvector, title_length
  ├── metadata (JSONB)
  └── segment_count

search_segments
  ├── segment_id (UUID PK)
  ├── document_id (FK), index_id (FK) — denormalized
  ├── segment_index — order within document
  ├── body, content_hash (SHA256)
  ├── embedding (VECTOR) — pgvector
  └── body_tsvector, body_length

term_document_frequencies (MATERIALIZED VIEW)
  ├── index_id, term, document_frequency
  └── Refreshed on manual /refresh or auto-refresh threshold
```

`index_id` is denormalized onto `search_segments` to avoid joining through `search_documents` on every search query.

### Indexes

Each search index gets its own HNSW vector index: `idx_segments_embedding_{index_id}` on `embedding::vector(dimensions)` using `vector_cosine_ops`. GIN indexes cover `title_tsvector` and `body_tsvector` for full-text search.

---

## Multi-Tenancy Model

Each index is fully isolated: its own authentication keys, configuration, HNSW vector index, and statistics. Indexes share the same database tables but are partitioned by `index_id`. There is no cross-index query capability.

---

## Authentication Model

Two levels of authentication:

| Level | Header | Source | Scope |
|-------|--------|--------|-------|
| Admin (API Gateway) | `x-api-key` | AWS Secrets Manager / SSM | Manage all indexes (create, update, delete, refresh) |
| Per-index (application) | `x-index-key` / `x-search-key` | Returned by `createIndex` | Write documents / query a specific index |

The admin key is managed by API Gateway infrastructure — retrieved from AWS Secrets Manager. Index and search keys are application-level credentials generated at index creation time, bcrypt-hashed, and stored per-index.

This separation means you can hand out a `search_key` to a frontend consumer without exposing write or admin access.

---

## Embedding Strategy

Embedding is pluggable via the `EmbeddingAdapter` interface:

```typescript
interface EmbeddingAdapter {
  embed(texts: string[]): Promise<number[][]>
  dimensions: number
  model: string
}
```

Production uses AWS Bedrock Titan Embed Text v2 (`amazon.titan-embed-text-v2:0`). A deterministic test adapter exists for integration testing without external API calls.

### Context Prepending

Before embedding, the document title is prepended to each segment:

```
"Document Title\n\nsegment body text"
```

This gives the embedding model document-level context even for body segments that don't reference the title topic.

### Incremental Re-embedding

Only changed segments are re-embedded on upsert. Each segment is SHA256-hashed by content; unchanged segments retain their existing embeddings.

> **Note:** The default config specifies `provider: 'local'` which is not implemented at runtime — the adapter factory only supports `'bedrock'`. Production indexes must specify `bedrock` as the embedding provider in their config.

---

## Design Decisions and Trade-offs

### 1. PostgreSQL over a dedicated search engine

A single PostgreSQL instance handles relational storage, full-text search, and vector similarity. This trades peak search performance for lower operational overhead. Sufficient for municipal-scale content.

### 2. HNSW over IVFFlat

HNSW provides better recall at the cost of slower index build time and more memory. Appropriate for read-heavy indexes.

### 3. Min-max score normalization

Simple and interpretable. Trade-off vs. RRF: min-max is sensitive to outliers but preserves score magnitude information. RRF is more robust to outliers but discards magnitude.

### 4. WAF body size override

The AWS Managed Common Rule Set's `SizeRestrictions_BODY` rule is overridden to Count (not Block). Ingest payloads are typically 10–60KB, exceeding the default 8KB body limit.

---

## Project Structure

```
pgsearch/
├── apps/
│   ├── api/                   # Lambda search service
│   │   ├── index.ts           # Hono app + Lambda handler
│   │   ├── routes/            # admin, ingest, search, health
│   │   ├── services/          # search, ingest, score, chunk, refresh, indexes
│   │   ├── middleware/        # auth, error handling
│   │   ├── db/                # pool, migrations, schema
│   │   ├── config.ts          # Default index configuration
│   │   ├── types.ts           # Shared type definitions
│   │   └── test/              # Integration tests
│   └── crawler/               # phila.gov web crawler
│       └── src/
│           ├── cli.ts          # CLI entrypoint
│           ├── crawl.ts        # Crawlee orchestration
│           ├── parse/          # Site-specific parse pipelines
│           └── sink/           # HTTP sink to ingest API
├── packages/
│   ├── client/                # @phila/pgsearch-client SDK
│   ├── embeddings/            # @phila/search-embeddings (adapter interface)
│   └── parse/                 # @phila/search-parse (HTML→markdown pipeline)
├── cdk/                       # AWS CDK infrastructure
│   └── app.ts                 # Stack definition
├── docs/                      # Documentation (you are here)
└── city.config.json           # phila-ctl deployment config
```
