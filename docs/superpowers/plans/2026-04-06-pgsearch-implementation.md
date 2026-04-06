# pgsearch Hybrid Search Service — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a PostgreSQL-backed hybrid search microservice combining BM25F keyword scoring with pgvector similarity search, with multi-tenant index management, document ingestion with chunking, and pluggable embedding adapters.

**Architecture:** Single Lambda behind API Gateway, backed by Aurora PostgreSQL with pgvector. Three-tier auth (admin/index/search keys). Two-pass query pipeline (BM25F + vector) with score normalization and blending. Documents chunked into segments at ingest time with content-hash-based diffing for efficient re-ingestion.

**Tech Stack:** TypeScript, Hono (HTTP framework), PostgreSQL with pgvector, AWS Lambda, esbuild, vitest (testing), pnpm workspaces, bcryptjs (key hashing), AWS Bedrock (embedding option), @huggingface/transformers (local embedding option)

**Spec:** `docs/superpowers/specs/2026-04-06-pgsearch-hybrid-search-design.md`

---

## File Structure

All paths relative to project root `/Users/darren.mcdowell/pgsearch/`.

### apps/api/ — Lambda function (modify existing)

```
apps/api/
├── index.ts                        # Lambda entry point — replace placeholder with real routes
├── types.ts                        # Shared types: SearchIndex, Document, Segment, Config, API contracts
├── config.ts                       # Default config values, config merging logic
├── db/
│   ├── pool.ts                     # PostgreSQL connection pool (wraps @phila/db-postgres)
│   └── schema.sql                  # Full DDL: tables, indexes, materialized view, helper functions
├── middleware/
│   ├── auth.ts                     # Three-tier auth: admin key, index key, search key
│   └── error.ts                    # Consistent error response formatting
├── routes/
│   ├── admin.ts                    # POST/GET/PATCH/DELETE /admin/indexes, POST refresh
│   ├── ingest.ts                   # POST/DELETE /index/:name/documents
│   ├── search.ts                   # GET /search/:name
│   └── health.ts                   # GET /public/health
├── services/
│   ├── indexes.ts                  # Index CRUD: create, list, get, update, delete
│   ├── ingest.ts                   # Ingest pipeline: validate, chunk, hash, diff, embed, upsert
│   ├── search.ts                   # Hybrid query: BM25F path, vector path, merge, blend, dedup
│   ├── chunk.ts                    # Text chunking: paragraph/sentence splitting, token counting
│   ├── score.ts                    # BM25F scoring: IDF lookup, field-weighted TF, score computation
│   └── refresh.ts                  # Materialized view refresh + avg length recomputation
├── test/
│   ├── setup.ts                    # Test DB connection, schema setup/teardown helpers
│   ├── chunk.test.ts               # Chunking unit tests (pure functions, no DB)
│   ├── score.test.ts               # BM25F scoring unit tests (pure math, no DB)
│   ├── auth.test.ts                # Auth middleware tests (bcrypt hashing)
│   ├── config.test.ts              # Config defaults/merging tests
│   ├── indexes.test.ts             # Index CRUD integration tests (real DB)
│   ├── ingest.test.ts              # Ingest pipeline integration tests (real DB)
│   └── search.test.ts              # Hybrid search integration tests (real DB)
├── package.json                    # Add vitest, bcryptjs, pgvector deps
├── tsconfig.json
└── vitest.config.ts                # Test configuration
```

### packages/embeddings/ — Embedding adapter package (create new)

```
packages/embeddings/
├── src/
│   ├── index.ts                    # Exports: interface, adapters, factory
│   ├── adapter.ts                  # EmbeddingAdapter interface definition
│   ├── bedrock.ts                  # AWS Bedrock adapter
│   ├── local.ts                    # Local ONNX adapter (stub initially, implement when model selected)
│   └── test.ts                     # Deterministic test adapter (fixed vectors for testing)
├── test/
│   └── adapter.test.ts             # Adapter interface contract tests
├── package.json
└── tsconfig.json
```

### packages/client/ — Typed API client (create new)

```
packages/client/
├── src/
│   ├── index.ts                    # PgsearchClient class
│   └── types.ts                    # Request/response type definitions
├── test/
│   └── client.test.ts              # Client tests against real API
├── package.json
└── tsconfig.json
```

### packages/ingest/ — Content parsers (create new)

```
packages/ingest/
├── src/
│   ├── index.ts                    # Exports: parse.html, parse.text
│   ├── html.ts                     # HTML to structured document
│   └── text.ts                     # Plain text to structured document
├── test/
│   ├── html.test.ts                # HTML parser tests
│   └── text.test.ts                # Text parser tests
├── package.json
└── tsconfig.json
```

### Root-level files (create/modify)

```
docker-compose.test.yml             # PostgreSQL 17 + pgvector for testing
vitest.workspace.ts                 # Vitest workspace configuration
pnpm-workspace.yaml                 # Add packages/* workspace
```

---

## Task Dependency Graph

```
Task 1 (scaffolding)
  └─→ Task 2 (schema & DB)
       └─→ Task 3 (types & config)
            ├─→ Task 4 (auth middleware)
            │    └─→ Task 5 (index management + admin routes)
            │         └─→ Task 6 (chunking)
            │              └─→ Task 7 (embedding adapter)
            │                   └─→ Task 8 (ingest pipeline + routes)
            │                        └─→ Task 9 (materialized view refresh)
            │                             └─→ Task 10 (BM25F scoring)
            │                                  └─→ Task 11 (vector search)
            │                                       └─→ Task 12 (hybrid search + routes)
            │                                            └─→ Task 13 (wire Lambda entry point)
            └─→ Task 14 (client library) [independent after Task 3]
            └─→ Task 15 (ingest parsers) [independent after Task 3]
```

Tasks 14 and 15 are independent and can run in parallel with the main chain after Task 3.

---

### Task 1: Project Scaffolding

**Files:**
- Create: `docker-compose.test.yml`
- Create: `vitest.workspace.ts`
- Create: `packages/embeddings/package.json`
- Create: `packages/embeddings/tsconfig.json`
- Create: `packages/client/package.json`
- Create: `packages/client/tsconfig.json`
- Create: `packages/ingest/package.json`
- Create: `packages/ingest/tsconfig.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `apps/api/package.json`

- [ ] **Step 1: Create docker-compose.test.yml**

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_DB: pgsearch_test
      POSTGRES_USER: pgsearch
      POSTGRES_PASSWORD: testpassword
    ports:
      - "5433:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U pgsearch -d pgsearch_test"]
      interval: 2s
      timeout: 5s
      retries: 10
```

- [ ] **Step 2: Update pnpm-workspace.yaml**

```yaml
packages:
  - 'cdk'
  - 'apps/*'
  - 'packages/*'
```

- [ ] **Step 3: Create packages/embeddings scaffolding**

`packages/embeddings/package.json`:
```json
{
  "name": "@phila/search-embeddings",
  "version": "0.0.1",
  "private": true,
  "main": "src/index.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "vitest": "^3.1.0"
  }
}
```

`packages/embeddings/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "declaration": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 4: Create packages/client scaffolding**

`packages/client/package.json`:
```json
{
  "name": "@phila/pgsearch-client",
  "version": "0.0.1",
  "private": true,
  "main": "src/index.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "vitest": "^3.1.0"
  }
}
```

`packages/client/tsconfig.json`: Same pattern as embeddings.

- [ ] **Step 5: Create packages/ingest scaffolding**

`packages/ingest/package.json`:
```json
{
  "name": "@phila/search-ingest",
  "version": "0.0.1",
  "private": true,
  "main": "src/index.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "vitest": "^3.1.0"
  }
}
```

`packages/ingest/tsconfig.json`: Same pattern as embeddings.

- [ ] **Step 5b: Create vitest.config.ts for each package**

Each of `packages/embeddings/`, `packages/client/`, `packages/ingest/` needs a `vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})
```

- [ ] **Step 5c: Update apps/api/tsconfig.json include pattern**

The existing `"include": ["*.ts"]` only picks up root-level files. Change to:

```json
"include": ["**/*.ts"]
```

This ensures TypeScript compiles files in `db/`, `middleware/`, `routes/`, `services/`, and `test/` subdirectories.

- [ ] **Step 5d: Update root package.json workspaces**

Add `packages/*` to the `workspaces` array in root `package.json` to stay consistent with `pnpm-workspace.yaml`:

```json
"workspaces": ["cdk", "apps/*", "packages/*"]
```

- [ ] **Step 6: Add test dependencies to apps/api**

Add to `apps/api/package.json` devDependencies:
```json
{
  "vitest": "^3.1.0",
  "bcryptjs": "^2.4.3",
  "@types/bcryptjs": "^2.4.6",
  "pgvector": "^0.2.0"
}
```

Add `bcryptjs` and `pgvector` to dependencies (production):
```json
{
  "bcryptjs": "^2.4.3",
  "pgvector": "^0.2.0"
}
```

Add scripts:
```json
{
  "test": "vitest run",
  "test:watch": "vitest"
}
```

- [ ] **Step 7: Create vitest.workspace.ts**

```typescript
import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  'apps/api/vitest.config.ts',
  'packages/*/vitest.config.ts',
])
```

- [ ] **Step 8: Create apps/api/vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 30000,
  },
})
```

