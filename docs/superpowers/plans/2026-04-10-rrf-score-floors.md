# RRF Fusion and Score Floors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace min-max normalization and alpha blending with Reciprocal Rank Fusion (RRF) and add configurable per-pass score floors.

**Architecture:** Two-phase change. First, update the type system and config layer (remove `blend_alpha`, add RRF params). Second, replace the fusion logic in the search pipeline with rank-based RRF scoring and optional score floor filtering. The RRF formula lives as a pure function in `score.ts` for independent testability.

**Tech Stack:** TypeScript, PostgreSQL, Vitest.

**Spec:** `docs/superpowers/specs/2026-04-10-rrf-score-floors-design.md`

---

### Task 1: Update types and config

Remove `blend_alpha`, add RRF fields to `IndexConfig`, update defaults and merge logic.

**Files:**
- Modify: `apps/api/types.ts:4-14`
- Modify: `apps/api/config.ts:12-22` (DEFAULT_CONFIG) and `apps/api/config.ts:24-37` (mergeConfig)
- Modify: `apps/api/test/config.test.ts`
- Modify: `apps/api/test/adapter.test.ts:8-20` (configWith helper)
- Modify: `apps/api/test/indexes.test.ts:34`

- [ ] **Step 1: Update `IndexConfig` in `types.ts`**

Remove `blend_alpha`. Add:

```typescript
rrf_k: number
rrf_weights: { bm25: number; vector: number }
min_bm25_score: number
min_vector_score: number
```

- [ ] **Step 2: Update `DEFAULT_CONFIG` in `config.ts`**

Remove `blend_alpha: 0.6`. Add:

```typescript
rrf_k: 60,
rrf_weights: { bm25: 1.0, vector: 1.0 },
min_bm25_score: 0,
min_vector_score: 0,
```

- [ ] **Step 3: Add deep-merge for `rrf_weights` in `mergeConfig`**

Add the same spread pattern used for `field_weights`:

```typescript
rrf_weights: {
  ...(base.rrf_weights || DEFAULT_CONFIG.rrf_weights),
  ...(overrides.rrf_weights || {}),
},
```

- [ ] **Step 4: Update config tests**

In `test/config.test.ts`:
- Replace `expect(config.blend_alpha).toBe(0.6)` with `expect(config.rrf_k).toBe(60)` and `expect(config.rrf_weights).toEqual({ bm25: 1.0, vector: 1.0 })`
- Replace `mergeConfig({ bm25_k1: 1.5, blend_alpha: 0.8 })` test with `mergeConfig({ bm25_k1: 1.5, rrf_k: 30 })` and assert `config.rrf_k` is 30
- Add a test for partial `rrf_weights` merge:

```typescript
it('merges partial rrf_weights preserving defaults', () => {
  const config = mergeConfig({
    rrf_weights: { bm25: 2.0 } as any
  })
  expect(config.rrf_weights.bm25).toBe(2.0)
  expect(config.rrf_weights.vector).toBe(1.0) // default preserved
})
```

- [ ] **Step 5: Update `configWith` helper in `test/adapter.test.ts`**

Replace `blend_alpha: 0.6` with:

```typescript
rrf_k: 60,
rrf_weights: { bm25: 1.0, vector: 1.0 },
min_bm25_score: 0,
min_vector_score: 0,
```

- [ ] **Step 6: Update `test/indexes.test.ts`**

Replace `expect(index!.config.blend_alpha).toBe(0.6)` (line 34) with `expect(index!.config.rrf_k).toBe(60)`.

- [ ] **Step 7: Run tests to verify**

Run: `pnpm test -- --run`

Expected: All non-e2e tests pass. Search tests still pass because the normalization and blending code in `search.ts` is still present at this point — `config.blend_alpha ?? 0.6` falls back to the old default harmlessly. That code gets replaced in Task 3.

- [ ] **Step 8: Commit**

```bash
git add apps/api/types.ts apps/api/config.ts apps/api/test/config.test.ts apps/api/test/adapter.test.ts apps/api/test/indexes.test.ts
git commit -m "refactor: replace blend_alpha with RRF config fields"
```

