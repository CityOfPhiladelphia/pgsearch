// ABOUTME: Database schema: a declarative baseline plus imperative change-set migrations.
// ABOUTME: The baseline applies the full current schema to a fresh database in one step.

export interface Migration {
  version: number
  description: string
  sql: string
}

// The baseline is the complete schema as of its version and must stay idempotent.
// Databases that were migrated through the historical v1-v5 chain already record
// version 5 and skip it; fresh databases apply it in one step.
//
// Schema changes are appended below the baseline as imperative migrations
// (version 6+) describing the delta. When the change-set list grows unwieldy,
// fold it into a new baseline stamped with the highest folded version.
const BASELINE = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS search_indexes (
    index_id            SERIAL PRIMARY KEY,
    name                TEXT UNIQUE NOT NULL,
    description         TEXT,
    config              JSONB NOT NULL DEFAULT '{}',
    index_key_hash      TEXT NOT NULL,
    search_key_hash     TEXT NOT NULL,
    rag_key_hash        TEXT,
    total_documents     INTEGER NOT NULL DEFAULT 0,
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

-- Stores named prompt templates scoped to an index; a null rag_key_hash on the
-- index means RAG is disabled. Content is JSONB to support future composition
-- fields without schema changes.
CREATE TABLE IF NOT EXISTS rag_prompts (
    prompt_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    index_id    INTEGER NOT NULL REFERENCES search_indexes(index_id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    content     JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (index_id, name)
);

CREATE INDEX IF NOT EXISTS idx_rag_prompts_index_id ON rag_prompts (index_id);
`

export const migrations: Migration[] = [
  {
    version: 5,
    description: 'Baseline schema',
    sql: BASELINE,
  },
  {
    version: 6,
    description: 'Document kind label for result-type weighting',
    sql: `ALTER TABLE search_documents ADD COLUMN IF NOT EXISTS kind TEXT;`,
  },
  {
    version: 7,
    description: 'Drop pg_cron; its only job died with the BM25F stats subsystem',
    sql: `DROP EXTENSION IF EXISTS pg_cron;`,
  },
  {
    version: 8,
    description: 'Drop write-only BM25F length-normalization columns',
    sql: `ALTER TABLE search_documents DROP COLUMN IF EXISTS title_length;
          ALTER TABLE search_segments DROP COLUMN IF EXISTS body_length;`,
  },
]
