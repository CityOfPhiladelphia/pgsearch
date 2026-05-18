<!-- ABOUTME: Guide to using the RAG endpoint — prompts, keys, request shape, response shape. -->
<!-- ABOUTME: Layered atop the hybrid search pipeline. -->

# RAG

Retrieval-augmented generation (RAG) layered atop hybrid search. The RAG endpoint retrieves the top chunks for a question from an index, sends them to an LLM with a stored prompt, and returns a synthesized answer with inline citations to source documents.

## Key concepts

- **Prompt** — a per-index entity (`rag_prompts` table). Carries the system prompt, response format hint, model ID, generation params, and retrieval params. Callers reference prompts by name via query string.
- **RAG key** — `x-rag-key`, minted lazily by admin per index. Separate from `x-search-key` and `x-index-key`. Lets you grant and revoke LLM-spend access independently of read access.
- **Inline citations** — the LLM is instructed to cite sources as `[N]` matching the 1-indexed `Source [N]:` blocks it received. The response parses these markers into a `citations` array.

## Enable RAG for an index

```bash
# Mint a RAG key (lazy — only indexes that need RAG get one)
curl -X POST https://<api-url>/private/key/admin/indexes/my-index/rag-key \
  -H "x-api-key: $ADMIN_KEY"
# → {"rag_key":"rag_..."}
```

Save the returned key; the plaintext is only shown once.

## Create a prompt

```bash
curl -X POST https://<api-url>/public/index/my-index/prompts \
  -H "x-index-key: $INDEX_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "navigator",
    "content": {
      "system": "You are the City of Philadelphia digital navigator. Answer concisely using only the provided sources. If the answer is not in the sources, say so.",
      "response_format": "Cite sources inline as [N] matching the Source [N] numbers above.",
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
  }'
```

## Ask a question

```bash
curl -X POST "https://<api-url>/public/rag/my-index?prompt=navigator" \
  -H "x-rag-key: $RAG_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "question": "How do I apply for a parking permit?" }'
```

Response:

```json
{
  "answer": "You can apply online or in person at the Streets Department [1]. Veterans qualify for a reduced fee [2].",
  "citations": [
    { "marker": 1, "external_id": "parking-apply", "title": "...", "url": "...", "snippet": "..." },
    { "marker": 2, "external_id": "parking-veterans", "title": "...", "url": "...", "snippet": "..." }
  ],
  "retrieved": [
    { "external_id": "parking-apply", "score": 0.83, "used": true },
    { "external_id": "parking-veterans", "score": 0.71, "used": true }
  ],
  "model": "anthropic.claude-haiku-4-5",
  "prompt": "navigator",
  "usage": { "input_tokens": 2341, "output_tokens": 187 },
  "history_sig": null
}
```

## Multi-turn

The endpoint is stateless. To carry conversation history, pass prior turns in `messages`:

```json
{
  "question": "What about for veterans?",
  "messages": [
    { "role": "user", "content": "How do I apply for a parking permit?" },
    { "role": "assistant", "content": "You can apply online..." }
  ]
}
```

Retrieval still runs against the latest `question` only — searching the full history is noisy. The LLM sees the full conversation plus the freshly retrieved context.

## Prompt management

```bash
# List
curl https://<api-url>/public/index/my-index/prompts -H "x-index-key: $INDEX_KEY"

# Read
curl https://<api-url>/public/index/my-index/prompts/navigator -H "x-index-key: $INDEX_KEY"

# Update (replace content)
curl -X PATCH https://<api-url>/public/index/my-index/prompts/navigator \
  -H "x-index-key: $INDEX_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content": {...}}'

# Delete
curl -X DELETE https://<api-url>/public/index/my-index/prompts/navigator \
  -H "x-index-key: $INDEX_KEY"
```

## Revoke RAG access

```bash
curl -X DELETE https://<api-url>/private/key/admin/indexes/my-index/rag-key \
  -H "x-api-key: $ADMIN_KEY"
```

Nulls the stored hash. The endpoint will return 403 with "RAG is not enabled for this index" until a new key is minted.

## What's opinionated

- **Per-index prompts.** Prompts can't be shared across indexes in v1. If you need the same prompt against `services-en` and `services-es`, duplicate it.
- **Prompt is the only tunable surface.** Model, temperature, retrieval params all live on the prompt. To experiment with a different model, create another prompt.
- **Inline `[N]` markers.** Citations are parsed from `[N]` in the answer text. Other formats (footnotes, brackets with text) are ignored.
- **Synchronous response.** No streaming yet. Expect ~3–10s for typical Claude Haiku responses.
- **Caller-owned history.** Pass `messages`; the server never stores them.

## Things to be aware of

- **Cost.** LLM calls are 100–1000× the cost of an embedding call. The separate `x-rag-key` makes RAG traffic auditable; budget accordingly.
- **Trusted callers.** The `messages` array is not validated for role alternation or signed. A misbehaving caller can fabricate prior turns. Acceptable for internal tools.
- **No quotas in v1.** Revoke the key if something runs away.
- **Per-doc cap matters.** With `max_chunks_per_doc: 3`, a single large document (e.g., a chunked PDF) can contribute at most 3 segments to context, preserving diversity.