- [ ] **Step 9: Run pnpm install to resolve workspaces**

Run: `pnpm install`
Expected: Dependencies resolved, workspace packages linked.

- [ ] **Step 10: Commit scaffolding**

```bash
git add -A
git commit -m "feat: scaffold monorepo packages and test infrastructure"
```

---

### Task 2: Database Schema & Connection

**Files:**
- Create: `apps/api/db/schema.sql`
- Create: `apps/api/db/pool.ts`
- Create: `apps/api/test/setup.ts`

- [ ] **Step 1: Write test/setup.ts**

Test setup that connects to the test PostgreSQL, applies schema, and tears down between test suites.

```typescript
// ABOUTME: Test database setup and teardown helpers.
// ABOUTME: Connects to the test PostgreSQL, applies schema, and cleans up between runs.

import { Pool } from 'pg'
import { readFileSync } from 'fs'
import { join } from 'path'

const TEST_DB_CONFIG = {
  host: process.env.TEST_DB_HOST || 'localhost',
  port: parseInt(process.env.TEST_DB_PORT || '5433'),
  database: process.env.TEST_DB_NAME || 'pgsearch_test',
  user: process.env.TEST_DB_USER || 'pgsearch',
  password: process.env.TEST_DB_PASSWORD || 'testpassword',
}

let pool: Pool

export async function getTestPool(): Promise<Pool> {
  if (!pool) {
    pool = new Pool(TEST_DB_CONFIG)
  }
  return pool
}

export async function setupSchema(): Promise<void> {
  const p = await getTestPool()
  await p.query('CREATE EXTENSION IF NOT EXISTS vector')
  const schema = readFileSync(join(__dirname, '..', 'db', 'schema.sql'), 'utf-8')
  await p.query(schema)
}

export async function teardownSchema(): Promise<void> {
  const p = await getTestPool()
  await p.query('DROP MATERIALIZED VIEW IF EXISTS term_document_frequencies CASCADE')
  await p.query('DROP TABLE IF EXISTS search_segments CASCADE')
  await p.query('DROP TABLE IF EXISTS search_documents CASCADE')
  await p.query('DROP TABLE IF EXISTS search_indexes CASCADE')
}

export async function cleanupTestData(): Promise<void> {
  const p = await getTestPool()
  // Drop dynamic per-index HNSW indexes before deleting index rows
  const indexes = await p.query('SELECT index_id FROM search_indexes')
  for (const row of indexes.rows) {
    await p.query(`DROP INDEX IF EXISTS idx_segments_embedding_${row.index_id}`)
  }
  await p.query('DELETE FROM search_segments')
  await p.query('DELETE FROM search_documents')
  await p.query('DELETE FROM search_indexes')
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
  }
}
```

- [ ] **Step 2: Start test database**

Run: `docker compose -f docker-compose.test.yml up -d`
Expected: PostgreSQL container running on port 5433 with pgvector extension available.

- [ ] **Step 3: Write db/schema.sql**

Full DDL from the spec. Tables: `search_indexes`, `search_documents`, `search_segments`. Materialized view: `term_document_frequencies`. All indexes (GIN on tsvectors, btree on foreign keys). Note: HNSW vector indexes are created dynamically per search index, not in the static schema.

```sql
-- pgsearch database schema
-- Requires: CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS search_indexes (
    index_id            SERIAL PRIMARY KEY,
    name                TEXT UNIQUE NOT NULL,
    description         TEXT,
    config              JSONB NOT NULL DEFAULT '{}',
    index_key_hash      TEXT NOT NULL,
    search_key_hash     TEXT NOT NULL,
    total_documents     INTEGER NOT NULL DEFAULT 0,
    avg_title_length    FLOAT NOT NULL DEFAULT 0,
    avg_body_length     FLOAT NOT NULL DEFAULT 0,
    last_refreshed_at   TIMESTAMPTZ,
    docs_changed_since_refresh INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS search_documents (
    document_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    index_id        INTEGER NOT NULL REFERENCES search_indexes(index_id) ON DELETE CASCADE,
    external_id     TEXT NOT NULL,
    title           TEXT NOT NULL,
    title_tsvector  TSVECTOR,
    title_length    INTEGER NOT NULL DEFAULT 0,
    metadata        JSONB DEFAULT '{}',
    segment_count   INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (index_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_documents_title_tsvector ON search_documents USING GIN (title_tsvector);
CREATE INDEX IF NOT EXISTS idx_documents_index_id ON search_documents (index_id);

CREATE TABLE IF NOT EXISTS search_segments (
    segment_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES search_documents(document_id) ON DELETE CASCADE,
    index_id        INTEGER NOT NULL REFERENCES search_indexes(index_id) ON DELETE CASCADE,
    segment_index   INTEGER NOT NULL,
    body            TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    embedding       VECTOR,
    body_tsvector   TSVECTOR,
    body_length     INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_segments_body_tsvector ON search_segments USING GIN (body_tsvector);
CREATE INDEX IF NOT EXISTS idx_segments_document_id ON search_segments (document_id);
CREATE INDEX IF NOT EXISTS idx_segments_index_id ON search_segments (index_id);

-- Helper function: extract lexemes from a tsvector as a text array.
-- PostgreSQL does not have a built-in tsvector_to_array. This strips positions.
CREATE OR REPLACE FUNCTION tsvector_to_array(tv tsvector) RETURNS text[] AS $$
  SELECT array_agg(word) FROM ts_stat('SELECT ' || quote_literal(tv::text) || '::tsvector')
$$ LANGUAGE sql IMMUTABLE STRICT;

-- Materialized view for IDF computation.
-- Computes document frequency per term per index (how many documents contain each term).
CREATE MATERIALIZED VIEW IF NOT EXISTS term_document_frequencies AS
SELECT
    sub.index_id,
    sub.term,
    COUNT(DISTINCT sub.document_id)::INTEGER AS document_frequency
FROM (
    SELECT
        d.index_id,
        d.document_id,
        unnest(tsvector_to_array(s.body_tsvector)) AS term
    FROM search_documents d
    JOIN search_segments s ON s.document_id = d.document_id
    WHERE s.body_tsvector IS NOT NULL
    UNION
    SELECT
        d.index_id,
        d.document_id,
        unnest(tsvector_to_array(d.title_tsvector)) AS term
    FROM search_documents d
    WHERE d.title_tsvector IS NOT NULL
) sub
GROUP BY sub.index_id, sub.term;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tdf_pk ON term_document_frequencies (index_id, term);
```

Note: The helper function `tsvector_to_array` uses `ts_stat` internally, which is a standard PostgreSQL function. This is used within the materialized view; if performance is a concern at scale, consider replacing with a `ts_stat`-based approach that operates on table queries directly.

- [ ] **Step 4: Verify schema applies against test database**

Run: `docker exec -i $(docker compose -f docker-compose.test.yml ps -q postgres) psql -U pgsearch -d pgsearch_test -c "CREATE EXTENSION IF NOT EXISTS vector;"` then apply schema.sql. If `tsvector_to_array` doesn't exist, implement a helper function or switch to a `ts_stat`-based approach. Iterate until the schema applies cleanly.

- [ ] **Step 5: Write db/pool.ts**

```typescript
// ABOUTME: Database connection pool configuration.
// ABOUTME: Wraps @phila/db-postgres for connection management.

import { Pool } from 'pg'
import { registerType } from 'pgvector/pg'

let pool: Pool | null = null

export async function getPool(): Promise<Pool> {
  if (!pool) {
    // In Lambda, @phila/db-postgres provides the connection config
    // via DB_SECRET_ARN and DB_NAME environment variables.
    // For local/test, fall back to explicit config.
    const { getConnection } = await import('@phila/db-postgres')
    pool = await getConnection()
    // Register pgvector type handler
    const client = await pool.connect()
    await registerType(client)
    client.release()
  }
  return pool
}
```

Note: The exact `@phila/db-postgres` API will need to be verified against the library. Adjust import and usage as needed.

- [ ] **Step 6: Write a basic schema application test**

In `test/setup.ts`, add a test that verifies schema can be applied and tables exist:

```typescript
// In a test file or as a manual verification step:
// 1. Apply schema
// 2. Query pg_tables to verify search_indexes, search_documents, search_segments exist
// 3. Verify materialized view exists
// 4. Tear down
```

- [ ] **Step 7: Run the test**

Run: `cd apps/api && pnpm test`
Expected: Schema applies, tables verified, teardown clean.

