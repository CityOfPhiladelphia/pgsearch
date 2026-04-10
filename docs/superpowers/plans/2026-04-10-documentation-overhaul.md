# Documentation Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the phila-ctl canned README with layered, pgsearch-specific documentation covering consumption, usage, ingestion, and architecture.

**Architecture:** Five markdown files — README.md as a map/index, plus four docs pages organized by concern. Each page is self-contained; a reader should never need to read a page they don't care about.

**Tech Stack:** Markdown only. No code changes.

**Spec:** `docs/superpowers/specs/2026-04-10-documentation-overhaul-design.md`

---

### Task 1: Write `docs/getting-started.md`

The linear walkthrough for integrators. Written first because the README quick-start section will link here.

**Files:**
- Create: `docs/getting-started.md`

- [ ] **Step 1: Write the getting-started guide**

Create `docs/getting-started.md` with:

**Prerequisites section:**
- Node.js 20+
- AWS CLI configured with SSO
- Access to a deployed pgsearch instance (API base URL + admin API key)

**Step 1: Create an index**

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

Explain: save `index_key` (for writing documents) and `search_key` (for searching). Default config is tuned for English content — see `docs/search.md` for tuning options.

Optional: pass `config` to override defaults (link to search.md for parameter reference).

**Step 2: Ingest a document**

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

Explain: `external_id` is your unique key — re-ingesting the same `external_id` upserts (only re-embeds changed segments). `body` is plain text or markdown. `metadata` is arbitrary JSON passed through to search results. Link to `docs/ingestion.md` for details on chunking and the parse library.

**Step 3: Refresh the index**

```bash
curl -X POST https://<api-url>/private/key/admin/indexes/my-index/refresh \
  -H "x-api-key: $ADMIN_KEY"
```

Explain: materializes term frequency statistics used by BM25F scoring. Not needed after every document — do it after bulk ingestion batches. Auto-refresh triggers when `refresh_threshold` (default 100) documents have changed since last refresh.

**Step 4: Search**

```bash
curl https://<api-url>/public/search/my-index?q=parking+permit&limit=10 \
  -H "x-search-key: $SEARCH_KEY"
```

Response:
```json
{
  "results": [
    {
      "external_id": "page-001",
      "score": 0.847,
      "title": "Apply for a Parking Permit",
      "snippet": "You can apply for a residential parking permit online...",
      "metadata": {"source_url": "https://example.com/parking", "content_type": "services"}
    }
  ],
  "total": 1,
  "query": "parking permit"
}
```

Explain: `score` is a blend of keyword relevance (BM25F) and semantic similarity (vector). `snippet` is the best-matching document segment. `total` is the count of unique matching documents (before the `limit` is applied), not the length of `results`. See `docs/search.md` for how scoring works and how to tune it.

**Using the client SDK section:**

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

Note: the SDK uses shorter paths than the raw API (e.g., `/search/:name` instead of `/public/search/:name`). The `baseUrl` should include any gateway stage prefix so the SDK's paths resolve correctly.

- [ ] **Step 2: Commit**

```bash
git add docs/getting-started.md
git commit -m "docs: add getting-started guide"
```

---

### Task 2: Write `docs/search.md`

Search behavior, scoring, tuning parameters, design opinions.

**Files:**
- Create: `docs/search.md`

- [ ] **Step 1: Write the search guide**

Create `docs/search.md` with:

**How hybrid search works section:**

Two-pass retrieval:
1. **BM25F pass** — full-text keyword search. PostgreSQL tsvectors match stemmed query terms against title and body. Title matches are weighted 3x by default.
2. **Vector pass** — semantic similarity. The query is embedded and compared against document segment embeddings using pgvector HNSW cosine similarity.
3. **Score normalization** — each pass's scores are independently normalized to [0, 1] using min-max normalization.
4. **Blending** — final score = `blend_alpha * normalized_bm25 + (1 - blend_alpha) * normalized_vector`.
5. **Deduplication** — one result per document. When multiple segments of the same document match, only the highest-scoring segment is returned (as the snippet).

