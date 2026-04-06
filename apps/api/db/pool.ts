// ABOUTME: Database connection pool configuration.
// ABOUTME: Provides a connection pool with pgvector type support registered.

import { Pool } from 'pg'
import { registerType } from 'pgvector/pg'

let pool: Pool | null = null

export async function getPool(): Promise<Pool> {
  if (!pool) {
    // In Lambda, @phila/db-postgres resolves DB_SECRET_ARN and DB_NAME
    // from environment variables. For local/test, explicit env vars are used.
    const { getPool: getPhilaPool } = await import('@phila/db-postgres')
    pool = await getPhilaPool()
    // Register pgvector type handler so VECTOR columns deserialize correctly
    const client = await pool.connect()
    await registerType(client)
    client.release()
  }
  return pool
}
