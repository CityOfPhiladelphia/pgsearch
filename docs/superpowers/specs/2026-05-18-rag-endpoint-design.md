# RAG Endpoint Design

## Problem

pgsearch returns ranked passages. Consumers building user-facing tools — starting with an internal digital navigator for City of Philadelphia employees — need synthesized natural-language answers grounded in those passages, with citations back to source documents. Today every consumer would have to wire its own retrieval-augmented generation (RAG) pipeline against the search API, duplicating prompt management, LLM client setup, and citation logic per consumer.

A first-class RAG endpoint puts the synthesis primitive in the same place as the retrieval primitive, behind the same multi-tenant model, with prompts as inspectable index-owned entities rather than scattered application code.

## Goals

- Layer cleanly atop the existing hybrid search pipeline. No changes to current search semantics for existing callers.
- Prompts are first-class, index-scoped database entities. Callers reference them by name via query string.
- Model and retrieval tuning live on the prompt record. The API has one tunable surface, not five.
- Pluggable LLM adapter mirroring `EmbeddingAdapter`. Bedrock first.
- Synchronous JSON response. Streaming deferred.
- Stateless multi-turn: callers carry conversation history.
- Separable credentials so LLM-spend access can be granted and revoked independently of read access.

## Non-Goals (v1)

- Response streaming (SSE / API Gateway response transfer mode). Adds Hono `streamHandle`, `awslambda.streamifyResponse`, and an upstream `LambdaPostgresApi` construct change. Revisit if latency UX bites.
- Prompt composition / inheritance. JSONB content shape is the forward hook.
- Server-side conversation sessions. Caller owns history.
- Token quotas, rate limiting, per-key cost caps. Key separation makes RAG traffic attributable so these can land later non-breakingly.
- Tool use / function calling.
- Per-query model or retrieval overrides via query string. Create another prompt.
- Cross-index RAG. Single-index only, matching the rest of the service.
- HMAC-signed conversation history (`history_sig`). Field reserved in response payload as `null`.

## Architecture

```
POST /public/rag/:name?prompt=<name>
  ├─ auth: x-rag-key → bcrypt verify against rag_key_hash (null = disabled)
  ├─ load prompt record from rag_prompts (index_id, name)
  ├─ retrieval: hybridSearch(query=latestQuestion, prompt.retrieval, maxChunksPerDoc)
  ├─ render context block: Source [N]: {title}\n{body}
  ├─ build messages: [system, ...caller.messages, {role:'user', content: contextBlock + question}]
  ├─ llmAdapter.complete(...)
  ├─ parse cited [N] markers → citations[]; remaining retrieved get used:false
  └─ return { answer, citations, retrieved, usage, model, prompt, history_sig: null }
```

All other routes unchanged.

## Data Model

### `search_indexes` (modified)

Add one column:

| Column | Type | Notes |
|--------|------|-------|
| `rag_key_hash` | `TEXT NULL` | Null = RAG disabled for this index. Lazy-minted via admin endpoint. |

No migration needed for existing indexes — `NULL` is the disabled state.

### `rag_prompts` (new)

| Column | Type | Notes |
|--------|------|-------|
| `prompt_id` | `UUID PK` | Stable ID independent of name; future composition can reference this. |
| `index_id` | `INT NOT NULL REFERENCES search_indexes` | Index owns its prompts. |
| `name` | `TEXT NOT NULL` | Caller-facing identifier. |
| `content` | `JSONB NOT NULL` | Full prompt assembly — see schema below. |
| `created_at`, `updated_at` | `TIMESTAMPTZ` | Standard. |
| `UNIQUE (index_id, name)` | | |

`prompt_id` (not `(index_id, name)`) is the primary key so future composition features can reference a prompt by ID without depending on name stability.

### `content` JSONB shape (v1)

```json
{
  "system": "You are the City of Philadelphia digital navigator...",
  "response_format": "Cite sources inline as [N] matching Source [N] numbers above.",
  "model": "anthropic.claude-haiku-4-5",
  "max_tokens": 1024,
  "temperature": 0.2,
  "retrieval": {
    "mode": "hybrid",
    "limit": 8,
    "max_chunks_per_doc": 3,
    "min_bm25_score": 0,
    "min_vector_score": 0
  }
}
```

JSONB rather than columns so composition fields (`extends`, `includes`, named fragments) can be added without schema migrations. Chunk-into-context formatting is **not** templatable in v1 — server renders a fixed `Source [N]: {title}\n{body}` block. A `context_template` field can be added later if real demand emerges.

## HTTP Routes

### RAG synthesis

```
POST /public/rag/:name?prompt=<promptName>
Headers: x-rag-key: rag_...
Body: { "question": "...", "messages"?: [{"role": "user"|"assistant", "content": "..."}, ...] }
```

`POST` (not `GET`) because the `messages` array doesn't belong in a query string.