---

### Task 2: Add `computeRRF` to score.ts

Pure function for RRF scoring. TDD — write test, then implement.

**Files:**
- Modify: `apps/api/services/score.ts`
- Modify: `apps/api/test/score.test.ts`

- [ ] **Step 1: Write failing tests for `computeRRF`**

In `test/score.test.ts`, replace the `normalizeScores` describe block with:

```typescript
describe('computeRRF', () => {
  it('computes score from a single retriever', () => {
    // rank 1, weight 1.0, k=60: 1.0 / (60 + 1) = 0.01639...
    const score = computeRRF({ bm25Rank: 1, k: 60, weights: { bm25: 1.0, vector: 1.0 } })
    expect(score).toBeCloseTo(1.0 / 61, 10)
  })

  it('sums contributions from both retrievers', () => {
    // bm25 rank 1 + vector rank 3: 1/(60+1) + 1/(60+3)
    const score = computeRRF({ bm25Rank: 1, vectorRank: 3, k: 60, weights: { bm25: 1.0, vector: 1.0 } })
    expect(score).toBeCloseTo(1 / 61 + 1 / 63, 10)
  })

  it('applies retriever weights', () => {
    const weighted = computeRRF({ bm25Rank: 1, vectorRank: 1, k: 60, weights: { bm25: 2.0, vector: 1.0 } })
    const equal = computeRRF({ bm25Rank: 1, vectorRank: 1, k: 60, weights: { bm25: 1.0, vector: 1.0 } })
    expect(weighted).toBeGreaterThan(equal)
  })

  it('absent retriever contributes nothing', () => {
    const bm25Only = computeRRF({ bm25Rank: 1, k: 60, weights: { bm25: 1.0, vector: 1.0 } })
    const both = computeRRF({ bm25Rank: 1, vectorRank: 1, k: 60, weights: { bm25: 1.0, vector: 1.0 } })
    expect(both).toBeGreaterThan(bm25Only)
  })

  it('higher rank (worse position) produces lower score', () => {
    const rank1 = computeRRF({ bm25Rank: 1, k: 60, weights: { bm25: 1.0, vector: 1.0 } })
    const rank50 = computeRRF({ bm25Rank: 50, k: 60, weights: { bm25: 1.0, vector: 1.0 } })
    expect(rank1).toBeGreaterThan(rank50)
  })
})
```

Also update the import to include `computeRRF` and remove `normalizeScores`. Update the ABOUTME comment on line 2 to remove "score normalization" and mention "RRF fusion scoring".

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- --run apps/api/test/score.test.ts`

Expected: FAIL — `computeRRF` not exported from score.ts

- [ ] **Step 3: Implement `computeRRF` and remove `normalizeScores`**

In `services/score.ts`:

Remove the `normalizeScores` function (lines 46-52).

Add:

```typescript
export interface RRFParams {
  bm25Rank?: number
  vectorRank?: number
  k: number
  weights: { bm25: number; vector: number }
}

export function computeRRF(params: RRFParams): number {
  const { bm25Rank, vectorRank, k, weights } = params
  let score = 0
  if (bm25Rank != null) {
    score += weights.bm25 / (k + bm25Rank)
  }
  if (vectorRank != null) {
    score += weights.vector / (k + vectorRank)
  }
  return score
}
```

Update ABOUTME line 2: `// ABOUTME: Computes IDF, field-weighted term frequency, and RRF fusion scoring.`

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- --run apps/api/test/score.test.ts`

Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/services/score.ts apps/api/test/score.test.ts
git commit -m "feat: add computeRRF, remove normalizeScores"
```

---

### Task 3: Replace fusion logic in search pipeline

Replace min-max normalization and alpha blending with score floors + RRF ranking. TDD — update tests first.

**Files:**
- Modify: `apps/api/services/search.ts`
- Modify: `apps/api/test/search.test.ts`

- [ ] **Step 1: Update search test ABOUTME and imports**

Update ABOUTME line 2: `// ABOUTME: Tests vector retrieval, RRF fusion, score floors, and document deduplication.`