- [ ] **Step 8: Commit**

```bash
git add apps/api/db/ apps/api/test/setup.ts
git commit -m "feat: add database schema and test setup"
```

---

### Task 3: Types, Config & Error Handling

**Files:**
- Create: `apps/api/types.ts`
- Create: `apps/api/config.ts`
- Create: `apps/api/middleware/error.ts`
- Create: `apps/api/test/config.test.ts`

- [ ] **Step 1: Write failing test for config defaults**

`apps/api/test/config.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { mergeConfig, DEFAULT_CONFIG } from '../config'

describe('config', () => {
  it('returns full defaults when no overrides provided', () => {
    const config = mergeConfig({})
    expect(config.bm25_k1).toBe(1.2)
    expect(config.bm25_b).toBe(0.75)
    expect(config.field_weights).toEqual({ title: 3.0, body: 1.0 })
    expect(config.blend_alpha).toBe(0.6)
    expect(config.max_segment_tokens).toBe(500)
    expect(config.max_segments_per_document).toBe(100)
    expect(config.refresh_threshold).toBe(100)
    expect(config.text_search_config).toBe('english')
  })

  it('merges partial overrides with defaults', () => {
    const config = mergeConfig({ bm25_k1: 1.5, blend_alpha: 0.8 })
    expect(config.bm25_k1).toBe(1.5)
    expect(config.blend_alpha).toBe(0.8)
    expect(config.bm25_b).toBe(0.75) // default preserved
  })

  it('merges nested embedding config', () => {
    const config = mergeConfig({
      embedding: { provider: 'bedrock', model: 'amazon.titan-embed-text-v2:0', dimensions: 1024 }
    })
    expect(config.embedding.provider).toBe('bedrock')
    expect(config.embedding.dimensions).toBe(1024)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm test -- test/config.test.ts`
Expected: FAIL — `config` module not found.

- [ ] **Step 3: Write types.ts**

```typescript
// ABOUTME: Shared type definitions for the pgsearch API.
// ABOUTME: Covers index configuration, documents, segments, and API contracts.

export interface IndexConfig {
  text_search_config: string
  embedding: EmbeddingConfig
  bm25_k1: number
  bm25_b: number
  field_weights: { title: number; body: number }
  blend_alpha: number
  max_segment_tokens: number
  max_segments_per_document: number
  refresh_threshold: number
}

export interface EmbeddingConfig {
  provider: 'bedrock' | 'local'
  model: string
  dimensions: number
}

export interface SearchIndex {
  index_id: number
  name: string
  description: string | null
  config: IndexConfig
  index_key_hash: string
  search_key_hash: string
  total_documents: number
  avg_title_length: number
  avg_body_length: number
  last_refreshed_at: string | null
  docs_changed_since_refresh: number
  created_at: string
  updated_at: string
}

export interface SearchDocument {
  document_id: string
  index_id: number
  external_id: string
  title: string
  title_tsvector: string | null
  title_length: number
  metadata: Record<string, unknown>
  segment_count: number
  created_at: string
  updated_at: string
}

export interface SearchSegment {
  segment_id: string
  document_id: string
  index_id: number
  segment_index: number
  body: string
  content_hash: string
  embedding: number[] | null
  body_tsvector: string | null
  body_length: number
  created_at: string
}

export interface IngestRequest {
  external_id: string
  title: string
  body: string
  metadata?: Record<string, unknown>
}

export interface IngestResponse {
  external_id: string
  segments: number
  changed: number
  unchanged: number
  status: 'indexed'
}

export interface SearchResult {
  external_id: string
  score: number
  title: string
  snippet: string
  metadata: Record<string, unknown>
}

export interface SearchResponse {
  results: SearchResult[]
  total: number
  query: string
}

export interface CreateIndexRequest {
  name: string
  description?: string
  config?: Partial<IndexConfig>
}

export interface CreateIndexResponse {
  name: string
  index_key: string
  search_key: string
  created_at: string
}

export interface ApiError {
  error: {
    code: string
    message: string
  }
}
```

- [ ] **Step 4: Write config.ts**

```typescript
// ABOUTME: Default configuration values and config merging logic.
// ABOUTME: Applies sensible defaults so most callers only need to provide index name.

import type { IndexConfig, EmbeddingConfig } from './types'

const DEFAULT_EMBEDDING: EmbeddingConfig = {
  provider: 'local',
  model: 'all-MiniLM-L6-v2',
  dimensions: 384,
}

export const DEFAULT_CONFIG: IndexConfig = {
  text_search_config: 'english',
  embedding: { ...DEFAULT_EMBEDDING },
  bm25_k1: 1.2,
  bm25_b: 0.75,
  field_weights: { title: 3.0, body: 1.0 },
  blend_alpha: 0.6,
  max_segment_tokens: 500,
  max_segments_per_document: 100,
  refresh_threshold: 100,
}

export function mergeConfig(overrides: Partial<IndexConfig>): IndexConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    embedding: {
      ...DEFAULT_EMBEDDING,
      ...(overrides.embedding || {}),
    },
    field_weights: {
      ...DEFAULT_CONFIG.field_weights,
      ...(overrides.field_weights || {}),
    },
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/api && pnpm test -- test/config.test.ts`
Expected: PASS

- [ ] **Step 6: Write middleware/error.ts**

```typescript
// ABOUTME: Consistent error response formatting for all API endpoints.
// ABOUTME: Provides helper functions to return standardized error JSON.

import type { Context } from 'hono'

type ErrorCode = 'UNAUTHORIZED' | 'NOT_FOUND' | 'VALIDATION_ERROR' | 'INTERNAL_ERROR'

const STATUS_MAP: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  INTERNAL_ERROR: 500,
}

export function apiError(c: Context, code: ErrorCode, message: string) {
  return c.json({ error: { code, message } }, STATUS_MAP[code])
}
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/types.ts apps/api/config.ts apps/api/middleware/error.ts apps/api/test/config.test.ts
git commit -m "feat: add shared types, config defaults, and error handling"
```

---

### Task 4: Auth Middleware

**Files:**
- Create: `apps/api/middleware/auth.ts`
- Create: `apps/api/test/auth.test.ts`

- [ ] **Step 1: Write failing test for key hashing and verification**

`apps/api/test/auth.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { hashKey, verifyKey, generateKey } from '../middleware/auth'

describe('auth', () => {
  describe('generateKey', () => {
    it('generates a key with the correct prefix', () => {
      const key = generateKey('idx')
      expect(key.startsWith('idx_')).toBe(true)
      expect(key.length).toBeGreaterThan(20)
    })

    it('generates unique keys', () => {
      const a = generateKey('idx')
      const b = generateKey('idx')
      expect(a).not.toBe(b)
    })
  })

  describe('hashKey / verifyKey', () => {
    it('verifies a correct key against its hash', async () => {
      const key = generateKey('srch')
      const hash = await hashKey(key)
      expect(await verifyKey(key, hash)).toBe(true)
    })

    it('rejects an incorrect key', async () => {
      const key = generateKey('srch')
      const hash = await hashKey(key)
      expect(await verifyKey('srch_wrong', hash)).toBe(false)
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm test -- test/auth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write middleware/auth.ts**

```typescript
// ABOUTME: Three-tier authentication middleware for pgsearch API.
// ABOUTME: Verifies admin, index, and search keys against bcrypt hashes.

import { createMiddleware } from 'hono/factory'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import type { Context, Next } from 'hono'
import { apiError } from './error'

const BCRYPT_ROUNDS = 10

export function generateKey(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(24).toString('base64url')}`
}

export async function hashKey(key: string): Promise<string> {
  return bcrypt.hash(key, BCRYPT_ROUNDS)
}

export async function verifyKey(key: string, hash: string): Promise<boolean> {
  return bcrypt.compare(key, hash)
}

export const adminAuth = createMiddleware(async (c: Context, next: Next) => {
  const apiKey = c.req.header('x-api-key')
  if (!apiKey) {
    return apiError(c, 'UNAUTHORIZED', 'Missing x-api-key header')
  }
  // Admin key is stored in environment (from Secrets Manager)
  const adminKeyHash = process.env.ADMIN_KEY_HASH
  if (!adminKeyHash || !(await verifyKey(apiKey, adminKeyHash))) {
    return apiError(c, 'UNAUTHORIZED', 'Invalid admin key')
  }
  await next()
})

export const indexAuth = createMiddleware(async (c: Context, next: Next) => {
  const indexKey = c.req.header('x-index-key')
  if (!indexKey) {
    return apiError(c, 'UNAUTHORIZED', 'Missing x-index-key header')
  }
  // Index key hash is loaded from the search_indexes table.
  // The index name comes from the route param.
  // The route handler must set c.set('searchIndex', index) before this middleware,
  // or this middleware loads the index itself.
  // Implementation: load index by name, verify key, attach to context.
  const indexName = c.req.param('name')
  if (!indexName) {
    return apiError(c, 'VALIDATION_ERROR', 'Missing index name')
  }
  // Defer to route handler for DB lookup — middleware sets up the key check pattern.
  // The actual DB lookup will be implemented in the route handler.
  c.set('indexKey', indexKey)
  c.set('indexName', indexName)
  await next()
})

export const searchAuth = createMiddleware(async (c: Context, next: Next) => {
  const searchKey = c.req.header('x-search-key')
  if (!searchKey) {
    return apiError(c, 'UNAUTHORIZED', 'Missing x-search-key header')
  }
  c.set('searchKey', searchKey)
  c.set('indexName', c.req.param('name'))
  await next()
})
```