### Prompt CRUD (gated by `x-index-key`)

```
POST   /public/index/:name/prompts                         create
GET    /public/index/:name/prompts                         list
GET    /public/index/:name/prompts/:promptName             read
PATCH  /public/index/:name/prompts/:promptName             update
DELETE /public/index/:name/prompts/:promptName             delete
```

The team that owns the index owns its prompts. Same auth surface as ingest. If a separate "prompt admin" role becomes useful later, add a key without rebuilding routes.

### RAG key management (gated by API Gateway `x-api-key`)

```
POST   /private/key/admin/indexes/:name/rag-key            mint (returns key once, stores bcrypt hash)
DELETE /private/key/admin/indexes/:name/rag-key            revoke (sets rag_key_hash = NULL)
```

Lazy creation: indexes that don't use RAG never carry an unused credential.

## Response Shape

```json
{
  "answer": "You can apply for a parking permit online [1]. Veterans qualify for a reduced fee [2].",
  "citations": [
    {
      "marker": 1,
      "external_id": "parking-permit-apply",
      "title": "Apply for a Parking Permit",
      "url": "https://phila.gov/...",
      "snippet": "..."
    },
    {
      "marker": 2,
      "external_id": "veterans-benefits",
      "title": "...",
      "url": "...",
      "snippet": "..."
    }
  ],
  "retrieved": [
    { "external_id": "parking-permit-apply", "score": 0.83, "used": true },
    { "external_id": "veterans-benefits",    "score": 0.71, "used": true },
    { "external_id": "city-fees-overview",   "score": 0.42, "used": false }
  ],
  "model": "anthropic.claude-haiku-4-5",
  "prompt": "navigator",
  "usage": { "input_tokens": 2341, "output_tokens": 187 },
  "history_sig": null
}
```

Choices:

- **`citations` vs `retrieved` are separate.** `citations` carries only chunks the LLM actually referenced (with full snippet for rendering). `retrieved` is everything sent to the model — `external_id`, `score`, `used` only. Lean payload; caller can fetch full chunks by `external_id` if needed.
- **Citation marker parsing** is regex `\[(\d+)\]` against the answer text, deduplicated. Markers that point to nonexistent source numbers are dropped silently.
- **`usage` always present.** No quotas in v1, but token counts let callers build cost dashboards from response data alone.
- **`history_sig: null`** is a reserved placeholder for future HMAC-signed history. Callers can ignore it today; adding the value later is non-breaking.
- **Echoed `prompt` and `model`** make responses self-describing for logs.

## LLM Adapter

New workspace package `packages/llm`:

```typescript
interface LlmAdapter {
  complete(input: {
    system: string
    messages: { role: 'user' | 'assistant', content: string }[]
    max_tokens: number
    temperature: number
  }): Promise<{
    text: string
    usage: { input_tokens: number, output_tokens: number }
    model: string
  }>
  model: string
}
```

First concrete adapter: `BedrockLlmAdapter`, using the Bedrock Messages API for Claude. Other model families (Titan, Llama) are not implemented in v1 — add adapters or extend body shaping when actually needed.

### DRY with `packages/embeddings`

Honest assessment: the two adapters have very different request and response shapes. The only meaningful shared concern is **lazy Bedrock client construction** (the `await import('@aws-sdk/client-bedrock-runtime')` dance both adapters do).

Extract a tiny `packages/bedrock-client` exporting a single `getBedrockClient(region)` memoized factory. Both `BedrockEmbeddingAdapter` and `BedrockLlmAdapter` consume it. No grander abstraction; the surface is too different to share more.

### Adapter factory

`apps/api/services/llm-adapter.ts`, mirroring the existing `services/adapter.ts`:

```typescript
export function getLlmAdapter(content: PromptContent): LlmAdapter
```

Throws on unsupported models. No silent fallback.

## Retrieval Changes

### `hybridSearch` option: `maxChunksPerDoc`

Replace the implicit "best segment per document" dedup with an explicit cap. The boolean `dedupe` was a degenerate case of this number.

| Old behavior | New behavior |
|---|---|
| Always keep best segment per doc | `maxChunksPerDoc?: number`, default `1` |
| | Search routes unchanged (default preserves current behavior) |
| | RAG passes `prompt.retrieval.max_chunks_per_doc ?? 3` |

Flow: score all candidates → group by `document_id` → keep top-N per doc by score → take overall top `limit`. The two caps (`limit` total, `maxChunksPerDoc` per doc) work together.

**Why the cap matters for RAG:** a single source — like a 1000-page PDF chunked into 200+ segments — could otherwise dominate retrieval and crowd out other relevant documents. The cap preserves diversity.

### Default retrieval block on prompts

| Field | Default | Rationale |
|---|---|---|
| `mode` | `hybrid` | Same default as search. |
| `limit` | `8` | ~4K tokens of context at ~500 tokens/chunk; comfortable headroom on any modern model. |
| `max_chunks_per_doc` | `3` | Most answers live in 1–3 sections of one source. |
| `min_bm25_score`, `min_vector_score` | `0` | Inherit existing search-config defaults. |

