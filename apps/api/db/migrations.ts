// ABOUTME: Database migration definitions for pgsearch schema evolution.
// ABOUTME: Each migration is a versioned SQL statement applied once on cold start.

export interface Migration {
  version: number
  description: string
  sql: string
}

export const migrations: Migration[] = [
  {
    version: 1,
    description: 'Initial schema with search indexes, documents, segments, and term frequency view',
    sql: `
CREATE EXTENSION IF NOT EXISTS vector;

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
    `,
  },
  {
    version: 2,
    description: 'RAG: add rag_key_hash to search_indexes; create rag_prompts',
    sql: `
ALTER TABLE search_indexes
  ADD COLUMN IF NOT EXISTS rag_key_hash TEXT;

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
    `,
  },
]
