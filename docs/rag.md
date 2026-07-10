<!-- ABOUTME: Guide to using the RAG endpoint — prompts, keys, request shape, response shape. -->
<!-- ABOUTME: Layered atop the hybrid search pipeline. -->

# RAG

Retrieval-augmented generation (RAG) layered atop hybrid search. The RAG endpoint retrieves the top chunks for a question from an index, sends them to an LLM with a stored prompt, and returns a synthesized answer with inline citations to source documents.

## Key concepts

- **Prompt** — a per-index entity (`rag_prompts` table). Carries the system prompt, response format hint, model ID, generation params, and retrieval params. Callers reference prompts by name via query string.
- **RAG key** — `x-rag-key`, minted lazily by admin per index. Separate from `x-search-key` and `x-index-key`. Lets you grant and revoke LLM-spend access independently of read access.
- **Inline citations** — the LLM is instructed to cite sources as `[N]` matching the 1-indexed `Source [N]:` blocks it received. The response parses these markers into a `citations` array.

## Prerequisites for a new AWS account

Before any Anthropic model call will succeed on a fresh Bedrock-enabled account:

1. **Model access** — request access to the Claude model family in the Bedrock console (us-east-1 → Model access). System-defined inference profiles inherit access from their underlying foundation models.
2. **Anthropic use-case details form** — Bedrock requires a one-time form submission per account before Anthropic models will respond. Takes a few minutes; propagation can take up to 15 minutes.
3. **Marketplace permissions on the Lambda role** — Anthropic models are delivered via AWS Marketplace; the execution role needs `aws-marketplace:ViewSubscriptions` and `aws-marketplace:Subscribe` in addition to `bedrock:InvokeModel`. The CDK in `cdk/app.ts` already grants these.
4. **Model-specific IAM** — for inference profile IDs (e.g., `us.anthropic.claude-haiku-4-5-...`), the role needs `bedrock:InvokeModel` on **both** the profile ARN and the underlying foundation model ARN in **every region the profile may route to** (us-east-1, us-east-2, us-west-2 for `us.*`). Adding a new Claude model means updating the CDK ARN list.

## Choosing a model ID

Bedrock now requires inference profiles for most current Claude models. Use the profile ID (e.g., `us.anthropic.claude-haiku-4-5-20251001-v1:0`), not the raw foundation model ID. The adapter accepts both `anthropic.*` (legacy direct-invoke) and `<region>.anthropic.*` (inference profile) shapes.

To list available profiles:

```bash
aws bedrock list-inference-profiles --query "inferenceProfileSummaries[].inferenceProfileId"
```

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
    "name": "support",
    "content": {
      "system": "You are a support assistant. Answer concisely using only the provided sources. If the answer is not in the sources, say so and recommend who to contact.",
      "response_format": "Cite sources inline as [N] matching the Source [N] numbers above.",
      "model": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
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
curl -X POST "https://<api-url>/public/rag/my-index?prompt=support" \
  -H "x-rag-key: $RAG_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "question": "How do I reset my account password?" }'
```

Response:

```json
{
  "answer": "Submit a reset request through the account portal [1]. The reset link is sent to your verified email within five minutes [2].",
  "citations": [
    { "marker": 1, "external_id": "account-reset", "title": "...", "url": "...", "snippet": "..." },
    { "marker": 2, "external_id": "email-delivery", "title": "...", "url": "...", "snippet": "..." }
  ],
  "retrieved": [
    { "external_id": "account-reset", "score": 0.83, "used": true },
    { "external_id": "email-delivery", "score": 0.71, "used": true }
  ],
  "model": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  "prompt": "support",
  "usage": { "input_tokens": 2341, "output_tokens": 187 }
}
```

## Multi-turn

The endpoint is stateless. To carry conversation history, pass prior turns in `messages`:

```json
{
  "question": "What if the email doesn't arrive?",
  "messages": [
    { "role": "user", "content": "How do I reset my account password?" },
    { "role": "assistant", "content": "Submit a reset request through the account portal..." }
  ]
}
```

Retrieval still runs against the latest `question` only — searching the full history is noisy. The LLM sees the full conversation plus the freshly retrieved context.

## Prompt management

```bash
# List
curl https://<api-url>/public/index/my-index/prompts -H "x-index-key: $INDEX_KEY"

# Read
curl https://<api-url>/public/index/my-index/prompts/support -H "x-index-key: $INDEX_KEY"

# Update (replace content)
curl -X PATCH https://<api-url>/public/index/my-index/prompts/support \
  -H "x-index-key: $INDEX_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content": {...}}'

# Delete
curl -X DELETE https://<api-url>/public/index/my-index/prompts/support \
  -H "x-index-key: $INDEX_KEY"
```

## Revoke RAG access

```bash
curl -X DELETE https://<api-url>/private/key/admin/indexes/my-index/rag-key \
  -H "x-api-key: $ADMIN_KEY"
```

Nulls the stored hash. The endpoint will return 401 (`Invalid RAG key`) until a new key is minted.

## What's opinionated

- **Per-index prompts.** Prompts can't be shared across indexes in v1. If you need the same prompt against `services-en` and `services-es`, duplicate it.
- **Prompt is the only tunable surface.** Model, temperature, retrieval params all live on the prompt. To experiment with a different model, create another prompt.
- **Inline `[N]` markers.** Citations are parsed from `[N]` in the answer text. Other formats (footnotes, brackets with text) are ignored.
- **Synchronous response.** No streaming yet. Expect ~3–10s for typical Claude Haiku responses.
- **Per-prompt model selection.** The prompt record controls the model. Different use cases get different prompts, not different request parameters.
- **Caller-owned history.** Pass `messages`; the server never stores them.

## Things to be aware of

- **Cost.** LLM calls are 100–1000× the cost of an embedding call. The separate `x-rag-key` makes RAG traffic auditable; budget accordingly.
- **Trusted callers.** The `messages` array is not validated for role alternation or signed. A misbehaving caller can fabricate prior turns. Acceptable for internal tools.
- **No quotas in v1.** Revoke the key if something runs away.
- **Per-doc cap matters.** With `max_chunks_per_doc: 3`, a single large document (e.g., a chunked PDF) can contribute at most 3 segments to context, preserving diversity.
