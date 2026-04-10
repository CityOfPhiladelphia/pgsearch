# pgsearch Documentation Overhaul

## Problem

The current README is the phila-ctl canned template. It documents generic Hono routing, DB connection options, API key rotation, and Aurora Serverless toggles — none of which reflect what pgsearch actually does. There is no user-facing documentation for setting up an index, ingesting content, understanding search behavior, or the system architecture.

## Audience

Primary: OIT engineers who need to integrate a search index into a city service — create an index, ingest content, wire up search queries.

Secondary: Engineers who want to understand or contribute to pgsearch internals.

## Design

### Structure

```
README.md                              # Overview + index/map
docs/
  getting-started.md                   # Create index, ingest, search walkthrough
  search.md                            # Query behavior, scoring, tuning
  ingestion.md                         # Document pipeline, parsing, crawler
  architecture.md                      # Internals, schema, design decisions
  superpowers/specs/...                # Untouched dev artifacts
```

Layered by concern: consumption, usage, ingestion, architecture/design. The top-level README acts as an index that lets people (or agents) step into the appropriate level of granularity.

The `docs/superpowers/` directory is left as-is — those are development artifacts, not user-facing docs.

The client SDK (`@phila/pgsearch-client`) is documented as a section within `getting-started.md` rather than a separate page. Its surface area is small enough that a dedicated page would be thin, and IDE autocomplete handles the type reference use case.

### README.md

Replaces the entire current phila-ctl template.

**Contents:**
- **What it is**: One paragraph — PostgreSQL hybrid search service combining BM25F keyword scoring with pgvector semantic search. Multi-tenant, per-index configuration.
- **Key concepts**: Brief definitions (1-2 sentences each) of Index, Document, Segment, Hybrid Search.
- **Quick start**: Minimal happy path — create an index, ingest a document, search. Curl commands or client SDK calls only, no theory. Links to deeper docs for each step.
- **Doc index**: Links to each page with a one-line description.
- **Deployment**: How to deploy (`pnpm install`, `pnpm build`, `city deploy dev`). Link to phila-ctl repo for CLI details.
- **Project structure**: Updated to reflect actual monorepo layout.

**Drops from current README:** Generic Hono tutorial content, DB connection options list, API key rotation procedure, Aurora Serverless toggle instructions, "Next Steps" section.

### docs/getting-started.md

Linear walkthrough for the "I need search in my app" use case.

**Contents:**
- **Prerequisites**: Node.js 20+, AWS CLI with SSO, access to a deployed pgsearch instance (API URL + admin key).
- **Step 1: Create an index** — POST to `/private/key/admin/indexes` with `x-api-key` header. Explain what comes back (index_key for writing, search_key for reading). Note that default config is sensible for most English content.
- **Step 2: Ingest documents** — POST to `/public/index/:name/documents` with `x-index-key` header. External_id, title, body, optional metadata. High-level explanation of what happens (chunking, embedding, tsvector generation). Link to `ingestion.md` for details.
- **Step 3: Refresh the index** — POST refresh after bulk ingestion. Explain why (materializes term frequency stats for BM25F). Note: not needed after every document, just after batches. Mention that auto-refresh triggers when `refresh_threshold` (default 100) documents have changed since last refresh.
- **Step 4: Search** — GET `/public/search/:name?q=...` with `x-search-key` header. Show response shape. Brief explanation that score is a blend of keyword + semantic relevance. Link to `search.md` for tuning.
- **Using the client SDK** — Same steps using `@phila/pgsearch-client`. Brief code sample. Note that the SDK handles the path prefixes (`/public/`, `/private/key/`) internally — method calls use logical paths like `search(indexName, ...)`.

**Tone:** Practical, minimal theory. "Do this, then this, then this." Each step shows the HTTP call and expected response.

### docs/search.md

For someone whose index is working but wants to understand or improve result quality.

**Contents:**
- **How hybrid search works**: Two-pass retrieval explained plainly. BM25F finds keyword matches, vector search finds semantic matches, scores normalized independently (min-max to 0-1), then blended. Mental model, not formulas.
- **Scoring parameters** — what the knobs do and when to turn them:
  - `blend_alpha` (default 0.6) — higher favors keyword, lower favors semantic. When to adjust.
  - `field_weights` (default title:3, body:1) — how much title matches matter vs body.
  - `bm25_k1` and `bm25_b` — brief explanation, note defaults work well, link to BM25 literature.
