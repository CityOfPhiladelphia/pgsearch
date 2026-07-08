<!-- ABOUTME: Guide for understanding and tuning pgsearch hybrid search behavior. -->
<!-- ABOUTME: Covers scoring parameters, design decisions, and practical tuning advice. -->

# Search Behavior and Tuning

This guide explains how pgsearch ranks results and how to adjust scoring to improve result quality for your index. It assumes your index is already set up and ingesting documents. If you haven't done that yet, see [Getting Started](getting-started.md).

---

## How Hybrid Search Works

Each query runs two independent retrieval passes, then combines the results into a single ranked list.

1. **BM25F pass** — full-text keyword search. PostgreSQL tsvectors match stemmed query terms against title and body fields. Title matches are weighted 3x by default.

2. **Vector pass** — semantic similarity. The query is embedded and compared against document segment embeddings using pgvector HNSW cosine similarity.

3. **Score floors** — each pass's candidates are filtered by a minimum score threshold. Candidates below the floor are excluded before fusion. Defaults are off (0).

4. **RRF fusion** — results from each pass are independently ranked by raw score. The final score uses Reciprocal Rank Fusion:
   ```
   score = w_bm25 / (k + bm25_rank) + w_vector / (k + vector_rank)
   ```
   Candidates appearing in both passes get contributions from both, naturally ranking higher. See [RRF on Wikipedia](https://en.wikipedia.org/wiki/Reciprocal_rank_fusion) for background.

5. **Per-document cap** — `hybridSearch` caps how many segments survive per document. The default is 1 (best segment per doc), which is what the `/public/search/:name` route uses. RAG callers (see `docs/rag.md`) pass a higher cap so multiple sections of the same source can contribute to LLM context. The total result count is still bounded by `limit`.

---

## Scoring Parameters

Each index has its own set of scoring parameters. You can adjust them independently per index using the PATCH endpoint (see below).

| Parameter | Default | Description |
|-----------|---------|-------------|
| `rrf_k` | `60` | RRF smoothing constant. Higher values reduce the influence of top-ranked results. |
| `rrf_weights.bm25` | `1.0` | Weight multiplier for the BM25F rank contribution. Increase to favor keyword matches. |
| `rrf_weights.vector` | `1.0` | Weight multiplier for the vector rank contribution. Increase to favor semantic matches. |
| `min_bm25_score` | `0` | Minimum raw BM25F score. Candidates below this floor are excluded before fusion. |
| `min_vector_score` | `0` | Minimum raw vector similarity score. Candidates below this floor are excluded before fusion. |
| `field_weights.title` | `3.0` | BM25F weight multiplier for title matches. |
| `field_weights.body` | `1.0` | BM25F weight multiplier for body matches. |
| `bm25_k1` | `1.2` | Term frequency saturation. Higher values let repeated terms matter more. Defaults work well for most content. |
| `bm25_b` | `0.75` | Document length normalization. `1.0` = full normalization, `0.0` = none. Defaults work well for most content. |
| `text_search_config` | `'english'` | PostgreSQL text search configuration. Controls stemming and stop words. Change for non-English content. |

For deep background on `k1` and `b`, see [BM25 on Wikipedia](https://en.wikipedia.org/wiki/Okapi_BM25).

### Updating Parameters

Use PATCH on your index to update any parameter:

```bash
curl -X PATCH https://<api-url>/private/key/admin/indexes/my-index \
  -H "x-api-key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"rrf_weights": {"bm25": 2.0}}'
```

Changes take effect immediately for new queries.

---

## What's Opinionated

These are design decisions baked into pgsearch and why they were made:

- **Reciprocal Rank Fusion (RRF)** — scores from each pass are combined by rank position rather than raw score magnitude. Robust to outliers and score distribution differences between retrievers. Trade-off: discards score magnitude information, treating all scores as rank positions. For municipal-scale content, this robustness matters more than magnitude sensitivity.

- **Title embedded with segments** — each segment's embedding is computed from `"Document Title\n\nbody segment text"` (title prepended directly, no label prefix). This gives the vector model document-level context for each chunk.

- **One result per document by default** — the best-scoring segment wins. The internal `maxChunksPerDoc` knob lifts this cap (used by RAG to pull multiple sections from a source); the search route always uses the default of 1.

- **Segment size (~1000-token budget)** — the chunker sizes segments by a byte-based token estimate (`ceil(UTF-8 bytes / 3)`), which upper-bounds real embedding tokens without local tokenization. Balances embedding quality with context preservation. Configurable via `max_segment_tokens`.

---

## Things to Be Aware Of

- **Scores are rank-derived, not magnitude-based.** RRF scores reflect rank position, not raw relevance magnitude. A higher score means better rank across retrievers, but scores are not directly comparable across different queries.

- **Results are per-document, not per-segment.** A long document with multiple matching sections returns once. The snippet is the best-matching segment.

- **Stemming depends on `text_search_config`.** The default `'english'` config stems words (e.g., "running" → "run") and removes English stop words. If your content is multilingual or domain-specific, this matters.

- **BM25F statistics are maintained incrementally.** Term-frequency and average-length statistics are updated transactionally on every ingest and delete, so BM25F scoring always uses current IDF values without a separate refresh step. If drift is ever suspected, `POST /private/key/admin/indexes/<name>/reconcile` rebuilds them from source.
