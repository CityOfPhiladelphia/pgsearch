# Hybrid Search Database Layer — Proposal

## Problem

We need a scalable, general-purpose search system that can serve as a shared microservice across multiple applications (starting with Phila.gov knowledge bases and site search). The system must support keyword search with strong relevance ranking and semantic search via embeddings, with a hybrid scoring model that blends both.

OpenSearch is the conventional choice but introduces significant operational overhead (cluster management, shard tuning, JVM configuration, index lifecycle policies) that is disproportionate to our scale (tens of thousands to low hundreds of thousands of documents per index). We want to consolidate on Postgres — specifically Aurora PostgreSQL — to reduce operational surface while achieving equivalent or better relevance quality.

## Core Idea

Build the search layer entirely in Postgres using:

- `tsvector` / GIN indexes for keyword retrieval
- `pgvector` for semantic similarity search
- A **precomputed BM25F scoring model** stored as indexed columns, replacing Lucene's runtime scoring with a Postgres-native equivalent
- A hybrid scoring function that blends keyword relevance and vector similarity at query time

The system must be **multi-tenant by design** — supporting multiple independent search indexes (e.g., knowledge base articles, site pages, PDFs, FAQs) through a single schema pattern that can be instantiated per corpus.

---

## Schema Design

### Index Registry

A central table tracking each search index and its corpus-level statistics (needed for IDF and BM25 normalization).

```
search_indexes
├── index_id (PK)
├── name (unique slug, e.g., "phila-kb", "phila-site")
├── description
├── total_documents (integer, maintained via trigger or refresh)
├── avg_document_length (float, per-field, maintained via refresh)
├── created_at
└── updated_at
```

### Documents

The core document table. Each document belongs to one index.

```
search_documents
├── document_id (PK, UUID)
├── index_id (FK → search_indexes)
├── external_id (the source system's ID, unique per index)
├── title (text)
├── body (text)
├── metadata (jsonb — arbitrary filterable attributes)
├── embedding (vector — from pgvector, generated at ingest)
├── created_at
└── updated_at
```

### Precomputed Search Columns (on search_documents)

These columns store the inputs to BM25F scoring, precomputed at ingest/update time:

```
── title_tsvector (tsvector, GIN indexed)
── body_tsvector (tsvector, GIN indexed)
── title_length (integer — token count of title)
── body_length (integer — token count of body)
```

### Corpus-Level Term Statistics

A materialized view (or table refreshed on schedule) storing IDF inputs per index:

```
term_document_frequencies
├── index_id
├── term (text)
├── document_frequency (integer — number of docs in this index containing the term)
└── PRIMARY KEY (index_id, term)
```

Refreshed periodically (e.g., after bulk ingest, or on a schedule). For knowledge base workloads with infrequent updates, staleness of a few hours is acceptable.

---

## BM25F Scoring Model

### Why BM25F over BM25

Standard BM25 treats a document as a single bag of words. BM25F extends this by scoring **per field** with independent weights, then combining. This matters for structured content: a title match on "parking ticket" should score significantly higher than a body-only match. This is the behavior OpenSearch users configure via `multi_match` with field boosts — we're making it explicit and precomputable.

### The Math

For a query Q with terms q₁, q₂, ..., qₙ, the BM25F score for a document is:

```
score(D, Q) = Σᵢ IDF(qᵢ) · weighted_tf(qᵢ, D)
```

Where:

```
IDF(q) = ln((N - df(q) + 0.5) / (df(q) + 0.5) + 1)

N = total documents in the index
df(q) = number of documents containing term q
```

And the field-weighted term frequency:

```
weighted_tf(q, D) = (tf_combined * (k1 + 1)) / (tf_combined + k1 * (1 - b + b * dl_combined / avgdl_combined))

tf_combined = w_title * tf_title(q, D) + w_body * tf_body(q, D)
dl_combined = w_title * title_length(D) + w_body * body_length(D)
avgdl_combined = w_title * avg_title_length + w_body * avg_body_length
```

Default parameters (tunable per index):

```
k1 = 1.2    — term frequency saturation
b  = 0.75   — length normalization strength

w_title = 3.0   — title field boost
w_body  = 1.0   — body field boost
```

### What Gets Precomputed vs. Computed at Query Time