Note: The index/search auth middleware above sets up the pattern but defers DB lookup to the route handler (since middleware shouldn't own DB connections). The full auth verification (load index row → compare hash) will be completed in Task 5 when index management is implemented. Refactor the middleware to do the full check at that point.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && pnpm test -- test/auth.test.ts`
Expected: PASS for key generation and hash verification tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/middleware/auth.ts apps/api/test/auth.test.ts
git commit -m "feat: add auth key generation, hashing, and verification"
```

---

### Task 5: Index Management + Admin Routes

**Files:**
- Create: `apps/api/services/indexes.ts`
- Create: `apps/api/routes/admin.ts`
- Create: `apps/api/test/indexes.test.ts`

- [ ] **Step 1: Write failing test for index creation**

`apps/api/test/indexes.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, cleanupTestData } from './setup'
import { createIndex, getIndex, listIndexes, deleteIndex, updateIndex } from '../services/indexes'

describe('indexes service', () => {
  beforeAll(async () => { await setupSchema() })
  afterAll(async () => { await teardownSchema(); await closePool() })
  afterEach(async () => { await cleanupTestData() })

  it('creates an index and returns keys', async () => {
    const pool = await getTestPool()
    const result = await createIndex(pool, {
      name: 'test-index',
      description: 'A test index',
    })
    expect(result.name).toBe('test-index')
    expect(result.index_key).toBeDefined()
    expect(result.index_key.startsWith('idx_')).toBe(true)
    expect(result.search_key).toBeDefined()
    expect(result.search_key.startsWith('srch_')).toBe(true)
  })

  it('applies default config when none provided', async () => {
    const pool = await getTestPool()
    await createIndex(pool, { name: 'defaults-test' })
    const index = await getIndex(pool, 'defaults-test')
    expect(index).not.toBeNull()
    expect(index!.config.bm25_k1).toBe(1.2)
    expect(index!.config.blend_alpha).toBe(0.6)
  })

  it('rejects duplicate index names', async () => {
    const pool = await getTestPool()
    await createIndex(pool, { name: 'dupe' })
    await expect(createIndex(pool, { name: 'dupe' })).rejects.toThrow()
  })

  it('lists all indexes', async () => {
    const pool = await getTestPool()
    await createIndex(pool, { name: 'idx-a' })
    await createIndex(pool, { name: 'idx-b' })
    const indexes = await listIndexes(pool)
    expect(indexes.length).toBe(2)
  })

  it('deletes an index', async () => {
    const pool = await getTestPool()
    await createIndex(pool, { name: 'to-delete' })
    await deleteIndex(pool, 'to-delete')
    const index = await getIndex(pool, 'to-delete')
    expect(index).toBeNull()
  })

  it('updates index config', async () => {
    const pool = await getTestPool()
    await createIndex(pool, { name: 'to-update' })
    await updateIndex(pool, 'to-update', { bm25_k1: 2.0 })
    const index = await getIndex(pool, 'to-update')
    expect(index!.config.bm25_k1).toBe(2.0)
    expect(index!.config.bm25_b).toBe(0.75) // unchanged
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm test -- test/indexes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement services/indexes.ts**

Implement `createIndex`, `getIndex`, `listIndexes`, `updateIndex`, `deleteIndex`. On create:
1. Generate index key and search key via `generateKey()`
2. Hash both keys via `hashKey()`
3. Merge provided config with defaults via `mergeConfig()`
4. INSERT into `search_indexes`
5. Create per-index HNSW partial vector index on `search_segments`
6. Return name + plaintext keys + created_at

On delete: DROP the per-index HNSW index, then DELETE from `search_indexes` (cascades to documents and segments).

On update: Deep-merge using `mergeConfig()` at the application layer — read existing config, apply `mergeConfig(existingConfig, partialUpdate)`, write full config back. Do NOT use PostgreSQL's `||` operator for JSONB, as it does a shallow merge and would overwrite nested objects like `embedding` and `field_weights`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && pnpm test -- test/indexes.test.ts`
Expected: PASS

- [ ] **Step 5: Implement routes/admin.ts**

Wire Hono routes for all admin endpoints. Apply `adminAuth` middleware. Route handlers call service functions, passing the pool. Return JSON responses per spec.

- [ ] **Step 6: Refactor auth middleware**

Now that index service exists, update `indexAuth` and `searchAuth` middleware to load the index row by name, verify the key against the stored hash, and attach the `SearchIndex` object to the Hono context via `c.set('index', index)`. If the index doesn't exist, return 404. If the key doesn't match, return 401.

- [ ] **Step 6b: Add auth integration tests**

Add to `apps/api/test/indexes.test.ts`:

```typescript
describe('auth middleware integration', () => {
  it('indexAuth passes with valid index key', async () => {
    const pool = await getTestPool()
    const result = await createIndex(pool, { name: 'auth-test' })
    const index = await getIndex(pool, 'auth-test')
    expect(await verifyKey(result.index_key, index!.index_key_hash)).toBe(true)
  })

  it('indexAuth rejects with invalid index key', async () => {
    const pool = await getTestPool()
    await createIndex(pool, { name: 'auth-reject' })
    const index = await getIndex(pool, 'auth-reject')
    expect(await verifyKey('idx_wrong_key', index!.index_key_hash)).toBe(false)
  })

  it('searchAuth passes with valid search key', async () => {
    const pool = await getTestPool()
    const result = await createIndex(pool, { name: 'search-auth' })
    const index = await getIndex(pool, 'search-auth')
    expect(await verifyKey(result.search_key, index!.search_key_hash)).toBe(true)
  })
})
```

- [ ] **Step 6c: Run auth integration tests**

Run: `cd apps/api && pnpm test -- test/indexes.test.ts`
Expected: PASS — keys generated at creation verify against stored hashes.

- [ ] **Step 7: Commit**

```bash
git add apps/api/services/indexes.ts apps/api/routes/admin.ts apps/api/test/indexes.test.ts apps/api/middleware/auth.ts
git commit -m "feat: add index management service and admin routes"
```

---

### Task 6: Text Chunking

**Files:**
- Create: `apps/api/services/chunk.ts`
- Create: `apps/api/test/chunk.test.ts`

- [ ] **Step 1: Write failing tests for chunking**

`apps/api/test/chunk.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { chunkText, countTokens } from '../services/chunk'

describe('countTokens', () => {
  it('counts whitespace-delimited tokens', () => {
    expect(countTokens('hello world')).toBe(2)
    expect(countTokens('one two three four five')).toBe(5)
  })

  it('returns 0 for empty string', () => {
    expect(countTokens('')).toBe(0)
  })
})

describe('chunkText', () => {
  it('returns single segment for short text', () => {
    const segments = chunkText('Short paragraph.', { maxTokens: 500, minTokens: 50 })
    expect(segments).toHaveLength(1)
    expect(segments[0]).toBe('Short paragraph.')
  })

  it('splits on paragraph boundaries', () => {
    const text = 'First paragraph with enough words to be meaningful.\n\nSecond paragraph also with enough words.'
    const segments = chunkText(text, { maxTokens: 10, minTokens: 3 })
    expect(segments).toHaveLength(2)
    expect(segments[0]).toContain('First paragraph')
    expect(segments[1]).toContain('Second paragraph')
  })

  it('splits long paragraphs on sentence boundaries', () => {
    const longParagraph = 'Sentence one about something. Sentence two about another thing. Sentence three is here. Sentence four follows. Sentence five ends it.'
    const segments = chunkText(longParagraph, { maxTokens: 10, minTokens: 3 })
    expect(segments.length).toBeGreaterThan(1)
  })

  it('merges short trailing segments into previous', () => {
    const text = 'A substantial first paragraph with many words filling the space.\n\nTiny.'
    const segments = chunkText(text, { maxTokens: 500, minTokens: 50 })
    expect(segments).toHaveLength(1) // "Tiny." merges into first
  })

  it('respects max segments limit when provided', () => {
    const paragraphs = Array(200).fill('A paragraph with several words in it.').join('\n\n')
    const segments = chunkText(paragraphs, { maxTokens: 10, minTokens: 3 })
    // No limit enforcement in chunkText itself — the caller (ingest pipeline) checks the guardrail
    expect(segments.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm test -- test/chunk.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement services/chunk.ts**

```typescript
// ABOUTME: Text chunking for document ingestion.
// ABOUTME: Splits body text on paragraph and sentence boundaries targeting a configurable token size.

export interface ChunkOptions {
  maxTokens: number
  minTokens: number
}

export function countTokens(text: string): number {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 0
  return trimmed.split(/\s+/).length
}

export function chunkText(text: string, options: ChunkOptions): string[] {
  const { maxTokens, minTokens } = options
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0)

  const segments: string[] = []
  let current = ''

  for (const paragraph of paragraphs) {
    const paragraphTokens = countTokens(paragraph)

    if (paragraphTokens > maxTokens) {
      // Flush current segment if non-empty
      if (current.trim()) {
        segments.push(current.trim())
        current = ''
      }
      // Split long paragraph on sentence boundaries
      const sentences = splitSentences(paragraph)
      for (const sentence of sentences) {
        if (countTokens(current + ' ' + sentence) > maxTokens && current.trim()) {
          segments.push(current.trim())
          current = sentence
        } else {
          current = current ? current + ' ' + sentence : sentence
        }
      }
    } else if (countTokens(current + '\n\n' + paragraph) > maxTokens && current.trim()) {
      segments.push(current.trim())
      current = paragraph
    } else {
      current = current ? current + '\n\n' + paragraph : paragraph
    }
  }

  if (current.trim()) {
    segments.push(current.trim())
  }

  // Merge short trailing segment into previous
  if (segments.length > 1 && countTokens(segments[segments.length - 1]) < minTokens) {
    const last = segments.pop()!
    segments[segments.length - 1] += '\n\n' + last
  }

  return segments
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.?!])\s+/).filter(s => s.trim().length > 0)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && pnpm test -- test/chunk.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/services/chunk.ts apps/api/test/chunk.test.ts
git commit -m "feat: add text chunking with paragraph and sentence splitting"
```

---

### Task 7: Embedding Adapter

**Files:**
- Create: `packages/embeddings/src/adapter.ts`
- Create: `packages/embeddings/src/bedrock.ts`
- Create: `packages/embeddings/src/test.ts`
- Create: `packages/embeddings/src/index.ts`
- Create: `packages/embeddings/test/adapter.test.ts`

- [ ] **Step 1: Write failing test for embedding adapter interface**

`packages/embeddings/test/adapter.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { createTestAdapter } from '../src/test'

describe('test embedding adapter', () => {
  it('returns vectors with correct dimensions', async () => {
    const adapter = createTestAdapter(384)
    const results = await adapter.embed(['hello world'])
    expect(results).toHaveLength(1)
    expect(results[0]).toHaveLength(384)
  })

  it('returns consistent vectors for the same input', async () => {
    const adapter = createTestAdapter(384)
    const a = await adapter.embed(['hello world'])
    const b = await adapter.embed(['hello world'])
    expect(a[0]).toEqual(b[0])
  })

  it('returns different vectors for different inputs', async () => {
    const adapter = createTestAdapter(384)
    const results = await adapter.embed(['hello', 'world'])
    expect(results[0]).not.toEqual(results[1])
  })

  it('batches multiple texts', async () => {
    const adapter = createTestAdapter(384)
    const results = await adapter.embed(['one', 'two', 'three'])
    expect(results).toHaveLength(3)
  })

  it('exposes model and dimensions', () => {
    const adapter = createTestAdapter(384)
    expect(adapter.dimensions).toBe(384)
    expect(adapter.model).toBe('test-deterministic')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/embeddings && pnpm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement adapter interface and test adapter**

`packages/embeddings/src/adapter.ts`:
```typescript
// ABOUTME: Embedding adapter interface for pluggable vector generation.
// ABOUTME: Implementations provide batch text-to-vector conversion.

export interface EmbeddingAdapter {
  embed(texts: string[]): Promise<number[][]>
  dimensions: number
  model: string
}
```

`packages/embeddings/src/test.ts`:
```typescript
// ABOUTME: Deterministic test embedding adapter for integration testing.
// ABOUTME: Produces consistent, unique vectors from text input without a real model.

import crypto from 'crypto'
import type { EmbeddingAdapter } from './adapter'

export function createTestAdapter(dimensions: number): EmbeddingAdapter {
  return {
    model: 'test-deterministic',
    dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(text => {
        const hash = crypto.createHash('sha256').update(text).digest()
        const vector: number[] = []
        for (let i = 0; i < dimensions; i++) {
          // Deterministic pseudo-random float from hash bytes
          vector.push((hash[i % hash.length] / 255) * 2 - 1)
        }
        // Normalize to unit vector
        const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
        return vector.map(v => v / magnitude)
      })
    },
  }
}
```

`packages/embeddings/src/index.ts`:
```typescript
// ABOUTME: Embedding adapter package exports.
// ABOUTME: Provides adapter interface, implementations, and factory.

export type { EmbeddingAdapter } from './adapter'
export { createTestAdapter } from './test'
export { createBedrockAdapter } from './bedrock'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/embeddings && pnpm test`
Expected: PASS

- [ ] **Step 5: Implement Bedrock adapter**

`packages/embeddings/src/bedrock.ts`:
```typescript
// ABOUTME: AWS Bedrock embedding adapter for production vector generation.
// ABOUTME: Calls Bedrock InvokeModel API for text embedding.

import type { EmbeddingAdapter } from './adapter'

export interface BedrockAdapterConfig {
  model: string
  dimensions: number
  region?: string
}

export function createBedrockAdapter(config: BedrockAdapterConfig): EmbeddingAdapter {
  // Lazy-load the AWS SDK to avoid import overhead when not used
  let client: any = null

  async function getClient() {
    if (!client) {
      const { BedrockRuntimeClient, InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime')
      client = { Client: new BedrockRuntimeClient({ region: config.region || 'us-east-1' }), InvokeModelCommand }
    }
    return client
  }

  return {
    model: config.model,
    dimensions: config.dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      const { Client, InvokeModelCommand } = await getClient()
      const results: number[][] = []
      for (const text of texts) {
        const response = await Client.send(new InvokeModelCommand({
          modelId: config.model,
          contentType: 'application/json',
          body: JSON.stringify({
            inputText: text,
            dimensions: config.dimensions,
            normalize: true,
          }),
        }))
        const body = JSON.parse(new TextDecoder().decode(response.body))
        results.push(body.embedding)
      }
      return results
    },
  }
}
```

Note: The Bedrock adapter processes texts sequentially. Batch optimization (parallel requests) can be added later if needed.

- [ ] **Step 6: Commit**

```bash
git add packages/embeddings/
git commit -m "feat: add embedding adapter interface with test and Bedrock implementations"
```

---

### Task 8: Ingest Pipeline + Routes

**Files:**
- Create: `apps/api/services/ingest.ts`
- Create: `apps/api/routes/ingest.ts`
- Create: `apps/api/test/ingest.test.ts`

This is the largest task. The ingest pipeline: validate → chunk → guardrail → hash → diff → embed → tsvector → upsert → refresh check.

- [ ] **Step 1: Write failing test for document ingestion**

`apps/api/test/ingest.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, cleanupTestData, closePool } from './setup'
import { createIndex } from '../services/indexes'
import { ingestDocument, deleteDocument } from '../services/ingest'
import { createTestAdapter } from '@phila/search-embeddings'

describe('ingest service', () => {
  let pool: any
  let indexId: number
  const adapter = createTestAdapter(384)

  beforeAll(async () => {
    await setupSchema()
    pool = await getTestPool()
    const result = await createIndex(pool, { name: 'ingest-test' })
    // Retrieve the index_id for later use
    const row = await pool.query("SELECT index_id FROM search_indexes WHERE name = 'ingest-test'")
    indexId = row.rows[0].index_id
  })
  afterAll(async () => { await teardownSchema(); await closePool() })
  afterEach(async () => {
    await pool.query('DELETE FROM search_segments')
    await pool.query('DELETE FROM search_documents')
  })

  it('ingests a document and creates segments', async () => {
    const result = await ingestDocument(pool, indexId, adapter, {
      external_id: 'doc-1',
      title: 'Test Document',
      body: 'This is the body of the test document with enough content.',
    }, { max_segment_tokens: 500, max_segments_per_document: 100, text_search_config: 'english' })

    expect(result.external_id).toBe('doc-1')
    expect(result.segments).toBeGreaterThan(0)
    expect(result.status).toBe('indexed')
  })

  it('upserts an existing document without re-embedding unchanged segments', async () => {
    const doc = {
      external_id: 'doc-2',
      title: 'Upsert Test',
      body: 'Content that will not change between ingests.',
    }

    const first = await ingestDocument(pool, indexId, adapter, doc, { max_segment_tokens: 500, max_segments_per_document: 100, text_search_config: 'english' })
    const second = await ingestDocument(pool, indexId, adapter, doc, { max_segment_tokens: 500, max_segments_per_document: 100, text_search_config: 'english' })

    expect(second.unchanged).toBe(first.segments)
    expect(second.changed).toBe(0)
  })

  it('detects changed content and re-embeds', async () => {
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'doc-3',
      title: 'Change Test',
      body: 'Original content here.',
    }, { max_segment_tokens: 500, max_segments_per_document: 100, text_search_config: 'english' })

    const result = await ingestDocument(pool, indexId, adapter, {
      external_id: 'doc-3',
      title: 'Change Test',
      body: 'Updated content here that is different.',
    }, { max_segment_tokens: 500, max_segments_per_document: 100, text_search_config: 'english' })

    expect(result.changed).toBeGreaterThan(0)
  })

  it('rejects documents exceeding segment limit', async () => {
    const longBody = Array(200).fill('A paragraph with several words. Another sentence here.').join('\n\n')
    await expect(
      ingestDocument(pool, indexId, adapter, {
        external_id: 'too-long',
        title: 'Too Long',
        body: longBody,
      }, { max_segment_tokens: 10, max_segments_per_document: 5, text_search_config: 'english' })
    ).rejects.toThrow()
  })

  it('generates tsvectors for title and body', async () => {
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'tsvector-test',
      title: 'Parking Permits',
      body: 'Apply for a residential parking permit online.',
    }, { max_segment_tokens: 500, max_segments_per_document: 100, text_search_config: 'english' })

    const doc = await pool.query(
      "SELECT title_tsvector FROM search_documents WHERE external_id = 'tsvector-test' AND index_id = $1",
      [indexId]
    )
    expect(doc.rows[0].title_tsvector).toBeTruthy()

    const seg = await pool.query(
      "SELECT body_tsvector FROM search_segments WHERE document_id = $1",
      [doc.rows[0]?.document_id || (await pool.query("SELECT document_id FROM search_documents WHERE external_id = 'tsvector-test'")).rows[0].document_id]
    )
    expect(seg.rows[0].body_tsvector).toBeTruthy()
  })

  it('increments total_documents on new document', async () => {
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'counter-1',
      title: 'First',
      body: 'First document content.',
    }, { max_segment_tokens: 500, max_segments_per_document: 100, text_search_config: 'english' })

    const idx = await pool.query('SELECT total_documents FROM search_indexes WHERE index_id = $1', [indexId])
    expect(idx.rows[0].total_documents).toBe(1)
  })

  it('does not increment total_documents on upsert of existing document', async () => {
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'counter-1',
      title: 'First Updated',
      body: 'Updated content.',
    }, { max_segment_tokens: 500, max_segments_per_document: 100, text_search_config: 'english' })

    const idx = await pool.query('SELECT total_documents FROM search_indexes WHERE index_id = $1', [indexId])
    expect(idx.rows[0].total_documents).toBe(1) // still 1, not 2
  })

  it('deletes a document and decrements total_documents', async () => {
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'to-delete',
      title: 'Delete Me',
      body: 'Content to be deleted.',
    }, { max_segment_tokens: 500, max_segments_per_document: 100, text_search_config: 'english' })

    const before = await pool.query('SELECT total_documents FROM search_indexes WHERE index_id = $1', [indexId])
    await deleteDocument(pool, indexId, 'to-delete')
    const after = await pool.query('SELECT total_documents FROM search_indexes WHERE index_id = $1', [indexId])

    expect(after.rows[0].total_documents).toBe(before.rows[0].total_documents - 1)

    const doc = await pool.query(
      "SELECT * FROM search_documents WHERE external_id = 'to-delete' AND index_id = $1",
      [indexId]
    )
    expect(doc.rows).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm test -- test/ingest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement services/ingest.ts**

Implement `ingestDocument(pool, indexId, adapter, request, config)`:

1. Validate required fields (external_id, title, body)
2. Chunk body via `chunkText()`
3. Check segment count against `max_segments_per_document` — throw if exceeded
4. SHA-256 hash each segment body
5. Load existing segments for this document (if any) — query by `(index_id, external_id)` join to segments
6. Diff: match new hashes against existing `content_hash` values. Identify new, changed, and unchanged segments.
7. Generate embeddings for new/changed segments only. Prepend title: `"${title}\n\n${segmentBody}"`
8. Generate tsvectors for title and changed segments using `to_tsvector(config, text)`
9. Upsert in a transaction:
   - `INSERT ... ON CONFLICT (index_id, external_id) DO UPDATE` for the document row
   - Delete segments with hashes no longer present
   - Insert new segments, update changed segments
   - Update `segment_count`, `total_documents`, `docs_changed_since_refresh`
10. Return `IngestResponse`

Also implement `deleteDocument(pool, indexId, externalId)` — DELETE from `search_documents` (CASCADE handles segments), decrement `total_documents`, increment `docs_changed_since_refresh`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && pnpm test -- test/ingest.test.ts`
Expected: PASS

- [ ] **Step 5: Implement routes/ingest.ts**

Wire Hono routes for `POST /index/:name/documents` and `DELETE /index/:name/documents/:external_id`. Apply `indexAuth` middleware. Load index from DB, verify key, get embedding adapter from index config, call ingest service.

- [ ] **Step 6: Commit**

```bash
git add apps/api/services/ingest.ts apps/api/routes/ingest.ts apps/api/test/ingest.test.ts
git commit -m "feat: add document ingest pipeline with chunking and hash-based diffing"
```

---

### Task 9: Materialized View Refresh

**Files:**
- Create: `apps/api/services/refresh.ts`

- [ ] **Step 1: Write failing test for refresh logic**

Add to `apps/api/test/ingest.test.ts` or create a separate test:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, closePool } from './setup'
import { createIndex } from '../services/indexes'
import { ingestDocument } from '../services/ingest'
import { refreshIndex } from '../services/refresh'
import { createTestAdapter } from '@phila/search-embeddings'

describe('materialized view refresh', () => {
  let pool: any
  let indexId: number
  const adapter = createTestAdapter(384)

  beforeAll(async () => {
    await setupSchema()
    pool = await getTestPool()
    // Create index with low refresh threshold for testing
    const result = await createIndex(pool, {
      name: 'refresh-test',
      config: { refresh_threshold: 2 },
    })
    const row = await pool.query("SELECT index_id FROM search_indexes WHERE name = 'refresh-test'")
    indexId = row.rows[0].index_id
  })
  afterAll(async () => { await teardownSchema(); await closePool() })

  it('populates term_document_frequencies after refresh', async () => {
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'doc-a',
      title: 'Parking Permits',
      body: 'Apply for a residential parking permit.',
    }, { max_segment_tokens: 500, max_segments_per_document: 100, text_search_config: 'english' })

    await refreshIndex(pool, indexId)

    const tdf = await pool.query(
      'SELECT * FROM term_document_frequencies WHERE index_id = $1',
      [indexId]
    )
    expect(tdf.rows.length).toBeGreaterThan(0)
  })

  it('updates avg_title_length and avg_body_length on the index', async () => {
    await refreshIndex(pool, indexId)

    const idx = await pool.query(
      'SELECT avg_title_length, avg_body_length FROM search_indexes WHERE index_id = $1',
      [indexId]
    )
    expect(idx.rows[0].avg_title_length).toBeGreaterThan(0)
    expect(idx.rows[0].avg_body_length).toBeGreaterThan(0)
  })

  it('resets docs_changed_since_refresh after refresh', async () => {
    await refreshIndex(pool, indexId)

    const idx = await pool.query(
      'SELECT docs_changed_since_refresh FROM search_indexes WHERE index_id = $1',
      [indexId]
    )
    expect(idx.rows[0].docs_changed_since_refresh).toBe(0)
  })

  it('auto-refreshes when threshold is met via ingest', async () => {
    // Threshold is 2, so 2nd ingest should trigger refresh
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'doc-b',
      title: 'Property Taxes',
      body: 'Pay your property taxes online.',
    }, { max_segment_tokens: 500, max_segments_per_document: 100, text_search_config: 'english' })

    // After 2 documents ingested with threshold 2, refresh should have triggered
    const idx = await pool.query(
      'SELECT docs_changed_since_refresh, last_refreshed_at FROM search_indexes WHERE index_id = $1',
      [indexId]
    )
    expect(idx.rows[0].last_refreshed_at).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement services/refresh.ts**

```typescript
// ABOUTME: Materialized view refresh and corpus statistics recomputation.
// ABOUTME: Refreshes term_document_frequencies and updates avg field lengths on the index.
```

Implement `refreshIndex(pool, indexId)`:
1. `REFRESH MATERIALIZED VIEW CONCURRENTLY term_document_frequencies`
2. Compute `AVG(title_length)` from `search_documents WHERE index_id = $1`
3. Compute `AVG(body_length)` from `search_segments WHERE index_id = $1`
4. Update `search_indexes` with new averages, reset `docs_changed_since_refresh`, update `last_refreshed_at`

Implement `checkAndRefresh(pool, indexId, threshold)`:
1. Query current `docs_changed_since_refresh` for the index
2. If >= threshold, call `refreshIndex()`

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Integrate refresh check into ingest pipeline**

At end of `ingestDocument()`, call `checkAndRefresh()` with the index's configured threshold.

- [ ] **Step 6: Commit**

```bash
git add apps/api/services/refresh.ts
git commit -m "feat: add materialized view refresh with threshold-based triggering"
```

---

### Task 10: BM25F Scoring

**Files:**
- Create: `apps/api/services/score.ts`
- Create: `apps/api/test/score.test.ts`

- [ ] **Step 1: Write failing test for BM25F scoring**

`apps/api/test/score.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { computeIDF, computeBM25F, normalizeScores } from '../services/score'

describe('BM25F scoring', () => {
  describe('computeIDF', () => {
    it('computes IDF for a term', () => {
      // N=100 docs, df=10 docs contain the term
      const idf = computeIDF(100, 10)
      expect(idf).toBeCloseTo(Math.log((100 - 10 + 0.5) / (10 + 0.5) + 1))
    })

    it('returns positive IDF for rare terms', () => {
      expect(computeIDF(1000, 1)).toBeGreaterThan(0)
    })

    it('returns near-zero IDF for ubiquitous terms', () => {
      expect(computeIDF(100, 99)).toBeLessThan(0.1)
    })
  })

  describe('computeBM25F', () => {
    it('scores higher for title matches than body matches', () => {
      const params = {
        k1: 1.2, b: 0.75,
        fieldWeights: { title: 3.0, body: 1.0 },
        avgTitleLength: 5, avgBodyLength: 100,
        totalDocuments: 1000,
      }

      const titleMatch = computeBM25F({
        termFreqs: [{ term: 'parking', titleTf: 1, bodyTf: 0, df: 50 }],
        titleLength: 5, bodyLength: 100,
        ...params,
      })

      const bodyMatch = computeBM25F({
        termFreqs: [{ term: 'parking', titleTf: 0, bodyTf: 1, df: 50 }],
        titleLength: 5, bodyLength: 100,
        ...params,
      })

      expect(titleMatch).toBeGreaterThan(bodyMatch)
    })
  })

  describe('normalizeScores', () => {
    it('normalizes to 0-1 range using min-max', () => {
      const scores = [1.0, 3.0, 5.0]
      const normalized = normalizeScores(scores)
      expect(normalized[0]).toBe(0)
      expect(normalized[1]).toBe(0.5)
      expect(normalized[2]).toBe(1)
    })

    it('handles single-element arrays', () => {
      const normalized = normalizeScores([5.0])
      expect(normalized[0]).toBe(1)
    })

    it('handles all-equal scores', () => {
      const normalized = normalizeScores([3.0, 3.0, 3.0])
      expect(normalized).toEqual([1, 1, 1])
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && pnpm test -- test/score.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement services/score.ts**

```typescript
// ABOUTME: BM25F scoring functions for field-weighted keyword relevance.
// ABOUTME: Computes IDF, field-weighted term frequency, and min-max score normalization.
```

Implement:
- `computeIDF(totalDocuments, documentFrequency) → number`
- `computeBM25F({ termFreqs, titleLength, bodyLength, k1, b, fieldWeights, avgTitleLength, avgBodyLength, totalDocuments }) → number`
- `normalizeScores(scores) → number[]`

The BM25F function iterates over query terms, computing the formula from the spec for each term, and sums the scores.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && pnpm test -- test/score.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/services/score.ts apps/api/test/score.test.ts
git commit -m "feat: add BM25F scoring with IDF and field-weighted term frequency"
```

---

### Task 11: Vector Search

This task implements the pgvector nearest-neighbor query path. It's a focused SQL query — no separate service file needed; it will be a function within the search service.

- [ ] **Step 1: Write a test that ingests documents and queries by vector similarity**

Add to `apps/api/test/search.test.ts` (create the file):

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, closePool } from './setup'
import { createIndex } from '../services/indexes'
import { ingestDocument } from '../services/ingest'
import { vectorCandidates } from '../services/search'
import { createTestAdapter } from '@phila/search-embeddings'

describe('vector search', () => {
  let pool: any
  let indexId: number
  const adapter = createTestAdapter(384)

  beforeAll(async () => {
    await setupSchema()
    pool = await getTestPool()
    const result = await createIndex(pool, { name: 'vector-test' })
    const row = await pool.query("SELECT index_id FROM search_indexes WHERE name = 'vector-test'")
    indexId = row.rows[0].index_id

    // Ingest test documents
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'parking',
      title: 'Parking Permits',
      body: 'Apply for a residential parking permit online.',
    }, { max_segment_tokens: 500, max_segments_per_document: 100, text_search_config: 'english' })

    await ingestDocument(pool, indexId, adapter, {
      external_id: 'taxes',
      title: 'Property Taxes',
      body: 'Pay your property taxes online or by mail.',
    }, { max_segment_tokens: 500, max_segments_per_document: 100, text_search_config: 'english' })

    // Manually refresh so BM25F path has IDF data in term_document_frequencies
    const { refreshIndex } = await import('../services/refresh')
    await refreshIndex(pool, indexId)
  })

  afterAll(async () => { await teardownSchema(); await closePool() })

  it('retrieves candidates by vector similarity', async () => {
    const queryEmbedding = (await adapter.embed(['parking permit application']))[0]
    const candidates = await vectorCandidates(pool, indexId, queryEmbedding, 10)
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates[0]).toHaveProperty('segment_id')
    expect(candidates[0]).toHaveProperty('similarity')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement vectorCandidates function**

In `apps/api/services/search.ts`:

```sql
SELECT s.segment_id, s.document_id, s.body, s.body_length,
       1 - (s.embedding <=> $1::vector) AS similarity
FROM search_segments s
WHERE s.index_id = $2
ORDER BY s.embedding <=> $1::vector
LIMIT $3
```

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add apps/api/services/search.ts apps/api/test/search.test.ts
git commit -m "feat: add pgvector nearest-neighbor candidate retrieval"
```

---

### Task 12: Hybrid Search + Search Routes

**Files:**
- Modify: `apps/api/services/search.ts`
- Create: `apps/api/routes/search.ts`
- Modify: `apps/api/test/search.test.ts`

- [ ] **Step 1: Write failing test for full hybrid search**

Add to `apps/api/test/search.test.ts`:

```typescript
describe('hybrid search', () => {
  // Uses the same test data from Task 11 setup

  it('returns results with scores, titles, snippets, and metadata', async () => {
    const results = await hybridSearch(pool, indexId, adapter, 'parking permit', { limit: 10 })
    expect(results.results.length).toBeGreaterThan(0)
    expect(results.results[0]).toHaveProperty('external_id')
    expect(results.results[0]).toHaveProperty('score')
    expect(results.results[0]).toHaveProperty('title')
    expect(results.results[0]).toHaveProperty('snippet')
    expect(results.total).toBeGreaterThan(0)
  })

  it('ranks relevant documents higher', async () => {
    const results = await hybridSearch(pool, indexId, adapter, 'parking permit', { limit: 10 })
    expect(results.results[0].external_id).toBe('parking')
  })

  it('deduplicates results by document', async () => {
    // Ingest a document with multiple segments
    const longBody = Array(5).fill('Parking permit information and details about the application process.').join('\n\n')
    await ingestDocument(pool, indexId, adapter, {
      external_id: 'multi-segment',
      title: 'Parking Info',
      body: longBody,
    }, { max_segment_tokens: 15, max_segments_per_document: 100, text_search_config: 'english' })

    const results = await hybridSearch(pool, indexId, adapter, 'parking', { limit: 10 })
    const multiSegmentResults = results.results.filter(r => r.external_id === 'multi-segment')
    expect(multiSegmentResults.length).toBeLessThanOrEqual(1)
  })

  it('returns empty results for no matches', async () => {
    const results = await hybridSearch(pool, indexId, adapter, 'xyzzy nonexistent term', { limit: 10 })
    expect(results.results).toHaveLength(0)
    expect(results.total).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement hybridSearch in services/search.ts**

Implement `hybridSearch(pool, indexId, adapter, queryText, options)`:

1. Load index config from `search_indexes`
2. Parse query: `plainto_tsquery(text_search_config, queryText)` → tsquery
3. Embed query: `adapter.embed([queryText])` → query embedding
4. **BM25F path:**
   - Candidate retrieval: segments + documents matching tsquery via GIN, limit 200
   - For each candidate, look up term frequencies and compute BM25F score using `computeBM25F()`
   - Term document frequencies from `term_document_frequencies` view
5. **Vector path:**
   - Call `vectorCandidates()` for top 200 by cosine similarity
6. **Merge:**
   - Union candidate sets by `segment_id`
   - Normalize BM25F scores and vector scores independently via `normalizeScores()`
   - Blend: `alpha * bm25f_normalized + (1 - alpha) * vector_normalized`
7. **Deduplicate:** Group by `document_id`, take max-scoring segment per document
8. **Return:** Top K results as `SearchResponse`

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Implement routes/search.ts**

Wire `GET /search/:name` with `searchAuth` middleware. Parse `q` and `limit` from query params. Load index, verify search key, call `hybridSearch()`, return response.

- [ ] **Step 6: Commit**

```bash
git add apps/api/services/search.ts apps/api/routes/search.ts apps/api/test/search.test.ts
git commit -m "feat: add hybrid search with BM25F + vector scoring and blending"
```

---

### Task 13: Wire Lambda Entry Point

**Files:**
- Modify: `apps/api/index.ts`
- Create: `apps/api/routes/health.ts`

- [ ] **Step 1: Create routes/health.ts**

```typescript
// ABOUTME: Health check endpoint with database connectivity verification.
// ABOUTME: Returns service status and database connection state.

import { Hono } from 'hono'
import { getPool } from '../db/pool'

export const healthRoutes = new Hono()

healthRoutes.get('/public/health', async (c) => {
  try {
    const pool = await getPool()
    await pool.query('SELECT 1')
    return c.json({ status: 'healthy', database: 'connected', timestamp: new Date().toISOString() })
  } catch (error) {
    return c.json({ status: 'unhealthy', database: 'disconnected', timestamp: new Date().toISOString() }, 503)
  }
})
```

- [ ] **Step 2: Rewrite apps/api/index.ts**

Replace the placeholder with the real application. Wire all route groups:

```typescript
// ABOUTME: Lambda entry point for the pgsearch hybrid search API.
// ABOUTME: Wires all route groups (admin, ingest, search, health) with auth middleware.

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { handle } from 'hono/aws-lambda'
import { adminRoutes } from './routes/admin'
import { ingestRoutes } from './routes/ingest'
import { searchRoutes } from './routes/search'
import { healthRoutes } from './routes/health'

const app = new Hono()

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-index-key', 'x-search-key'],
}))

app.route('/', healthRoutes)
app.route('/', adminRoutes)
app.route('/', ingestRoutes)
app.route('/', searchRoutes)

app.onError((err, c) => {
  console.error('Unhandled error:', err)
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500)
})

export const handler = handle(app)
```

- [ ] **Step 3: Update esbuild command if needed**

Verify the esbuild command in `apps/api/package.json` still bundles correctly with the new file structure. The entry point is still `index.ts`, and esbuild follows imports. May need to add `--external:@phila/db-postgres` or similar if certain modules shouldn't be bundled.

- [ ] **Step 4: Build and verify**

Run: `cd apps/api && pnpm run build`
Expected: `dist/index.js` generated without errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/index.ts apps/api/routes/health.ts
git commit -m "feat: wire all routes into Lambda entry point"
```

---

### Task 14: Client Library (can run in parallel after Task 3)

**Files:**
- Create: `packages/client/src/index.ts`
- Create: `packages/client/src/types.ts`
- Create: `packages/client/test/client.test.ts`

- [ ] **Step 1: Write failing test for client**

Test the client's type contract and request construction (not against a live server — that requires the full API running).

```typescript
import { describe, it, expect } from 'vitest'
import { PgsearchClient } from '../src'

describe('PgsearchClient', () => {
  it('constructs with base URL and keys', () => {
    const client = new PgsearchClient({
      baseUrl: 'https://api.example.com',
      adminKey: 'admin_key',
    })
    expect(client).toBeDefined()
  })

  // Additional tests against a real server would be integration tests
  // run as part of a deployed environment test suite.
})
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement PgsearchClient**

`packages/client/src/types.ts` — Re-export the API contract types (CreateIndexRequest, CreateIndexResponse, IngestRequest, IngestResponse, SearchResponse, etc.). These mirror the types in `apps/api/types.ts`. Consider extracting shared types into a `packages/types` package later to avoid duplication, but for now keep it simple.

`packages/client/src/index.ts`:
```typescript
// ABOUTME: Typed HTTP client for the pgsearch search API.
// ABOUTME: Provides methods for index management, document ingestion, and search.
```

Implement `PgsearchClient` with methods:
- `createIndex(request)` → `CreateIndexResponse`
- `listIndexes()` → `SearchIndex[]`
- `getIndex(name)` → `SearchIndex`
- `updateIndex(name, config)` → `void`
- `deleteIndex(name)` → `void`
- `refreshIndex(name)` → `void`
- `ingest(indexName, document, indexKey)` → `IngestResponse`
- `deleteDocument(indexName, externalId, indexKey)` → `void`
- `search(indexName, query, searchKey, options?)` → `SearchResponse`

Uses `fetch` internally. Each method sets the appropriate auth header.

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Commit**

```bash
git add packages/client/
git commit -m "feat: add typed pgsearch client library"
```

---

### Task 15: Ingest Parsers (can run in parallel after Task 3)

**Files:**
- Create: `packages/ingest/src/index.ts`
- Create: `packages/ingest/src/html.ts`
- Create: `packages/ingest/src/text.ts`
- Create: `packages/ingest/test/html.test.ts`
- Create: `packages/ingest/test/text.test.ts`

- [ ] **Step 1: Write failing test for HTML parser**

```typescript
import { describe, it, expect } from 'vitest'
import { parseHtml } from '../src/html'

describe('parseHtml', () => {
  it('extracts title from h1', () => {
    const doc = parseHtml('<html><body><h1>My Title</h1><p>Content here.</p></body></html>')
    expect(doc.title).toBe('My Title')
  })

  it('extracts body text without HTML tags', () => {
    const doc = parseHtml('<html><body><h1>Title</h1><p>Paragraph one.</p><p>Paragraph two.</p></body></html>')
    expect(doc.body).toContain('Paragraph one')
    expect(doc.body).toContain('Paragraph two')
    expect(doc.body).not.toContain('<p>')
  })

  it('uses custom selectors', () => {
    const html = '<html><body><div class="title">Custom Title</div><main>Main content.</main></body></html>'
    const doc = parseHtml(html, { titleSelector: '.title', contentSelector: 'main' })
    expect(doc.title).toBe('Custom Title')
    expect(doc.body).toBe('Main content.')
  })

  it('merges provided metadata', () => {
    const doc = parseHtml('<html><body><h1>T</h1><p>B</p></body></html>', {
      metadata: { source: 'phila.gov', url: 'https://phila.gov/page' }
    })
    expect(doc.metadata.source).toBe('phila.gov')
    expect(doc.metadata.url).toBe('https://phila.gov/page')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement HTML parser**

Use a lightweight HTML parser (e.g., `cheerio` or `node-html-parser`). Add as a dependency of `packages/ingest`.

`packages/ingest/src/html.ts`:
```typescript
// ABOUTME: Parses HTML documents into structured text for search ingestion.
// ABOUTME: Extracts title, body text, and metadata from HTML content.
```

Returns `{ external_id?: string, title: string, body: string, metadata: Record<string, unknown> }` matching the pgsearch ingest API contract.

- [ ] **Step 4: Run test to verify it passes**

- [ ] **Step 5: Write failing test for text parser**

```typescript
import { describe, it, expect } from 'vitest'
import { parseText } from '../src/text'

describe('parseText', () => {
  it('uses first line as title if not provided', () => {
    const doc = parseText('First Line\n\nBody content here.')
    expect(doc.title).toBe('First Line')
    expect(doc.body).toBe('Body content here.')
  })

  it('uses provided title', () => {
    const doc = parseText('Full text here.', { title: 'Custom Title' })
    expect(doc.title).toBe('Custom Title')
    expect(doc.body).toBe('Full text here.')
  })
})
```

- [ ] **Step 6: Implement text parser**

- [ ] **Step 7: Run tests to verify all pass**

- [ ] **Step 8: Wire exports in packages/ingest/src/index.ts**

```typescript
// ABOUTME: Content parsing utilities for pgsearch document ingestion.
// ABOUTME: Converts HTML and plain text into structured documents.

export { parseHtml } from './html'
export { parseText } from './text'
```

- [ ] **Step 9: Commit**

```bash
git add packages/ingest/
git commit -m "feat: add HTML and text content parsers for search ingestion"
```

---

## Post-Implementation

After all tasks are complete:

1. Run full test suite: `pnpm test` from root
2. Build all packages: `pnpm run build`
3. Verify CDK still synthesizes: `pnpm run synth`
4. Update CDK stack if needed (additional environment variables, S3 bucket for models, etc.)
5. Update README.md with the new API documentation