- [ ] **Step 2: Rewrite `search mode` test block**

Replace the existing `search mode` describe block with tests that validate RRF behavior. The old `mode=semantic scores use only vector similarity` test is removed because it validated min-max normalization producing [0, 1] scores — RRF scores follow a different pattern (small values like ~0.016 for rank 1 with k=60). The `defaults to hybrid` test drops the `toBeCloseTo` precision to 5 decimal places since RRF scores are deterministic.

```typescript
describe('search mode', () => {
  it('mode=bm25 returns only keyword matches', async () => {
    const results = await hybridSearch(pool, indexId, adapter, 'parking permit', { limit: 10, mode: 'bm25' })
    expect(results.results.length).toBeGreaterThan(0)
    expect(results.query).toBe('parking permit')
  })

  it('mode=bm25 returns empty for queries with no keyword matches', async () => {
    const results = await hybridSearch(pool, indexId, adapter, 'xyzzynonexistent', { limit: 10, mode: 'bm25' })
    expect(results.results).toEqual([])
    expect(results.total).toBe(0)
  })

  it('mode=semantic returns results even without keyword matches', async () => {
    const results = await hybridSearch(pool, indexId, adapter, 'xyzzynonexistent', { limit: 10, mode: 'semantic' })
    expect(results.results.length).toBeGreaterThan(0)
  })

  it('defaults to hybrid when mode is not specified', async () => {
    const hybrid = await hybridSearch(pool, indexId, adapter, 'parking permit', { limit: 10 })
    const explicit = await hybridSearch(pool, indexId, adapter, 'parking permit', { limit: 10, mode: 'hybrid' })
    expect(hybrid.results.length).toBe(explicit.results.length)
    expect(hybrid.results[0].score).toBeCloseTo(explicit.results[0].score, 5)
  })
})
```

- [ ] **Step 3: Add RRF-specific tests**

Add a new describe block after `search mode`:

```typescript
describe('RRF fusion', () => {
  it('scores follow RRF pattern (small positive values)', async () => {
    const results = await hybridSearch(pool, indexId, adapter, 'parking permit', { limit: 10 })
    expect(results.results.length).toBeGreaterThan(0)
    for (const r of results.results) {
      // RRF scores are small: max is w/(k+1) per retriever, so ~0.033 for two equal-weight retrievers
      expect(r.score).toBeGreaterThan(0)
      expect(r.score).toBeLessThan(1)
    }
  })

  it('candidates appearing in both passes score higher than single-pass', async () => {
    // "parking" matches via BM25 (keyword) and should also have vector similarity
    // Documents that appear in both passes get two RRF contributions
    const results = await hybridSearch(pool, indexId, adapter, 'parking', { limit: 10 })
    expect(results.results.length).toBeGreaterThan(1)
    // The top result should score higher than the bottom — both-pass candidates rise
    expect(results.results[0].score).toBeGreaterThan(results.results[results.results.length - 1].score)
  })

  it('score floors exclude weak candidates', async () => {
    // With an impossibly high vector floor, semantic pass contributes nothing
    const results = await hybridSearch(pool, indexId, adapter, 'parking', {
      limit: 10,
      mode: 'semantic',
      minVectorScore: 0.99,
    })
    expect(results.results).toEqual([])
    expect(results.total).toBe(0)
  })
})
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `pnpm test -- --run apps/api/test/search.test.ts`

Expected: TypeScript compilation error — `minVectorScore` is not a property of `HybridSearchOptions` yet. Steps 2 and 3 should both be written before running this.

- [ ] **Step 5: Update `HybridSearchOptions` in `search.ts`**

Add score floor options:

```typescript
export interface HybridSearchOptions {
  limit?: number
  mode?: SearchMode
  minBm25Score?: number
  minVectorScore?: number
}
```

- [ ] **Step 6: Replace fusion logic in `hybridSearch`**

In `services/search.ts`:

Remove the `normalizeScores` import.

Add import: `import { computeBM25F, computeRRF } from './score'`

Update ABOUTME line 2: `// ABOUTME: Two-pass retrieval with score floors, RRF fusion, and document deduplication.`

