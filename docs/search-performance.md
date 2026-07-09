<!-- ABOUTME: Why the vector pass is slow, what an ANN index would change, and how it interacts with RRF. -->
<!-- ABOUTME: Records measurements and constraints for anyone adding an HNSW index to search_segments. -->

# Search Performance and the Vector Index

The vector pass of hybrid search is an **exact brute-force KNN scan**. There is no approximate-nearest-neighbour index on `search_segments.embedding`. This document explains why, what it costs, and what has to be true before an HNSW index can be added.

For how ranking works, see [Search Behavior and Tuning](search.md).

---

## Why there is no vector index

`schema.sql` declares the column without a dimension:

```sql
embedding       VECTOR,
```

pgvector cannot build an `hnsw` or `ivfflat` index on a dimensionless vector column:

```
CREATE INDEX ... USING hnsw (embedding vector_cosine_ops);
ERROR:  column does not have dimensions
```

The column is dimensionless so that one `search_segments` table can host indexes whose embedding models have different dimensions. That flexibility is what forecloses a plain ANN index.

So `vectorCandidates` in `services/search.ts` issues `ORDER BY s.embedding <=> $1::vector LIMIT $3`, which Postgres answers with a sequential scan over every segment belonging to the index.

## What the scan costs

Embeddings are stored **out of line**. The `vector` type uses `external` storage, so a 1024-dimension embedding (~4 KB) exceeds the TOAST threshold and lives in the TOAST relation:

| | |
|---|---|
| heap | ~2 MB |
| TOAST | ~195 MB |

A sequential scan must detoast every embedding. For an index the size of `phila-gov` (16,085 documents / 33,672 segments) that is ~138 MB of vectors read per query.

The cost is therefore dominated by whether those vectors fit in the page cache, not by CPU. Measured against `phila-gov`, warm, on the dev API:

| Mode | 1 GB instance | 4 GB instance |
|---|---|---|
| `bm25` | ~0.8–1.0s, spiking to 3–5s | ~0.7–0.9s |
| `semantic` | ~15s | ~1.0–1.5s |
| `hybrid` | ~15s | ~1.2–1.4s |

On the 1 GB instance `FreeableMemory` sat at ~62 MB, so nothing cached and each query re-read the vectors from disk. With headroom to cache them, the same sequential scan runs in about a second. CPU was ~5% throughout, with credits unexhausted — the workload is memory- and I/O-bound.

Sequential scan cost grows linearly with segment count.

## Adding an ANN index

A dimensionless column can still be indexed through an **expression index on a cast**, which keeps per-index embedding dimensions available:

```sql
CREATE INDEX segments_hnsw_<index_name>
  ON search_segments USING hnsw (((embedding)::vector(1024)) vector_cosine_ops)
  WHERE index_id = <id>;
```

Verified on PostgreSQL 15.18 / pgvector 0.8.5: the cast is `IMMUTABLE` so the index builds, and the planner both matches the expression and chooses the index unprompted at realistic scale (34k rows: ~22ms indexed vs ~143ms sequential on the same machine).

The query must use the identical expression — `ORDER BY embedding::vector(1024) <=> $1::vector` — or the planner will not match the index and silently falls back to a sequential scan.

Two properties of this shape are worth understanding:

**Partial, per index.** An ANN index finds nearest neighbours *before* `WHERE index_id = $2` is applied, so a single index spanning every tenant would return neighbours dominated by the largest one and then discard them — recall for smaller indexes collapses. Baking the tenant into the index predicate avoids that entirely. The cost is one index per search index, which suits tens of indexes, not thousands.

**The predicate stays provable.** A partial index makes the *generic* plan (`index_id = $1`) look expensive, so Postgres keeps choosing custom plans with the parameter bound, and the index keeps being used even from prepared statements.

### `hnsw.ef_search` is a correctness invariant

HNSW returns at most `ef_search` rows, default **40**. `vectorCandidates` requests `LIMIT 200`:

| `hnsw.ef_search` | rows returned for `LIMIT 200` |
|---|---|
| 40 | 40 |
| 200 | 200 |

`ef_search` must be **greater than or equal to the candidate limit**, set with `SET LOCAL` inside a transaction wrapping the vector query. Setting it once per pooled connection is unreliable, because a pool hands out connections without guaranteeing their session state.

