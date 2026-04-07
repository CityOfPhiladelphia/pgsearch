// ABOUTME: Database migration runner for Lambda cold start.
// ABOUTME: Applies pending schema migrations and tracks applied versions.

import type { Pool } from 'pg'
import { migrations } from './migrations'

let migrated = false

export async function runMigrations(pool: Pool): Promise<void> {
  if (migrated) return

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  const { rows: applied } = await pool.query(
    'SELECT version FROM schema_migrations ORDER BY version'
  )
  const appliedVersions = new Set(applied.map(r => r.version))

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue

    if (process.env.NODE_ENV !== 'test') {
      console.log(`Applying migration ${migration.version}: ${migration.description}`)
    }
    await pool.query(migration.sql)
    await pool.query(
      'INSERT INTO schema_migrations (version, description) VALUES ($1, $2)',
      [migration.version, migration.description]
    )
  }

  migrated = true
}

export function resetMigrationState(): void {
  migrated = false
}