- **What's opinionated** — explicit design decisions:
  - Min-max normalization (vs. RRF). Simple, interpretable, works well when both signals are present.
  - Title embedded with each segment for vector context.
  - One result per document (best segment wins).
  - Segment size defaults to ~500 words (the chunker uses whitespace-delimited word count, not model tokenization).
- **Things to be aware of**:
  - Results are per-document, not per-segment.
  - Scores are relative to the result set, not absolute. A 0.9 in one query isn't comparable to a 0.9 in another.
  - `text_search_config` (default 'english') controls stemming. Matters for multilingual content.

### docs/ingestion.md

How to get content into pgsearch. Covers the pipeline from raw content to indexed documents.

**Contents:**
- **Document model**: external_id (your unique key), title, body (plain text or markdown), metadata (arbitrary JSON passed through to results). External_id is how you reference and upsert.
- **Ingestion API**: POST endpoint, request/response shapes. Upsert behavior — same external_id updates in place, only re-embeds changed segments (SHA256 content-hashed). Cost optimization worth calling out.
- **Segmentation**: How body gets chunked — paragraph boundaries, sentence boundaries, word-count fallback. Short trailing segments are merged into the previous one (below 50 words). Configurable via `max_segment_tokens`. Why it matters for search quality.
- **The parse library** (`@phila/search-parse`): Composable pipeline for HTML-to-markdown extraction. `pipeline()` API, built-in transforms with descriptions, one practical example. Positioned as the tool for turning messy HTML into clean ingestable documents.
- **The crawler as reference**: Brief section showing how `apps/crawler` wires Crawlee + parse pipelines + ingest API for phila.gov. Not a tutorial — a working example of the pattern.
- **Known pitfalls**:
  - **Duplicate content from multiple URLs**: CMS sites often serve identical content under different URLs. Each URL becomes a separate document. Use `canonical_url` from page metadata as `external_id` to collapse duplicates, otherwise you'll see duplicate search results with identical titles, snippets, and scores. Note: the phila.gov crawler currently uses the source URL directly — this is a known limitation.
  - **Refresh after bulk ingestion**: Term frequency statistics are materialized. Stale stats mean BM25F scoring uses outdated IDF values. Auto-refresh triggers when `refresh_threshold` (default 100) documents have changed, but manual refresh after a bulk load is still good practice.

### docs/architecture.md

Internals for contributors or anyone making informed decisions about extending the system.

**Contents:**
- **System overview**: Lambda + PostgreSQL (pgvector), CDK with phila constructs, API Gateway with WAF. Single Lambda, stateless, migrations run idempotently on cold start.
- **Database schema**: Three tables (search_indexes, search_documents, search_segments) and materialized view (term_document_frequencies). Relationships and why segments are denormalized with index_id.
- **Multi-tenancy model**: Per-index isolation — keys, config, HNSW vector index, statistics. Shared tables partitioned by index_id.
- **Authentication model**: Two levels. The admin key is an API Gateway-managed key (`x-api-key` header) — infrastructure-level, retrieved from AWS Secrets Manager/SSM. Index keys and search keys are per-index application-level credentials (`x-index-key`, `x-search-key` headers) — bcrypt-hashed, returned when you create an index. This distinction matters: admin key comes from AWS, index/search keys come from the createIndex response.
- **Embedding strategy**: Pluggable adapter interface. Currently Bedrock Titan Embed v2 in production. Title prepended to segments for context. Only changed segments re-embedded on upsert. Note: default config in code references a local provider that isn't implemented — production indexes must specify `bedrock` as the embedding provider.
- **Design decisions and trade-offs**:
  - PostgreSQL over dedicated search engine — lower operational overhead, single data store, sufficient for municipal-scale.
  - HNSW over IVFFlat — better recall, appropriate for read-heavy indexes.
  - Min-max score normalization — simple, interpretable. Trade-off vs. RRF: sensitive to outliers but preserves magnitude.
  - WAF body size override — ingest payloads (10-60KB) trip default AWS CommonRuleSet.
- **Project structure**: Map of the monorepo — what lives where and why.