**Scoring parameters section:**

Document per-index configurable parameters. Each parameter, its default, and guidance on when to adjust:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `blend_alpha` | `0.6` | Weight given to keyword (BM25F) vs. semantic (vector) scores. Higher values favor exact keyword matches; lower values favor meaning-based matches. Start here if results feel wrong. |
| `field_weights.title` | `3.0` | BM25F weight multiplier for title matches. |
| `field_weights.body` | `1.0` | BM25F weight multiplier for body matches. |
| `bm25_k1` | `1.2` | Term frequency saturation. Higher values let repeated terms matter more. Defaults work well for most content. |
| `bm25_b` | `0.75` | Document length normalization. 1.0 = full normalization, 0.0 = none. Defaults work well for most content. |
| `text_search_config` | `'english'` | PostgreSQL text search configuration. Controls stemming and stop words. Change for non-English content. |

Link to [BM25 on Wikipedia](https://en.wikipedia.org/wiki/Okapi_BM25) for deep background on k1/b.

Update via:
```bash
curl -X PATCH https://<api-url>/private/key/admin/indexes/my-index \
  -H "x-api-key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"blend_alpha": 0.4}'
```

**What's opinionated section:**

Design decisions baked into pgsearch and the reasoning behind them:

- **Min-max normalization** — scores from each pass are independently scaled to [0, 1] before blending. This is simple and interpretable. Trade-off: sensitive to outliers in the score distribution. Alternative approaches like Reciprocal Rank Fusion (RRF) exist but add complexity without clear benefit at this scale.
- **Title embedded with segments** — each segment's embedding is computed from `"Document Title\n\nbody segment text"`. This gives the vector model document-level context even for body segments that don't mention the title topic.
- **One result per document** — the best-scoring segment wins. Multiple matching sections from the same document don't produce multiple results.
- **Segment size ~500 words** — the chunker uses whitespace-delimited word count (not model tokenization). This balances embedding quality (too large dilutes the vector) with context preservation (too small loses meaning). Configurable via `max_segment_tokens`.

**Things to be aware of section:**

- **Scores are relative, not absolute.** Min-max normalization means scores reflect position within the current result set. A score of 0.9 in one query is not comparable to 0.9 in another.
- **Results are per-document, not per-segment.** A long document with multiple matching sections returns once. The snippet is the best-matching segment.
- **Stemming depends on `text_search_config`.** The default `'english'` config stems words (e.g., "running" → "run") and removes English stop words. If your content is multilingual or domain-specific, this matters.
- **BM25F statistics require refresh.** Term frequency stats are materialized. After significant ingestion, refresh the index so BM25F scoring uses current IDF values. Auto-refresh triggers after `refresh_threshold` (default 100) document changes.

- [ ] **Step 2: Commit**

```bash
git add docs/search.md
git commit -m "docs: add search behavior and tuning guide"
```

---

### Task 3: Write `docs/ingestion.md`

Document pipeline, parse library, crawler reference, known pitfalls.

**Files:**
- Create: `docs/ingestion.md`

- [ ] **Step 1: Write the ingestion guide**

Create `docs/ingestion.md` with:

**Document model section:**

A document in pgsearch has four fields:

| Field | Required | Description |
|-------|----------|-------------|
| `external_id` | Yes | Your unique identifier. Used for upserts — re-ingesting the same `external_id` updates the existing document. |
| `title` | Yes | Document title. Weighted 3x in keyword search by default. Prepended to each segment before embedding. |
| `body` | Yes | Document content as plain text or markdown. Automatically chunked into segments. |
| `metadata` | No | Arbitrary JSON. Passed through to search results unchanged. Use for source URLs, content types, tags — anything your consumer needs. |

**Ingestion API section:**

```
POST /public/index/:name/documents
Header: x-index-key: <index_key>
```

Request body:
```json
{
  "external_id": "unique-id",
  "title": "Document Title",
  "body": "Full document content...",
  "metadata": {"source_url": "https://...", "content_type": "article"}
}
```

Response:
```json
{
  "external_id": "unique-id",
  "segments": 5,
  "changed": 3,
  "unchanged": 2,
  "status": "indexed"
}
```

Explain upsert behavior: same `external_id` within an index updates the existing document. Each segment is SHA256 content-hashed — only segments whose content actually changed are re-embedded. This saves embedding API costs on large re-ingestion runs.

Delete: `DELETE /public/index/:name/documents/:external_id` with `x-index-key` header.

**Segmentation section:**

Body text is split into segments for embedding. The chunker:
1. Splits on paragraph boundaries (double newlines)
2. If a paragraph exceeds `max_segment_tokens` (default 500 words), splits on sentence boundaries
3. If a sentence still exceeds the limit, falls back to word-count splitting
4. Short trailing segments (under 50 words) are merged into the previous segment

Each segment is embedded independently (with the document title prepended for context). Smaller segments produce more focused embeddings; larger segments preserve more surrounding context. The 500-word default balances these concerns for typical web content.

Configurable per-index via `max_segment_tokens` and `max_segments_per_document` (default 100).

**The parse library section:**

`@phila/search-parse` is a composable pipeline for extracting structured documents from HTML. Use it when your source content is web pages.

```typescript
import { pipeline, extractMeta, extractTitle, selectContent, remove, cleanWhitespace, toMarkdown } from '@phila/search-parse'

const parse = pipeline(
  extractMeta(),                          // Pull meta tags, og:*, canonical URL into metadata
  extractTitle('.entry-header h2'),       // Extract title from CSS selector (falls back to h1 → og:title → <title>)
  remove('.breadcrumbs', '.sidebar'),     // Strip elements before content extraction
  selectContent('.main-content'),         // Narrow scope to content container
  cleanWhitespace(),                      // Collapse whitespace, remove empty lines
  toMarkdown()                            // Convert remaining HTML to markdown
)

const doc = await parse(htmlString)
// { title: "...", body: "# Markdown content...", metadata: { canonical_url: "...", ... } }
```

**Built-in transforms:**

| Transform | Purpose |
|-----------|---------|
| `extractMeta(options?)` | Extracts `<meta>` tags, Open Graph, `canonical`, `lang` into metadata. Options: `only` (allowlist), `exclude` (regex blocklist), `extras` (custom selectors). |
| `extractTitle(selector?, options?)` | Extracts title from selector, or falls back through h1 → `og_title` → `html_title` from metadata. Run `extractMeta()` first for fallbacks to work. |
| `selectContent(selector, options?)` | Narrows the DOM to a subtree. Everything outside the selector is discarded. |
| `remove(...selectors)` | Removes matching elements from the DOM. |
| `unwrap(...selectors)` | Removes elements but keeps their children (e.g., strip a wrapper div). |
| `cleanWhitespace()` | Collapses multiple whitespace runs and removes empty lines. |
| `toMarkdown(options?)` | Terminal transform. Converts DOM to markdown via Turndown. |
| `injectIntoBody({ from, position })` | Reads a string from `metadata[from]` and injects it as a paragraph into the DOM at the given position (`'prepend'` or `'append'`). |

Pipelines are composable — build one per source site's DOM structure.

**The crawler as reference section:**

`apps/crawler` is a working example of wiring together the parse library, Crawlee (for web crawling), and the ingest API. It crawls phila.gov services and programs pages.

```bash
tsx apps/crawler/src/cli.ts \
  --endpoint https://<api-url> \
  --index phila-services-programs \
  --index-key $INDEX_KEY \
  --seed https://www.phila.gov/services/ \
  --seed https://www.phila.gov/programs/ \
  --concurrency 4 \
  --limit 50
```

The crawler routes URLs to parse pipelines by path pattern, parses each page with a site-specific pipeline, and POSTs the result to the ingest API. See `apps/crawler/src/parse/` for the pipeline definitions.

**Known pitfalls section:**

**Duplicate content from multiple URLs.** CMS sites commonly serve identical content under different URL paths (redirects, alternate navigation paths, URL rewrites). Each URL ingested as a separate `external_id` creates a separate document — producing duplicate search results with identical titles, snippets, and scores.

Use the page's `canonical_url` (extracted by `extractMeta()`) as the `external_id` instead of the source URL to collapse these duplicates. The phila.gov crawler currently uses the source URL directly — this is a known limitation.

**Refresh after bulk ingestion.** BM25F scoring relies on term frequency statistics stored in a materialized view. After ingesting a batch of documents, refresh the index so scoring uses current IDF values. Auto-refresh triggers when `refresh_threshold` (default 100) documents have changed since the last refresh, but a manual refresh after a bulk load is still good practice.

- [ ] **Step 2: Commit**

```bash
git add docs/ingestion.md
git commit -m "docs: add ingestion pipeline and parse library guide"
```

---

### Task 4: Write `docs/architecture.md`

Internals, schema, design decisions.

**Files:**
- Create: `docs/architecture.md`

- [ ] **Step 1: Write the architecture guide**

Create `docs/architecture.md` with:

**System overview section:**

pgsearch runs as a single AWS Lambda function behind API Gateway. The Lambda handles all routes (admin, ingest, search, health). PostgreSQL with the pgvector extension provides both relational storage and vector similarity search.

Infrastructure is defined in `cdk/app.ts` using AWS CDK with [phila constructs](https://github.com/CityOfPhiladelphia/phila-ctl). The stack includes API Gateway (with WAF), Lambda, RDS PostgreSQL, Secrets Manager, and supporting IAM/KMS resources.

The Lambda is stateless. Database migrations run idempotently on cold start via `db/migrate.ts` (a versioned migration runner that tracks applied migrations in a `schema_migrations` table).

Deployed via:
```bash
pnpm install && pnpm run build
city deploy dev    # or test, prod
```

See the [phila-ctl documentation](https://github.com/CityOfPhiladelphia/phila-ctl) for CLI details.

**Database schema section:**

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

Each index gets its own HNSW vector index: `idx_segments_embedding_{index_id}` on `embedding::vector(dimensions)` using `vector_cosine_ops`. GIN indexes cover `title_tsvector` and `body_tsvector` for full-text search.

**Multi-tenancy model section:**

Each index is fully isolated: its own authentication keys, configuration, HNSW vector index, and statistics. Indexes share the same database tables but are partitioned by `index_id`. There is no cross-index query capability.

**Authentication model section:**

Two levels of authentication:

| Level | Header | Source | Scope |
|-------|--------|--------|-------|
| Admin (API Gateway) | `x-api-key` | AWS Secrets Manager / SSM | Manage all indexes (create, update, delete, refresh) |
| Per-index (application) | `x-index-key` / `x-search-key` | Returned by `createIndex` | Write documents / query a specific index |

The admin key is managed by API Gateway infrastructure — retrieved from AWS Secrets Manager. Index and search keys are application-level credentials generated at index creation time, bcrypt-hashed, and stored per-index. This separation means you can hand out a `search_key` to a frontend consumer without exposing write or admin access.

**Embedding strategy section:**

Embedding is pluggable via the `EmbeddingAdapter` interface:
```typescript
interface EmbeddingAdapter {
  embed(texts: string[]): Promise<number[][]>
  dimensions: number
  model: string
}
```

Production uses AWS Bedrock Titan Embed Text v2 (`amazon.titan-embed-text-v2:0`). A deterministic test adapter exists for integration testing without external API calls.

Before embedding, the document title is prepended to each segment: `"Document Title\n\nsegment body text"`. This gives the embedding model document-level context even for body segments that don't reference the title topic.

Only changed segments are re-embedded on upsert. Each segment is SHA256-hashed by content; unchanged segments retain their existing embeddings.

Note: the default config specifies `provider: 'local'` which is not implemented at runtime — the adapter factory only supports `'bedrock'`. Production indexes must specify `bedrock` as the embedding provider in their config.

**Design decisions and trade-offs section:**

**PostgreSQL over a dedicated search engine.** pgsearch uses a single PostgreSQL instance for relational storage, full-text search (tsvector/tsquery), and vector similarity (pgvector). This trades peak search performance for dramatically lower operational overhead — one database to manage instead of a PostgreSQL + OpenSearch/Elasticsearch pair. Sufficient for municipal-scale content (thousands to low tens of thousands of documents per index).

**HNSW over IVFFlat.** HNSW indexes provide better recall at the cost of slower index build time and more memory. This is appropriate for indexes that are written infrequently (bulk ingestion) and read often (search queries).

**Min-max score normalization.** BM25F and vector scores are independently scaled to [0, 1] before blending. This is simple and interpretable. Trade-off vs. Reciprocal Rank Fusion (RRF): min-max is sensitive to outliers in the score distribution, but preserves score magnitude information. RRF is more robust to outliers but discards magnitude, treating all scores as rank positions.

**WAF body size override.** The AWS Managed Common Rule Set's `SizeRestrictions_BODY` rule is overridden to Count (not Block). Ingest payloads are typically 10-60KB, which exceeds the default 8KB body limit. The override allows legitimate ingest traffic while still logging oversized requests.

**Project structure section:**

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

- [ ] **Step 2: Commit**

```bash
git add docs/architecture.md
git commit -m "docs: add architecture and internals guide"
```

---

### Task 5: Rewrite `README.md`

Replace the phila-ctl template with the pgsearch overview and doc index.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Rewrite README.md**

Replace the entire contents of `README.md` with:

**pgsearch heading**

One paragraph: PostgreSQL hybrid search service combining BM25F full-text keyword scoring with pgvector semantic similarity search. Multi-tenant — each index has independent configuration, authentication keys, and scoring parameters. Designed for municipal-scale content (city services, programs, articles) where operational simplicity matters more than peak throughput.

**Key concepts section:**

- **Index** — a named, isolated search namespace. Each index has its own configuration, authentication keys, documents, and vector index. Create one per content domain (e.g., "services-programs", "city-news").
- **Document** — a searchable unit identified by `external_id`. Has a title, body text, and optional metadata. The body is automatically split into segments for embedding.
- **Segment** — a chunk of document body (~500 words). Each segment gets its own vector embedding and tsvector. Search returns the best-matching segment as the result snippet.
- **Hybrid search** — each query runs two passes: keyword matching (BM25F on tsvectors) and semantic similarity (pgvector cosine distance). Scores are normalized and blended into a single ranking.

**Quick start section:**

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

**Documentation section:**

| Guide | Description |
|-------|-------------|
| [Getting Started](docs/getting-started.md) | Create an index, ingest documents, run your first search. |
| [Search](docs/search.md) | How hybrid search works, scoring parameters, tuning guidance. |
| [Ingestion](docs/ingestion.md) | Document pipeline, the parse library, the crawler, known pitfalls. |
| [Architecture](docs/architecture.md) | Database schema, multi-tenancy, authentication, design decisions. |

**Project structure section:**

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

**Deployment section:**

```bash
pnpm install
pnpm run build
city deploy dev    # or test, prod
```

Requires AWS CLI configured with SSO and the `phila-pgsearch` profile. See the [phila-ctl documentation](https://github.com/CityOfPhiladelphia/phila-ctl) for CLI setup and deployment details.

**Development section:**

```bash
# Build all packages
pnpm run build

# Run tests
pnpm test

# View CDK diff before deploying
pnpm run diff
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: replace phila-ctl template README with pgsearch documentation"
```
