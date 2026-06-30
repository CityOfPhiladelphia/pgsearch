// ABOUTME: Thin wrapper over the in-database reconcile_index_stats function.
// ABOUTME: Recomputes DF + average lengths from source for one index (drift backstop).
import type { Pool } from 'pg'

export async function reconcileIndex(pool: Pool, indexId: number): Promise<void> {
  await pool.query('SELECT reconcile_index_stats($1)', [indexId])
}