Replace the scoring section (everything from `const segments = Array.from(segmentMap.values())` through the `scored` array construction) with:

```typescript
  const segments = Array.from(segmentMap.values())

  const rrfK: number = config.rrf_k ?? 60
  const rrfWeights = config.rrf_weights ?? { bm25: 1.0, vector: 1.0 }
  const minBm25Score = options.minBm25Score ?? config.min_bm25_score ?? 0
  const minVectorScore = options.minVectorScore ?? config.min_vector_score ?? 0

  // Assign 1-based ranks per retriever (sorted by raw score descending), applying score floors
  const bm25Ranked = segments
    .filter(s => s.bm25Score > minBm25Score)
    .sort((a, b) => b.bm25Score - a.bm25Score)
  const bm25RankMap = new Map<string, number>()
  bm25Ranked.forEach((s, i) => bm25RankMap.set(s.segment_id, i + 1))

  const vectorRanked = segments
    .filter(s => s.vectorScore > minVectorScore)
    .sort((a, b) => b.vectorScore - a.vectorScore)
  const vectorRankMap = new Map<string, number>()
  vectorRanked.forEach((s, i) => vectorRankMap.set(s.segment_id, i + 1))

  // Compute RRF score for each segment
  const scored = segments
    .map(s => {
      const bm25Rank = bm25RankMap.get(s.segment_id)
      const vectorRank = vectorRankMap.get(s.segment_id)
      // Segments excluded by both score floors are dropped
      if (bm25Rank == null && vectorRank == null) return null
      const score = computeRRF({ bm25Rank, vectorRank, k: rrfK, weights: rrfWeights })
      return { ...s, score }
    })
    .filter((s): s is NonNullable<typeof s> => s != null)
```

Then update deduplication to use `score` instead of `blendedScore`:

```typescript
  if (scored.length === 0) {
    return { results: [], total: 0, query: queryText }
  }

  // Deduplicate: keep the highest-scoring segment per document
  const bestByDoc = new Map<string, typeof scored[0]>()
  for (const s of scored) {
    const existing = bestByDoc.get(s.document_id)
    if (!existing || s.score > existing.score) {
      bestByDoc.set(s.document_id, s)
    }
  }

  const deduped = Array.from(bestByDoc.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  const results: SearchResult[] = deduped.map(s => ({
    external_id: s.external_id,
    score: s.score,
    title: s.title,
    snippet: s.body,
    metadata: s.metadata,
  }))
```

Also remove line 122 (`const blendAlpha: number = config.blend_alpha ?? 0.6`) which is no longer used, and remove the earlier empty-check (`if (segmentMap.size === 0)`) since the `scored.length === 0` check handles this.

Note: `minBm25Score`/`minVectorScore` on `HybridSearchOptions` are for programmatic and test use. They are not wired as API query params in `routes/search.ts` — score floors are configured per-index via the config. No route changes needed.

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm test -- --run apps/api/test/search.test.ts`

Expected: All search tests PASS (including existing deduplication and vector candidate tests)

- [ ] **Step 8: Run full test suite**

Run: `pnpm test -- --run`

Expected: All non-e2e tests pass

- [ ] **Step 9: Commit**

```bash
git add apps/api/services/search.ts apps/api/test/search.test.ts
git commit -m "feat: replace min-max blending with RRF fusion and score floors"
```

---

### Task 4: Update client SDK types

Mirror the API type changes in the client package.

**Files:**
- Modify: `packages/client/src/types.ts:4-14`

- [ ] **Step 1: Update client `IndexConfig`**

Replace `blend_alpha?: number` with:

```typescript
rrf_k?: number
rrf_weights?: { bm25?: number; vector?: number }
min_bm25_score?: number
min_vector_score?: number
```

- [ ] **Step 2: Run tests**

Run: `pnpm test -- --run`

Expected: All non-e2e tests pass

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/types.ts
git commit -m "refactor: update client SDK types for RRF config"
```

---

### Task 5: Update documentation

Update all docs that reference blend_alpha, min-max normalization, or score blending.

