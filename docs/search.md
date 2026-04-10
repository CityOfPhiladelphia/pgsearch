<!-- ABOUTME: Guide for understanding and tuning pgsearch hybrid search behavior. -->
<!-- ABOUTME: Covers scoring parameters, design decisions, and practical tuning advice. -->

# Search Behavior and Tuning

This guide explains how pgsearch ranks results and how to adjust scoring to improve result quality for your index. It assumes your index is already set up and ingesting documents. If you haven't done that yet, see [Getting Started](getting-started.md).

---

## How Hybrid Search Works

Each query runs two independent retrieval passes, then blends the results into a single ranked list.

1. **BM25F pass** — full-text keyword search. PostgreSQL tsvectors match stemmed query terms against title and body fields. Title matches are weighted 3x by default.

2. **Vector pass** — semantic similarity. The query is embedded and compared against document segment embeddings using pgvector HNSW cosine similarity.

3. **Score normalization** — each pass's scores are independently normalized to [0, 1] using min-max normalization.

4. **Blending** — the two normalized scores are combined:
   ```
   final score = blend_alpha × normalized_bm25 + (1 − blend_alpha) × normalized_vector
   ```

5. **Deduplication** — one result per document. When multiple segments of the same document match, only the highest-scoring segment is returned (as the snippet).

---

## Scoring Parameters

Each index has its own set of scoring parameters. You can adjust them independently per index using the PATCH endpoint (see below).

| Parameter | Default | Description |
|-----------|---------|-------------|
| `blend_alpha` | `0.6` | Weight given to keyword (BM25F) vs. semantic (vector) scores. Higher values favor exact keyword matches; lower values favor meaning-based matches. Start here if results feel wrong. |
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
  -d '{"blend_alpha": 0.4}'
```

Changes take effect immediately for new queries.

---

## What's Opinionated

These are design decisions baked into pgsearch and why they were made:

- **Min-max normalization** — scores from each pass are independently scaled to [0, 1] before blending. Simple and interpretable. Trade-off: sensitive to outliers. Alternative approaches like Reciprocal Rank Fusion (RRF) exist but add complexity without clear benefit at this scale.

- **Title embedded with segments** — each segment's embedding is computed from `"Document Title\n\nbody segment text"` (title prepended directly, no label prefix). This gives the vector model document-level context for each chunk.

- **One result per document** — the best-scoring segment wins. Multiple matching sections from the same document don't produce multiple results.

- **Segment size ~500 words** — the chunker uses whitespace-delimited word count (not model tokenization). Balances embedding quality with context preservation. Configurable via `max_segment_tokens`.

---

## Things to Be Aware Of

- **Scores are relative, not absolute.** Min-max normalization means scores reflect position within the current result set. A score of 0.9 in one query is not comparable to 0.9 in another.

- **Results are per-document, not per-segment.** A long document with multiple matching sections returns once. The snippet is the best-matching segment.

- **Stemming depends on `text_search_config`.** The default `'english'` config stems words (e.g., "running" → "run") and removes English stop words. If your content is multilingual or domain-specific, this matters.

- **BM25F statistics require refresh.** Term frequency stats are materialized. After significant ingestion, refresh the index so BM25F scoring uses current IDF values. Auto-refresh triggers after `refresh_threshold` (default 100) document changes.
