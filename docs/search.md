<!-- ABOUTME: Guide for understanding and tuning pgsearch hybrid search behavior. -->
<!-- ABOUTME: Covers scoring parameters, design decisions, and practical tuning advice. -->

# Search Behavior and Tuning

This guide explains how pgsearch ranks results and how to adjust scoring to improve result quality for your index. It assumes your index is already set up and ingesting documents. If you haven't done that yet, see [Getting Started](getting-started.md).

---

## How Hybrid Search Works

Each query runs two independent retrieval passes, then combines the results into a single ranked list.

1. **Lexical pass** — PostgreSQL full-text search in SQL. Stored tsvectors match stemmed query terms against title and body fields, and matching segments are ranked by `ts_rank_cd` (a cover-density ranker: it rewards query terms appearing close together) with title matches weighted 3x by default — candidates are ordered *before* the candidate limit is applied, so the top lexical matches always enter fusion. There is no BM25 scoring anywhere in the engine.

2. **Vector pass** — semantic similarity. The query is embedded and compared against document segment embeddings by pgvector cosine distance, answered by a per-index HNSW index with recall verified identical to an exact scan. See [Search Performance and the Vector Index](search-performance.md).

3. **Score floors** — each pass's candidates are filtered by a minimum score threshold. Candidates below the floor are excluded before fusion. Defaults are off (0).