Note: `dev/search.html` and `routes/search.ts` need no changes — mode selector and query param wiring are already in place.

**Files:**
- Modify: `docs/search.md`
- Modify: `docs/architecture.md:129-131`
- Modify: `docs/getting-started.md:115`
- Modify: `README.md:13`

- [ ] **Step 1: Rewrite `docs/search.md` scoring sections**

Replace steps 3-4 in "How Hybrid Search Works" (lines 18-23):

```markdown
3. **Score floors** — each pass's candidates are filtered by a minimum score threshold. Candidates below the floor are excluded before fusion. Defaults are off (0).

4. **RRF fusion** — results from each pass are independently ranked by raw score. The final score uses Reciprocal Rank Fusion:
   ```
   score = w_bm25 / (k + bm25_rank) + w_vector / (k + vector_rank)
   ```
   Candidates appearing in both passes get contributions from both, naturally ranking higher. See [RRF on Wikipedia](https://en.wikipedia.org/wiki/Reciprocal_rank_fusion) for background.
```

Replace the scoring parameters table (lines 33-41): remove `blend_alpha` row, add rows for `rrf_k`, `rrf_weights.bm25`, `rrf_weights.vector`, `min_bm25_score`, `min_vector_score`.

Update the PATCH example (line 52): change `'{"blend_alpha": 0.4}'` to `'{"rrf_weights": {"bm25": 2.0}}'`.

Update "What's Opinionated" section (line 63): replace the min-max bullet with RRF:

```markdown
- **Reciprocal Rank Fusion (RRF)** — scores from each pass are combined by rank position rather than raw score magnitude. Robust to outliers and score distribution differences between retrievers. Trade-off: discards score magnitude information, treating all scores as rank positions. For municipal-scale content, this robustness matters more than magnitude sensitivity.
```

Update "Things to Be Aware Of" section (line 75): replace "Scores are relative, not absolute. Min-max normalization means..." with:

```markdown
- **Scores are rank-derived, not magnitude-based.** RRF scores reflect rank position, not raw relevance magnitude. A higher score means better rank across retrievers, but scores are not directly comparable across different queries.
```

- [ ] **Step 2: Update `docs/architecture.md` design decisions**

Replace section "3. Min-max score normalization" (lines 129-131) with:

```markdown
### 3. Reciprocal Rank Fusion (RRF)

BM25F and vector results are independently ranked, then combined using RRF: `score = Σ w / (k + rank)`. This is robust to outlier scores and score distribution differences between retrievers. Trade-off vs. min-max normalization: RRF discards score magnitude, treating all scores as rank positions. For this use case, robustness to weak-signal inflation matters more than preserving magnitude.
```

- [ ] **Step 3: Update `docs/getting-started.md`**

Replace line 115 (`- \`score\` is a blend of keyword relevance (BM25F) and semantic similarity (vector).`) with:

```markdown
- `score` is a rank-based combination of keyword relevance (BM25F) and semantic similarity (vector) using Reciprocal Rank Fusion.
```

- [ ] **Step 4: Update `README.md` hybrid search description**

Replace line 13:

```markdown
- **Hybrid search** — each query runs two passes: keyword matching (BM25F on tsvectors) and semantic similarity (pgvector cosine distance). Results are combined using Reciprocal Rank Fusion (RRF) for robust ranking.
```

- [ ] **Step 5: Commit**

```bash
git add docs/search.md docs/architecture.md docs/getting-started.md README.md
git commit -m "docs: update search docs for RRF fusion"
```

---

### Task 6: Final verification

- [ ] **Step 1: Run full test suite**

Run: `pnpm test -- --run`

Expected: All non-e2e tests pass. No references to `normalizeScores` or `blend_alpha` remain in source code (test/source, not historical docs/specs).

- [ ] **Step 2: Grep for stale references in source**

```bash
grep -r "blend_alpha\|normalizeScores" apps/ packages/ --include='*.ts' -l
```

Expected: No matches (historical specs/plans in docs/ are fine).

- [ ] **Step 3: Commit any remaining cleanup**

If step 2 found anything, fix and commit.
