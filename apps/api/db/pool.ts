// ABOUTME: Database connection pool configuration.
// ABOUTME: Provides a connection pool with pgvector type support registered after migrations.

import { Pool } from 'pg'
import { registerType } from 'pgvector/pg'

let pool: Pool | null = null
let vectorRegistered = false

export async function getPool(): Promise<Pool> {
  if (!pool) {
    const { getPool: getPhilaPool } = await import('@phila/db-postgres')
    pool = await getPhilaPool()
  }
  return pool
}

export async function registerVectorType(): Promise<void> {
  if (vectorRegistered) return
  const p = await getPool()
  const client = await p.connect()
  await registerType(client)
  client.release()
  vectorRegistered = true
}