4. **RRF fusion** — results from each pass are independently ranked by raw score. The final score uses Reciprocal Rank Fusion:
   ```
   score = w_lexical / (k + lexical_rank) + w_vector / (k + vector_rank)
   ```
   Candidates appearing in both passes get contributions from both, naturally ranking higher. See [RRF on Wikipedia](https://en.wikipedia.org/wiki/Reciprocal_rank_fusion) for background.

5. **Per-document cap** — `hybridSearch` caps how many segments survive per document. The default is 1 (best segment per doc), which is what the `/public/search/:name` route uses. RAG callers (see `docs/rag.md`) pass a higher cap so multiple sections of the same source can contribute to LLM context. The total result count is still bounded by `limit`.

---

## Scoring Parameters

Each index has its own set of scoring parameters. You can adjust them independently per index using the PATCH endpoint (see below).

| Parameter | Default | Description |
|-----------|---------|-------------|
| `rrf_k` | `60` | RRF smoothing constant. Higher values reduce the influence of top-ranked results. |
| `rrf_weights.lexical` | `1.0` | Weight multiplier for the lexical rank contribution. Increase to favor keyword matches. |
| `rrf_weights.vector` | `1.0` | Weight multiplier for the vector rank contribution. Increase to favor semantic matches. |
| `min_lexical_score` | `0` | Minimum raw lexical score. Candidates below this floor are excluded before fusion. |
| `min_vector_score` | `0` | Minimum raw vector similarity score. Candidates below this floor are excluded before fusion. |
| `field_weights.title` | `3.0` | Keyword weight multiplier for title matches. |
| `field_weights.body` | `1.0` | Keyword weight multiplier for body matches. |
| `kind_weights` | `{}` | Per-kind multipliers on the fused score. See [Result-Type Weighting](#result-type-weighting). |
| `recency` | unset | Time-decay rule for dated kinds. See [Recency](#recency). |
| `text_search_config` | `'english'` | PostgreSQL text search configuration. Controls stemming and stop words. Change for non-English content. |

### Updating Parameters

Use PATCH on your index to update any parameter:

```bash
curl -X PATCH https://<api-url>/private/key/admin/indexes/my-index \
  -H "x-api-key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"rrf_weights": {"lexical": 2.0}}'
```

Changes take effect immediately for new queries.

---

## Search Request Parameters

`GET /public/search/:name` accepts:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `q` | required | The search query. |
| `limit` | `10` | Maximum results returned. |
| `mode` | `hybrid` | `hybrid` (both passes fused), `lexical` (full-text only), or `semantic` (vector only). |
| `kinds` | none | Comma-separated kind labels; restricts results to those kinds. Filtering happens in SQL in both passes, so it shapes membership, not just ordering. Documents without a `kind` are excluded when a filter is present. |
| `kind_weights` | none | Per-request replacement for the configured weight map. See [Result-Type Weighting](#result-type-weighting). |
| `recency` | none | Per-request time-decay rule. See [Recency](#recency). |

`kinds` filters; `kind_weights` reorders. A segmented frontend (separate services / news / documents surfaces) wants `kinds` per surface — with news sorted client-side on `metadata.published_at`, which ingest stamps as a fact on dated content.

---

## Result-Type Weighting

Most content corpora carry strata that matter more or less to searchers: a civic site has actionable service pages, department pages, archived documents, and news posts; a records index might stratify as forms, reports, minutes, and notices. pgsearch models this with a freeform `kind` label supplied per document at ingest, and a `kind_weights` map that multiplies each result's fused RRF score by the weight of its kind.

Mechanics:

- Weights multiply the *fused* score, so under `w/(k+r)` scoring a weight acts as a roughly uniform rank shift — at the default `rrf_k` of 60, a weight of `0.85` pushes a result down about 10 ranks. Gentle values go a long way.
- A document with no `kind`, or a kind not listed in the map, is neutral (`1.0`). The feature is strictly opt-in: with no weights configured, nothing changes.
- A weight of `0` effectively removes a kind from results without deleting the documents.
- The engine ships **no default weights** — it has no opinions about labels it doesn't define. Weights live in index config, and each result returns its `kind` so callers can facet.

Search requests can replace the configured map for a single query with the `kind_weights` parameter — useful for faceted UIs and RAG/agent callers that know the searcher's intent, which a single search box doesn't:

```
GET /public/search/my-index?q=police+report&kind_weights=documents:1.2,services:0.9
```

The parameter replaces the whole configured map for that request (pass `kind_weights=` pairs for every kind you want weighted). Weights must be `>= 0`.

As a worked example, phila.gov content classifies by URL path into `services`, `guides`, `departments`, `programs`, `documents`, and `posts` (which absorbs `/news/`, `/press-releases/`, and date-slugged paths), plus `tools` for interactive applications synced from the city's tools directory. Its palette carries only the two entries that earn their keep:

```json
{ "kind_weights": { "tools": 1.3, "posts": 0.85 } }
```

`tools` runs hot because tool docs are one-paragraph shims — they retrieve mid-pack on thin text even when they're the best destination, and with only a couple dozen of them a stronger lift can't flood anything. `posts` runs cool as a composition counterweight: news is three quarters of that corpus, so a blended list skews toward it on volume alone. Everything else is neutral — fine-grained ordering preferences (±0.05–0.15 spreads across every stratum) measured as noise in evals and are better left out. Start with nothing, add a weight only when evals show a stratum systematically mis-served, and prefer `kinds` filtering when the real need is separate surfaces rather than reordering a blended one.

---

## Recency

For time-sensitive strata — news posts, notices, announcements — a flat kind weight punishes yesterday's press release as hard as one from 2019. The `recency` rule replaces that with continuous time decay on the fused score:

```json
{ "recency": { "kinds": ["posts"], "half_life_days": 180, "floor": 0.85 } }
```

The multiplier is `floor + (1 - floor) * 2^(-age_days / half_life_days)`, computed from the document's `metadata.published_at` (any `Date.parse`-able string; ingest stamps facts, config holds policy). A doc published today is neutral (`1.0`); age converges to the floor, so old content sinks a bounded number of ranks (`0.85` ≈ ~10 ranks at the default `rrf_k`) instead of falling without limit — a floorless decay lets marginally-relevant fresh docs bury exact old matches.

Neutrality mirrors kind weights: no rule configured, a kind outside `kinds`, a missing or unparseable `published_at`, or a future date all mean `1.0`. The rule stacks multiplicatively with `kind_weights`, so a dated kind usually wants weight `1.0` there and lets decay do the demotion.

Tuning lives in the two knobs, against your evals rather than a priori: with `half_life_days: 180` scores converge to the floor by roughly two years (a 3-year-old and an 8-year-old post tie); if stale-vs-ancient separation matters, lengthen the half-life and lower the floor (`365`/`0.7` keeps discriminating out past five years) rather than adding a second decay regime.

Search requests can replace the configured rule for a single query with the `recency` parameter — `kinds:half_life_days:floor`, kinds comma-separated:

```
GET /public/search/my-index?q=snow+emergency&recency=posts:180:0.85
```

---

## What's Opinionated

These are design decisions baked into pgsearch and why they were made:

- **Reciprocal Rank Fusion (RRF)** — scores from each pass are combined by rank position rather than raw score magnitude. Robust to outliers and score distribution differences between retrievers. Trade-off: discards score magnitude information, treating all scores as rank positions. For municipal-scale content, this robustness matters more than magnitude sensitivity.

- **Title embedded with segments** — each segment's embedding is computed from `"Document Title\n\nbody segment text"` (title prepended directly, no label prefix). This gives the vector model document-level context for each chunk.

- **One result per document by default** — the best-scoring segment wins. The internal `maxChunksPerDoc` knob lifts this cap (used by RAG to pull multiple sections from a source); the search route always uses the default of 1.

- **Identical content returns once** — civic sites routinely publish the same page under multiple URLs (category paths, tracking parameters). Results whose segments carry the same content hash are collapsed to the highest-scored copy, so mirror pages never occupy multiple result slots and RAG never receives the same chunk twice.

- **Segment size (~1000-token budget)** — the chunker sizes segments by a byte-based token estimate (`ceil(UTF-8 bytes / 3)`), which upper-bounds real embedding tokens without local tokenization. Balances embedding quality with context preservation. Configurable via `max_segment_tokens`.

---

## Things to Be Aware Of

- **Scores are rank-derived, not magnitude-based.** RRF scores reflect rank position, not raw relevance magnitude. A higher score means better rank across retrievers, but scores are not directly comparable across different queries.

- **Results are per-document, not per-segment.** A long document with multiple matching sections returns once. The snippet is the best-matching segment.

- **Stemming depends on `text_search_config`.** The default `'english'` config stems words (e.g., "running" → "run") and removes English stop words. If your content is multilingual or domain-specific, this matters.

- **Keyword scoring has no IDF.** `ts_rank_cd` scores by weighted cover density and document length, not corpus-wide term rarity. Query matching uses AND semantics (`plainto_tsquery`), so every keyword candidate already contains every query term — rarity discrimination is mostly done by matching, and the vector pass co-ranks. The trade was measured before adoption (see the eval harness under `apps/api/scripts/eval/`).

- **The vector pass depends on one invariant.** The HNSW index returns at most `hnsw.ef_search` rows, which must cover the candidate limit or results are silently truncated. The search service maintains this itself; [Search Performance and the Vector Index](search-performance.md) explains why it matters.
