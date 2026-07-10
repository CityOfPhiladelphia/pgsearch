<!-- ABOUTME: How the vector pass uses per-index HNSW expression indexes and interacts with RRF. -->
<!-- ABOUTME: Records the design constraints, the ef_search invariant, and the recall verification. -->

# Search Performance and the Vector Index

The vector pass of hybrid search runs against a **per-index partial HNSW expression index**. `createIndex` builds one for every search index at creation time, and `vectorCandidates` in `services/search.ts` is written so the planner matches it. This document explains the design, its one correctness invariant, and how it was verified against exact-scan ground truth.

For how ranking works, see [Search Behavior and Tuning](search.md).

---

## The index shape

The baseline schema (`db/migrations.ts`) declares the embedding column without a dimension so one `search_segments` table can host indexes whose embedding models differ:

```sql
embedding       VECTOR,
```

pgvector cannot build an ANN index directly on a dimensionless column, so each search index gets an **expression index on a cast**, with the tenant baked into the predicate:

```sql
CREATE INDEX idx_segments_embedding_<index_id>
  ON search_segments USING hnsw (((embedding)::vector(<dims>)) vector_cosine_ops)
  WHERE index_id = <index_id>;
```

Two properties of this shape matter:

**Partial, per index.** An ANN index finds nearest neighbours *before* a `WHERE index_id = $2` filter is applied, so a single index spanning every tenant would return neighbours dominated by the largest one and then discard them — recall for smaller indexes collapses. Baking the tenant into the index predicate avoids that entirely. The cost is one index per search index, which suits tens of indexes, not thousands (pgvector ≥ 0.8's `hnsw.iterative_scan` is the escape hatch if that ever changes).

**The query must use the identical expression.** `vectorCandidates` orders by `(embedding)::vector(<dims>) <=> $1::vector`, with `<dims>` taken from the index's embedding config. Without the cast, the planner cannot match the index and silently falls back to a sequential scan — which is exactly what happened for the first months of this service's life: the indexes existed (fully built and maintained, 294 MB for `phila-gov-en`) while every query paid for a brute-force scan of ~138 MB of TOASTed vectors. Measured on the dev instance, that scan ran ~1.0–1.5s warm with the working set cached and ~15s when it wasn't; the indexed path runs sub-second and no longer depends on the page cache holding every embedding.

The partial-index predicate stays provable from prepared statements: the partial index makes the *generic* plan look expensive, so Postgres keeps choosing custom plans with the parameter bound.

## `hnsw.ef_search` is a correctness invariant

HNSW returns at most `ef_search` rows (default **40**), and `vectorCandidates` requests up to 200 candidates. `ef_search` must be **greater than or equal to the candidate limit** — below it, the index doesn't reorder results, it silently *truncates the candidate list*. `vectorCandidates` sets it with `SET LOCAL` inside the transaction wrapping the query, because a pool hands out connections without guaranteeing session state.

This is not a tuning knob, as the next section explains.

## How approximation interacts with RRF

`hybridSearch` builds its candidate pool as the **union** of the keyword rows and the vector rows, then assigns each retriever's ranks *within that pool*. A segment missing from a retriever's list contributes nothing from it (`computeRRF` in `services/score.ts`).

That makes the vector pass a gatekeeper on membership, not merely on ordering, and it means the two error modes of an approximate index are not equally harmful.

**Approximate ordering is nearly free.** With `rrf_k = 60`, `1/(k + rank)` is deliberately flat. Swapping adjacent ranks at the head of the list moves a score by `1/61 - 1/62 ≈ 0.00026`; at rank 100 the same swap moves it by `0.00004`.

**Approximate membership is expensive.** A segment dropped from vector rank 41 loses `1/101 ≈ 0.0099` — roughly forty times the cost of a head-of-list permutation. Worse, a segment retrieved *only* by the vector pass never enters the union pool at all, so it disappears from the results rather than ranking lower. Those semantic-only candidates are exactly the ones keyword matching cannot find, and they are concentrated in the tail that a low `ef_search` truncates.

**Do not compensate for recall problems with `rrf_weights.vector`.** Raising it amplifies the candidates that survived truncation; it cannot restore the ones that were never returned.

## Verification against exact ground truth

Exact KNN is its own ground truth, and the eval harness (`apps/api/scripts/eval/`) captured it before the indexed path shipped. Comparing `captures/final-tsrank-default.json` (exact scan) against `captures/hnsw-wired.json` (indexed path, `ef_search = 200`):

**Identical rankings — overlap@10 and Spearman rho of 1.00 in every category and mode**, across 43 queries at depth 50 on the 33k-segment `phila-gov-en` corpus. At this scale, HNSW with the `ef_search` invariant honored is not an approximation in any measurable sense.

Re-run that comparison after anything that could move recall: an `m`/`ef_construction` change, a pgvector upgrade, or a corpus an order of magnitude larger. Exact rankings for a new corpus can be captured by forcing the sequential path (`SET enable_indexscan = off`) on a non-production instance.

## Operational notes

- **Index builds happen at `createIndex` time, on an empty table**, and are maintained incrementally by inserts — there is no bulk build on the request path. Building an HNSW index over an *existing* large corpus (e.g., for an index created before this design) would not fit the 30-second cold-start migration window; run it out-of-band with a direct DB connection instead.
- **`GET /private/key/admin/db-status`** reports installed extension versions (pgvector 0.8.0 on dev, verified), every `idx_segments_embedding_*` index with its definition and size, and a sampled embedding dimension per index.
- **Dimensions come from `config.embedding.dimensions`** at both index-creation and query time. Changing an index's embedding dimensions after creation would break expression matching and cast errors on stored vectors — a model change means re-creating the index and re-ingesting.
- The `phila-gov-en` HNSW index measures ~294 MB — larger than the ~195 MB of TOASTed vectors it indexes. The instance needs room to cache the index's upper layers for best latency, but unlike the sequential scan, performance degrades gracefully rather than falling off a cliff when memory is tight.
