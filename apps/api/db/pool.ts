// ABOUTME: Database connection pool configuration.
// ABOUTME: Provides a connection pool with pgvector type support registered after migrations.

import { Pool } from 'pg'
import { registerType } from 'pgvector/pg'

let pool: Pool | null = null
let vectorRegistered = false

export async function getPool(): Promise<Pool> {
  if (!pool) {
    if (process.env.DB_SECRET_ARN) {
      const { getPool: getPhilaPool } = await import('@phila/db-postgres')
      pool = await getPhilaPool()
    } else {
      pool = new Pool({
        host:     process.env.DB_HOST,
        port:     Number(process.env.DB_PORT),
        database: process.env.DB_NAME,
        user:     process.env.DB_USER,
        password: process.env.DB_PASSWORD,
      })
    }
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