**At ingest time (stored on the document row):**
- `title_tsvector`, `body_tsvector` (for candidate retrieval via GIN)
- `title_length`, `body_length` (token counts for length normalization)
- `embedding` (vector for semantic scoring)

**On corpus refresh (materialized view):**
- `term_document_frequencies` — IDF lookup table
- `avg_document_length` per field on the index

**At query time (computed in SQL):**
- Term frequency extraction from tsvector using `ts_stat` or array operations
- IDF lookup via join to `term_document_frequencies`
- BM25F score assembly from the formula above
- Vector similarity score (`1 - cosine_distance` or inner product)
- Final blended score: `α * bm25f_score + (1 - α) * vector_score`

The blending weight `α` should be configurable per index (and potentially per query).

---

## Query Execution Strategy

For a given search query:

1. **Parse the query into terms.** Apply the same text analysis (stemming, stop word removal) used at index time.

2. **Candidate retrieval.** Use `tsvector @@ tsquery` with the GIN index to get candidate documents that match at least one query term. This is the fast, cheap filter pass. Limit to a reasonable candidate set (e.g., top 200 by basic `ts_rank`).

3. **BM25F scoring.** For the candidate set, compute the full BM25F score using the precomputed columns and the IDF materialized view.

4. **Vector scoring.** For the candidate set, compute cosine similarity between the query embedding and document embeddings.

5. **Blend and rank.** Combine BM25F and vector scores with the configurable blending weight. Return the top K results.

Steps 2–5 should be expressible as a single SQL query (with CTEs or subqueries) so the query planner can optimize the whole pipeline.

### Embedding-Driven Keyword Expansion (Future Enhancement)

At ingest time, optionally generate synthetic keyword tags derived from embedding neighborhood analysis. For a given document:

- Find its K nearest neighbors in embedding space (within the same index)
- Extract distinctive terms from those neighbors that don't appear in the source document
- Store as supplemental terms in a separate `expanded_tsvector` column

This addresses the vocabulary mismatch problem (citizen searches "trash pickup" → content titled "Solid Waste Collection Schedule") without relying solely on the vector similarity score at query time. This is an enhancement to explore after the core system is validated.

---

## Configuration Model

Each index should have a configuration record (stored as a row or jsonb) with:

```
index_config
├── bm25_k1 (float, default 1.2)
├── bm25_b (float, default 0.75)
├── field_weights (jsonb, e.g., {"title": 3.0, "body": 1.0})
├── blend_alpha (float, default 0.6 — weight toward keyword score)
├── embedding_model (text — identifier for the model used to generate embeddings)
├── embedding_dimensions (integer)
├── text_search_config (text — Postgres text search config name, default 'english')
└── refresh_schedule (text — cron expression for term stats refresh)
```

This allows each index to be independently tuned without code changes.

---

## Key Design Decisions and Tradeoffs

**Why precompute rather than use OpenSearch:** At our document scale, the precomputation cost is negligible and the operational simplification is significant. We trade Lucene's optimized runtime data structures for Postgres's general-purpose query engine, which is acceptable at this scale.

**Why materialized views for IDF:** IDF changes slowly as the corpus changes. A materialized view refreshed on a schedule (or triggered after bulk ingest) avoids recomputing IDF on every query while keeping scores reasonably current.

**Why hybrid scoring instead of pure semantic:** Pure vector search fails on exact-match queries (someone searching a specific form number or policy name needs exact keyword matching). Pure keyword search fails on vocabulary mismatch. Blending handles both gracefully.

**Why not SPLADE / learned sparse representations now:** Adds inference cost at ingest and query time. The hybrid BM25F + vector approach gets us most of the benefit with standard tooling. Evaluate SPLADE as a future enhancement if relevance quality on vocabulary-mismatch queries remains a problem after keyword expansion is implemented.

---

## Implementation Scope

**Phase 1 — Core search layer:**
- Schema creation with multi-index support
- Ingest pipeline (document insert/update with tsvector generation, embedding storage, precomputed columns)
- Term document frequency materialized view and refresh logic
- BM25F scoring function (as a Postgres function or inline SQL)
- Hybrid query with blended scoring
- Basic index management (create, configure, refresh stats)

**Phase 2 — Enhancements:**
- Embedding-driven keyword expansion
- Metadata facet filtering (jsonb GIN indexes)
- Query suggestion / autocomplete support
- Per-query blend weight override
- Relevance feedback loop (click-through tracking to inform weight tuning)
