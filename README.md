<!-- ABOUTME: Project overview and documentation index for pgsearch. -->
<!-- ABOUTME: Links to getting-started, search, ingestion, and architecture guides. -->

# pgsearch

PostgreSQL hybrid search + RAG service combining weighted full-text keyword scoring with pgvector semantic similarity search, layered with a synthesis endpoint that produces grounded answers with inline citations. Multi-tenant — each index has independent configuration, authentication keys, scoring parameters, and prompts. Designed for moderate-scale content (tens of thousands to low hundreds of thousands of documents per index) where operational simplicity matters more than peak throughput.

## Key concepts

- **Index** — a named, isolated search namespace. Each index has its own configuration, authentication keys, documents, and vector index. Create one per content domain (e.g., "services-programs", "city-news").
- **Document** — a searchable unit identified by `external_id`. Has a title, body text, and optional metadata. The body is automatically split into segments for embedding.
- **Segment** — a chunk of document body sized to a token budget (default ~1000, estimated from UTF-8 byte length). Each segment gets its own vector embedding and tsvector. Search returns the best-matching segment as the result snippet.
- **Hybrid search** — each query runs two passes: keyword matching (BM25F on tsvectors) and semantic similarity (pgvector cosine distance). Results are combined using Reciprocal Rank Fusion (RRF) for robust ranking.
- **RAG** — `/public/rag/:name?prompt=<name>` retrieves the top chunks for a question and asks an LLM to synthesize an answer with inline citations. Prompts are per-index DB entities; RAG access is gated by a separate `x-rag-key`.

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
| [RAG](docs/rag.md) | Synthesize answers with citations using stored prompts and the hybrid retrieval pipeline. |

## Project structure

```
pgsearch/
├── apps/api/             # Lambda search + RAG service (Hono + PostgreSQL + pgvector)
├── apps/crawler/         # phila.gov web crawler (Crawlee + parse pipelines)
├── packages/client/      # @phila/pgsearch-client TypeScript SDK
├── packages/embeddings/  # @phila/search-embeddings (adapter + Bedrock Titan)
├── packages/llm/         # @phila/llm (adapter + Bedrock Claude)
├── packages/bedrock-client/ # @phila/bedrock-client (shared lazy SDK client)
├── packages/parse/       # @phila/search-parse (composable HTML→markdown pipeline)
├── cdk/                  # AWS CDK infrastructure
└── docs/                 # Documentation
```

## Deployment

```bash
pnpm install
pnpm run build
city deploy dev    # or test, prod
```

Requires AWS CLI configured with SSO and the profile name listed under your environment in `city.config.json`. See the [phila-ctl documentation](https://github.com/CityOfPhiladelphia/phila-ctl) for CLI setup and deployment details.

## Development

```bash
# Build all packages
pnpm run build

# Run tests
pnpm test

# View CDK diff before deploying
pnpm run diff
```