## Request → Response Flow

1. **Auth.** Verify `x-rag-key` against `rag_key_hash`. Reject if column is null (RAG not enabled).
2. **Load prompt.** Look up `(index_id, ?prompt=<name>)` in `rag_prompts`. 404 if missing.
3. **Retrieve.** `hybridSearch(pool, index_id, embeddingAdapter, latestQuestion, { ...prompt.retrieval, maxChunksPerDoc })`. The "latest question" is `body.question`; retrieval is **not** run against the full message history (noisy).
4. **Render context.** For each retrieved chunk, emit `Source [N]: {title}\n{body}` (1-indexed, separated by blank lines).
5. **Build messages.** Prepend `system` from prompt. Append caller's `messages` (already in `{role, content}` shape). Append final user turn:
   ```
   {context block}

   {prompt.response_format}

   Question: {body.question}
   ```
6. **LLM call.** `llmAdapter.complete({ system, messages, max_tokens, temperature })` using the prompt's model and generation params.
7. **Parse citations.** Regex `\[(\d+)\]` against the answer text → unique sorted set of marker integers. For each marker, hydrate citation entry from the retrieved chunk at that index. Markers pointing to nonexistent sources are dropped.
8. **Build `retrieved` array.** Every retrieved chunk gets an entry with `used: true` if its 1-indexed position is in the cited set.
9. **Return.**

## Demo HTML

`apps/api/dev/rag.html`, sibling to `apps/api/dev/search.html`. Same localStorage pattern. Adds:

- Inputs: `x-rag-key`, prompt name.
- Conversation pane (caller-managed history, JS array).
- Answer pane: renders text with citation markers as superscript links to the citations list below.
- `retrieved` shown collapsed by default; click to expand.

Open via `file://`, never served in production. Matches the existing `search.html` conventions.

## Documented Tradeoffs

- **Stateless multi-turn means caller-supplied history is trusted.** A misbehaving caller can inject "assistant" turns saying whatever they want. Acceptable for an internal tool; future HMAC-signed `history_sig` can lock this down without API breakage (field already in response).
- **Per-index prompts only.** Cross-index sharing and composition deferred. JSONB content shape is the forward hook so additions don't require migrations.
- **No per-query model/retrieval overrides.** Create another prompt instead. Keeps the prompt as the single tunable surface; avoids API parameter sprawl.
- **Synchronous JSON response.** Streaming would require Hono `streamHandle`, `awslambda.streamifyResponse`, and changes to the upstream `LambdaPostgresApi` construct. Latency UX is acceptable for v1 prototype.
- **No quotas / rate limiting.** Key separation guarantees attribution; quotas can land later without breaking the API contract.
- **Prompt CRUD via `x-index-key`.** The team that owns the index owns its prompts. Adding a dedicated "prompt admin" key later is additive.
- **Chunk formatting not templatable.** Fixed `Source [N]: {title}\n{body}`. A `context_template` field can be added when real demand emerges.

## Testing

1. **Adapter unit tests.** `BedrockLlmAdapter` request/response shaping (mocked Bedrock client at the SDK boundary, not the adapter interface).
2. **Citation parsing.** Marker regex extracts, dedupes, drops out-of-range markers.
3. **Retrieval dedup cap.** `hybridSearch` with `maxChunksPerDoc: N` returns at most N segments per `document_id` and preserves top-by-score ordering within doc groups.
4. **RAG flow integration test.** Fixed prompt, fixed retrieval set (deterministic embedding adapter), mocked LLM returning a known answer with markers — verify response shape, citations, `used` flags, `usage` passthrough.
5. **Auth gating.** `x-rag-key` required; `x-search-key` rejected on RAG endpoint; null `rag_key_hash` returns 403.
6. **Prompt CRUD.** Create/read/update/delete with `x-index-key` enforcement; `(index_id, name)` uniqueness enforced.
7. **Admin key mint/revoke.** Mint returns plaintext once; subsequent reads of the index don't surface the plaintext; revoke nulls the hash.

## Open Questions / Future Work

- **Streaming.** Will become uncomfortable past ~5s LLM latency on long answers. Reserved for a follow-up spec.
- **HMAC-signed history.** Lock down stateless multi-turn against tampering. Response field already reserved.
- **Prompt composition.** `extends`, `includes`, named fragments — JSONB shape makes this additive.
- **Token quotas / rate limits per RAG key.** Pre-requisite for opening RAG to less-trusted consumers.
- **Adjacent-segment expansion.** Optionally pull neighboring segments around a hit to widen context. Out of v1.
- **Cost telemetry.** Log per-call `usage` to CloudWatch metrics for cost dashboards. Out of v1 spec but worth a follow-up issue.
