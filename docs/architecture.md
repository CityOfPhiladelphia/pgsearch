<!-- ABOUTME: Internals guide covering system design, database schema, auth model, and architectural decisions. -->
<!-- ABOUTME: Intended for contributors and engineers extending or operating the pgsearch service. -->

# Architecture

## System Overview

pgsearch runs as a single AWS Lambda function behind API Gateway. The Lambda handles all routes — admin, ingest, search, prompts, rag, and health. PostgreSQL with the pgvector extension provides both relational storage and vector similarity search. AWS Bedrock provides both embedding (Titan) and LLM synthesis (Claude) capabilities.

Infrastructure is defined in `cdk/app.ts` using AWS CDK with [phila constructs](https://github.com/CityOfPhiladelphia/phila-ctl). The stack includes API Gateway (with WAF), Lambda, RDS PostgreSQL, Secrets Manager, and supporting IAM/KMS resources.

The Lambda is stateless. Database migrations run idempotently on cold start via `db/migrate.ts` — a versioned runner that tracks applied versions in a `schema_migrations` table. `db/migrations.ts` holds a declarative **baseline** (the full current schema, applied to fresh databases in one step) followed by imperative **change-set** migrations for every schema change since; when the change-set list grows unwieldy, it is folded into a new baseline stamped with the highest folded version.

### Deployment

```bash
pnpm install && pnpm run build
city deploy dev    # or test, prod
```

See the [phila-ctl documentation](https://github.com/CityOfPhiladelphia/phila-ctl) for CLI details.

---

## Database Schema

Five tables:

```
search_indexes
  ├── index_id (PK)
  ├── name (unique)
  ├── config (JSONB) — all per-index settings
  ├── index_key_hash, search_key_hash — bcrypt
  ├── rag_key_hash (nullable) — bcrypt; null = RAG disabled for this index
  ├── total_documents — document count
  └── created_at, updated_at

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

rag_prompts
  ├── prompt_id (UUID PK)
  ├── index_id (FK) + name — UNIQUE together
  ├── content (JSONB) — system, response_format, model, max_tokens, temperature, retrieval
  └── created_at, updated_at

```

`index_id` is denormalized onto `search_segments` to avoid joining through `search_documents` on every search query.

`rag_prompts.prompt_id` is a stable UUID independent of `name` so future composition (extends / includes) can reference a prompt by ID without depending on name stability. `content` is JSONB so adding fields like `extends` or `guardrail_id` later doesn't require a migration.

### Indexes

Each search index gets its own HNSW vector index: `idx_segments_embedding_{index_id}` on `embedding::vector(dimensions)` using `vector_cosine_ops`. GIN indexes cover `title_tsvector` and `body_tsvector` for full-text search.

---

## Multi-Tenancy Model

Each index is fully isolated: its own authentication keys, configuration, and HNSW vector index. Indexes share the same database tables but are partitioned by `index_id`. There is no cross-index query capability.

---

## Authentication Model

Four credentials, three levels:

| Level | Header | Source | Scope |
|-------|--------|--------|-------|
| Admin (API Gateway) | `x-api-key` | AWS Secrets Manager / SSM | Manage all indexes (create, update, delete, mint/revoke RAG keys, rotate search keys) |
| Per-index — write | `x-index-key` | Returned by `createIndex` | Ingest documents into a specific index; manage that index's prompts |
| Per-index — search | `x-search-key` | Returned by `createIndex` | Query a specific index |
| Per-index — RAG | `x-rag-key` | Returned by admin `mintRagKey` (lazy) | Invoke RAG synthesis against a specific index |

The admin key is managed by API Gateway infrastructure — retrieved from AWS Secrets Manager. Index, search, and RAG keys are application-level credentials, bcrypt-hashed, stored per-index. The RAG key is **lazy** — indexes that don't use RAG never carry an unused credential. When `rag_key_hash` is null (RAG not enabled) or the provided key doesn't match, the RAG endpoint returns 401 with `Invalid RAG key`. Callers needing to distinguish "feature disabled" from "wrong key" can check the index record directly via the admin endpoint.

Splitting the RAG key from the search key matters because LLM calls can cost 100–1000× more than an embedding call. Separate keys keep cost attribution clean and let you revoke LLM-spend access without disrupting read access.

This separation also means you can hand out a `search_key` to a frontend consumer without exposing write or admin access — and grant `rag_key` independently when LLM synthesis is the intended use case.

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

## RAG Pipeline

RAG layers atop hybrid search. `/public/rag/:name` retrieves the top chunks for the latest question, renders them as numbered `Source [N]:` blocks, and sends them to an LLM along with a stored system prompt. The LLM is instructed to cite using `[N]` markers; the response parses these into a structured `citations` array.

### Request flow

1. **Auth.** Verify `x-rag-key` against `rag_key_hash`. Reject with 401 if the column is null or the key doesn't match.
2. **Load prompt.** Look up `(index_id, ?prompt=<name>)` in `rag_prompts`. 404 if missing.
3. **Retrieve.** `hybridSearch(...)` against the latest question (not the full message history — searching history is noisy), using the prompt's `retrieval` config (mode, limit, max_chunks_per_doc, score floors).
4. **Render context.** Emit `Source [N]: {title}\n{body}` per chunk, separated by blank lines.
5. **Build messages.** Prepend `system` from the prompt. Append caller's `messages` history (stateless multi-turn). Append final user turn with context block + response_format hint + the question.
6. **LLM call.** `llmAdapter.complete(...)` with the prompt's model, max_tokens, temperature.
7. **Parse citations.** Regex `\[(\d+)\]` against the answer text → unique sorted markers in range. Hydrate the citation entries from the retrieved chunks.
8. **Build `retrieved` array.** One entry per `external_id` (deduplicated when `max_chunks_per_doc > 1`), keeping the highest score per doc. Each entry has `used: boolean` indicating whether the LLM cited that document.

### Prompts as first-class entities

Stored in `rag_prompts` as JSONB so future composition (extends, includes, named fragments) is additive. A prompt carries everything that controls one RAG configuration: system text, response_format hint, model ID, generation params (max_tokens, temperature), and retrieval params (mode, limit, max_chunks_per_doc, score floors). Prompt CRUD is gated by `x-index-key` — the team that owns the index owns its prompts.

### `hybridSearch` `maxChunksPerDoc`

`hybridSearch` gained a `maxChunksPerDoc` option (default 1 — preserves original best-segment-per-doc behavior used by the search route) so RAG can pull multiple segments from the same document while still capping any single source's share of the context window. The default RAG prompt sets it to 3 — most answers live in 1–3 sections of a single page, but a 1000-page PDF chunked into 200+ segments shouldn't dominate retrieval.

### LLM adapter

LLM access goes through the `LlmAdapter` interface in `packages/llm`, mirroring `EmbeddingAdapter`:

```typescript
interface LlmAdapter {
  model: string
  complete(input: {
    system: string
    messages: { role: 'user' | 'assistant', content: string }[]
    max_tokens: number
    temperature: number
  }): Promise<{ text, usage, model }>
}
```

`BedrockLlmAdapter` calls Claude via the Anthropic Messages API. It accepts both raw `anthropic.*` model IDs (legacy direct-invoke models like Claude 3 Sonnet/Haiku, both marked LEGACY) and `<region>.anthropic.*` inference profile IDs (required for all current Claude models). Both `EmbeddingAdapter` and `LlmAdapter` share `packages/bedrock-client` for lazy, concurrent-safe, region-memoized SDK client construction.

### Bedrock account-level requirements

There are three account-level gates that must be cleared before any Anthropic model call succeeds, none of which are owned by this codebase:

1. **Model access** must be requested in the Bedrock console (us-east-1 → Model access).
2. **Anthropic use-case form** must be submitted once per account before any Anthropic invocation. Propagation takes up to 15 minutes.
3. **Marketplace IAM permissions** on the Lambda execution role: `aws-marketplace:ViewSubscriptions` and `aws-marketplace:Subscribe`. Bedrock runs this check separately from `bedrock:InvokeModel`, with an opaque error message. The CDK grants these — see `cdk/app.ts`.

### IAM for inference profiles

Inference profiles route requests to a foundation model in one of several regions. Bedrock requires `bedrock:InvokeModel` permission on **both** the inference profile ARN **and** the underlying foundation model ARN in **every region** the profile may route to (us-east-1, us-east-2, us-west-2 for `us.*` profiles). cdk-nag rejects wildcards, so each new Claude model adds 4 ARNs to the CDK policy (profile + 3 regional foundation models). See `cdk/app.ts` for the current grants.

See `docs/rag.md` for the user-facing guide.

---

## Design Decisions and Trade-offs

### 1. PostgreSQL over a dedicated search engine

A single PostgreSQL instance handles relational storage, full-text search, and vector similarity. This trades peak search performance for lower operational overhead. Sufficient for municipal-scale content.

### 2. HNSW over IVFFlat

HNSW provides better recall at the cost of slower index build time and more memory. Appropriate for read-heavy indexes.

### 3. Reciprocal Rank Fusion (RRF)

Keyword and vector results are independently ranked, then combined using RRF: `score = Σ w / (k + rank)`. This is robust to outlier scores and score distribution differences between retrievers. Trade-off vs. min-max normalization: RRF discards score magnitude, treating all scores as rank positions. For this use case, robustness to weak-signal inflation matters more than preserving magnitude.

### 4. WAF body size override

The AWS Managed Common Rule Set's `SizeRestrictions_BODY` rule is overridden to Count (not Block). Ingest payloads are typically 10–60KB, exceeding the default 8KB body limit.

---

## Project Structure

```
pgsearch/
├── apps/
│   ├── api/                   # Lambda search service
│   │   ├── index.ts           # Hono app + Lambda handler
│   │   ├── routes/            # admin, ingest, search, prompts, rag, health
│   │   ├── services/          # search, ingest, score, chunk,
│   │   │                      # indexes, prompts, rag, adapter, llm-adapter
│   │   ├── middleware/        # auth (index/search/rag), error handling
│   │   ├── db/                # pool, migrate, migrations
│   │   ├── dev/               # Static dev tools (search.html, rag.html)
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
│   ├── embeddings/            # @phila/search-embeddings (adapter + Bedrock Titan)
│   ├── llm/                   # @phila/llm (adapter + Bedrock Claude)
│   ├── bedrock-client/        # @phila/bedrock-client (shared lazy SDK client)
│   └── parse/                 # @phila/search-parse (HTML→markdown pipeline)
├── cdk/                       # AWS CDK infrastructure
│   └── app.ts                 # Stack definition
├── docs/                      # Documentation (you are here)
└── city.config.json           # phila-ctl deployment config
```
