# pgsearch

PostgreSQL hybrid search service combining BM25F full-text keyword scoring with pgvector semantic similarity search. Multi-tenant — each index has independent configuration, authentication keys, and scoring parameters. Designed for municipal-scale content (city services, programs, articles) where operational simplicity matters more than peak throughput.

## Key concepts

- **Index** — a named, isolated search namespace. Each index has its own configuration, authentication keys, documents, and vector index. Create one per content domain (e.g., "services-programs", "city-news").
- **Document** — a searchable unit identified by `external_id`. Has a title, body text, and optional metadata. The body is automatically split into segments for embedding.
- **Segment** — a chunk of document body (~500 words). Each segment gets its own vector embedding and tsvector. Search returns the best-matching segment as the result snippet.
- **Hybrid search** — each query runs two passes: keyword matching (BM25F on tsvectors) and semantic similarity (pgvector cosine distance). Scores are normalized and blended into a single ranking.

## Quick start

```bash
# Create an index
curl -X POST https://<api-url>/private/key/admin/indexes \
  -H "x-api-key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-index"}'
# → {"name":"my-index","index_key":"idx_...","search_key":"srch_...","created_at":"..."}

# Ingest a document
curl -X POST https://<api-url>/public/index/my-index/documents \
  -H "x-index-key: $INDEX_KEY" \
  -H "Content-Type: application/json" \
  -d '{"external_id":"page-1","title":"Apply for a Parking Permit","body":"You can apply online..."}'

# Refresh statistics after bulk ingestion
curl -X POST https://<api-url>/private/key/admin/indexes/my-index/refresh \
  -H "x-api-key: $ADMIN_KEY"

# Search
curl "https://<api-url>/public/search/my-index?q=parking+permit" \
  -H "x-search-key: $SEARCH_KEY"
```

See [Getting Started](docs/getting-started.md) for a full walkthrough.

## Documentation

| Guide | Description |
|-------|-------------|
| [Getting Started](docs/getting-started.md) | Create an index, ingest documents, run your first search. |
| [Search](docs/search.md) | How hybrid search works, scoring parameters, tuning guidance. |
| [Ingestion](docs/ingestion.md) | Document pipeline, the parse library, the crawler, known pitfalls. |
| [Architecture](docs/architecture.md) | Database schema, multi-tenancy, authentication, design decisions. |

## Project structure

```
pgsearch/
├── apps/api/          # Lambda search service (Hono + PostgreSQL + pgvector)
├── apps/crawler/      # phila.gov web crawler (Crawlee + parse pipelines)
├── packages/client/   # @phila/pgsearch-client TypeScript SDK
├── packages/embeddings/ # @phila/search-embeddings (pluggable adapter interface)
├── packages/parse/    # @phila/search-parse (composable HTML→markdown pipeline)
├── cdk/               # AWS CDK infrastructure
└── docs/              # Documentation
```

## Deployment

```bash
pnpm install
pnpm run build
city deploy dev    # or test, prod
```

Requires AWS CLI configured with SSO and the `phila-pgsearch` profile. See the [phila-ctl documentation](https://github.com/CityOfPhiladelphia/phila-ctl) for CLI setup and deployment details.

## Development

```bash
# Build all packages
pnpm run build

# Run tests
pnpm test

# View CDK diff before deploying
pnpm run diff
```
