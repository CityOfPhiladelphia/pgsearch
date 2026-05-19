// ABOUTME: CRUD operations for per-index RAG prompts stored in rag_prompts.
// ABOUTME: Prompt content is JSONB so future composition (extends, includes) is additive.

import type { Pool } from 'pg'
import type { RagPrompt, PromptContent } from '../types'

function rowToPrompt(row: any): RagPrompt {
  return {
    prompt_id: row.prompt_id,
    index_id: row.index_id,
    name: row.name,
    content: typeof row.content === 'string' ? JSON.parse(row.content) : row.content,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

// Returns null when (index_id, name) already exists. The UNIQUE constraint is
// enforced by the DB via ON CONFLICT, so callers guard on null instead of
// catching a 23505 exception.
export async function createPrompt(
  pool: Pool,
  indexId: number,
  name: string,
  content: PromptContent,
): Promise<RagPrompt | null> {
  const result = await pool.query(
    `INSERT INTO rag_prompts (index_id, name, content)
     VALUES ($1, $2, $3)
     ON CONFLICT (index_id, name) DO NOTHING
     RETURNING *`,
    [indexId, name, JSON.stringify(content)],
  )
  if (result.rows.length === 0) return null
  return rowToPrompt(result.rows[0])
}

export async function getPrompt(
  pool: Pool,
  indexId: number,
  name: string,
): Promise<RagPrompt | null> {
  const result = await pool.query(
    `SELECT * FROM rag_prompts WHERE index_id = $1 AND name = $2`,
    [indexId, name],
  )
  if (result.rows.length === 0) return null
  return rowToPrompt(result.rows[0])
}

export async function listPrompts(pool: Pool, indexId: number): Promise<RagPrompt[]> {
  const result = await pool.query(
    `SELECT * FROM rag_prompts WHERE index_id = $1 ORDER BY name`,
    [indexId],
  )
  return result.rows.map(rowToPrompt)
}

// Returns the updated row, or null when no row matches (index_id, name).
export async function updatePrompt(
  pool: Pool,
  indexId: number,
  name: string,
  content: PromptContent,
): Promise<RagPrompt | null> {
  const result = await pool.query(
    `UPDATE rag_prompts SET content = $1, updated_at = NOW()
     WHERE index_id = $2 AND name = $3
     RETURNING *`,
    [JSON.stringify(content), indexId, name],
  )
  if (result.rows.length === 0) return null
  return rowToPrompt(result.rows[0])
}

// Returns false when no row matches (index_id, name).
export async function deletePrompt(
  pool: Pool,
  indexId: number,
  name: string,
): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM rag_prompts WHERE index_id = $1 AND name = $2`,
    [indexId, name],
  )
  return (result.rowCount ?? 0) > 0
}