This is not a tuning knob. Getting it wrong changes retrieval semantics, as the next section explains.

## How approximation interacts with RRF

`hybridSearch` builds its candidate pool as the **union** of the BM25 rows and the vector rows, then assigns each retriever's ranks *within that pool*. A segment missing from a retriever's list contributes nothing from it (`computeRRF` in `services/score.ts`).

That makes the vector pass a gatekeeper on membership, not merely on ordering, and it means the two error modes of an approximate index are not equally harmful.

**Approximate ordering is nearly free.** With `rrf_k = 60`, `1/(k + rank)` is deliberately flat. Swapping adjacent ranks at the head of the list moves a score by `1/61 - 1/62 ≈ 0.00026`; at rank 100 the same swap moves it by `0.00004`.

**Approximate membership is expensive.** A segment dropped from vector rank 41 loses `1/101 ≈ 0.0099` — roughly forty times the cost of a head-of-list permutation. Worse, a segment retrieved *only* by the vector pass never enters the union pool at all, so it disappears from the results rather than ranking lower. Those semantic-only candidates are exactly the ones BM25 cannot find, and they are concentrated in the tail that a low `ef_search` truncates.

Concretely, with weights of `1.0`: a segment at BM25 rank 30 and vector rank 50 scores `1/90 + 1/110 = 0.0202`, above a BM25 rank-1 segment with no vector hit at `0.0164`. Truncating the vector list at 40 drops it to `0.0111` and reorders the results — with `rrf_weights` untouched.

**Do not compensate with `rrf_weights.vector`.** Raising it amplifies the candidates that survived truncation; it cannot restore the ones that were never returned.

Two factors soften the impact. `maxChunksPerDoc` defaults to 1, so a document is scored by its best *surviving* segment and degrades in rank rather than vanishing. And RRF's tail contributions are its smallest, so the least reliable part of an ANN result set is also the part that matters least.

### Measure before switching

Exact KNN is its own ground truth. Capture the ranked `external_id` list for a set of representative queries **while the vector pass is still exact**, then compare overlap and rank correlation after an ANN index lands. Afterwards, obtaining exact results costs a `SET enable_indexscan = off` and a multi-second query.

## Building the index

Migrations run on Lambda cold start (`db/migrate.ts`), and that Lambda has a **30-second timeout**. Building an HNSW index over tens of thousands of vectors will not finish inside it. A migration that times out is killed mid-`CREATE INDEX`, rolls back, never records its version, and is retried on the next cold start — with `reservedConcurrentExecutions: 5`, several at once.

The index build belongs off the request path, as a one-shot `pg_cron` job — the same reasoning that put `reconcile_index_stats` there.

Sizing note: the HNSW index for a `phila-gov`-sized corpus measures ~266 MB, larger than the TOASTed vectors it indexes. The instance needs room to cache it.

---

## Known issues

- **The BM25 candidate query takes an arbitrary subset.** `services/search.ts` selects matching segments with `LIMIT 200` and no `ORDER BY`, so for a term matching thousands of segments Postgres returns an arbitrary 200, which are then scored with BM25F in JavaScript. The true top matches can be absent. This is a larger membership problem than ANN approximation, and it makes any before/after relevance comparison noisy until fixed.

- **`last_refreshed_at` and `docs_changed_since_refresh` do not advance** on `phila-gov`, though the `reconcile-index-stats` `pg_cron` job runs daily and reports success. BM25F statistics are maintained incrementally on ingest, so scoring is unaffected; the watermark itself appears not to be updated.

## Open questions

- **The pgvector version installed on the RDS instances is unverified.** The database is not publicly accessible, there is no bastion or SSM-managed instance in the account, and the RDS API does not expose installed extension versions. HNSW requires pgvector ≥ 0.5.0; `hnsw.iterative_scan` requires ≥ 0.8.0. Reporting `SELECT extname, extversion FROM pg_extension` alongside the existing `/private/key/admin/pgcron-status` response would settle it.

- **Whether `hnsw.iterative_scan` is preferable to partial indexes** for filtered search, if the installed pgvector supports it. It scales past tens of indexes, where per-index partial indexes do not.
