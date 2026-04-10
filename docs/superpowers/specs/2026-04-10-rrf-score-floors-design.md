# RRF Fusion and Score Floors Design

## Problem

Min-max normalization inflates weak signals during hybrid search. The vector pass always returns 200 nearest neighbors regardless of actual relevance. Min-max scales those to [0, 1], making the "best" of a bad set score 1.0. At 40% blend weight, marginally-relevant vector matches push irrelevant results into the final set. Queries like "rats" surfacing "lactation support" is a symptom.

## Solution

Replace min-max normalization and alpha blending with Reciprocal Rank Fusion (RRF). Add configurable per-pass score floors that gate out weak candidates before fusion.

## Pipeline

```
retrieve(bm25?, vector?) → filter(score floors) → fuse(RRF) → [rerank] → deduplicate → limit → return
```

- `mode` controls which retrievers run (bm25, semantic, hybrid) — already implemented
- Score floors discard candidates below a raw score threshold before fusion
- RRF assigns rank-based scores: `score = w / (k + rank)` per retriever, summed across retrievers
- `[rerank]` is a no-op seam — a clear point in the pipeline where a cross-encoder or similar reranker would be inserted in the future. No reranker is implemented now.
- Deduplication keeps the highest-scoring segment per document
- Single-mode (bm25 or semantic) uses the same RRF formula with one retriever

## RRF Formula

For each candidate segment, across retrievers `r` that returned it:

```
score = Σ w_r / (k + rank_r)
```

- `k` = 60 (configurable via `rrf_k`)
- `w_r` = per-retriever weight from `rrf_weights`
- `rank_r` = 1-based position in that retriever's result list, sorted by raw score descending
- Segments not returned by a retriever receive no contribution from that retriever (not rank=∞, just absent from the sum)

## Config Changes

### Removed

| Field | Reason |
|-------|--------|
| `blend_alpha` | Replaced by RRF weights. Existing stored values become inert. |

### Added

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `rrf_k` | number | 60 | RRF ranking constant. Higher values smooth rank differences. |
| `rrf_weights` | `{ bm25: number, vector: number }` | `{ bm25: 1.0, vector: 1.0 }` | Per-retriever weight in the RRF formula. |
| `min_bm25_score` | number | 0 | Raw BM25F score floor. Candidates below this are excluded before fusion. 0 = off. |
| `min_vector_score` | number | 0 | Cosine similarity floor. Candidates below this are excluded before fusion. 0 = off. |

All fields follow the existing `config.field ?? default` pattern. No migration needed — stale `blend_alpha` values in stored configs are harmlessly ignored.

## Code Changes

### `services/search.ts`

- Remove `normalizeScores` import and all min-max normalization logic
- Remove alpha blending logic
- After each retrieval pass, apply score floor filter (discard candidates below `min_bm25_score` or `min_vector_score`)
- Assign 1-based ranks to each pass's candidates (sorted by raw score descending)
- Compute RRF score per segment by summing `w / (k + rank)` across passes
- Single-mode: same formula, one retriever contributing

### `services/score.ts`

- Remove `normalizeScores` function (no longer used)

### `types.ts`

- Update `IndexConfig`: remove `blend_alpha`, add `rrf_k`, `rrf_weights`, `min_bm25_score`, `min_vector_score`

### `config.ts`

- Update default config: remove `blend_alpha`, add new field defaults

### `routes/search.ts`

- No changes needed (mode param already wired)

### `dev/search.html`

- No changes needed (mode selector already present)

### Documentation

- `docs/search.md`: Replace scoring parameters table and hybrid search explanation. Remove blend_alpha, add RRF description and new parameters.
- `docs/architecture.md`: Update design decisions section — replace min-max rationale with RRF rationale. Update config fields in schema section.
- `docs/getting-started.md`: Update if blend_alpha is referenced in any examples.
- `README.md`: Update hybrid search description in key concepts if needed.

## Testing

1. **RRF produces rank-based scores** — verify scores follow `w/(k+rank)` pattern
2. **Weak vector candidates don't inflate** — hybrid search for a nonsense query should not surface high-scoring garbage from the vector pass
3. **RRF weights shift ranking** — higher bm25 weight promotes keyword matches relative to semantic-only matches
4. **Score floors filter pre-fusion** — candidates below floor absent from results
5. **Single-mode uses single-retriever RRF** — consistent scoring formula regardless of mode
6. **Existing tests stay green** — deduplication and basic ordering for well-matched queries should hold (absolute scores will change)

## Not In Scope

- Reranking implementation (just the seam in the pipeline)
- Dynamic weight adjustment based on query characteristics (e.g., stop word ratio)
- Fusion strategy configurability (min-max is fully replaced, not kept as an option)
