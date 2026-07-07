// ABOUTME: Read-only diagnostics for pg_cron enablement and the scheduled reconcile job.
// ABOUTME: Reports shared_preload_libraries, whether the extension exists, and cron.job rows.
import type { Pool } from 'pg'

export interface PgCronJob {
  jobname: string
  schedule: string
  active: boolean
  database: string
  command: string
}

export interface PgCronStatus {
  shared_preload_libraries: string
  pg_cron_installed: boolean
  jobs: PgCronJob[]
}

export async function pgCronStatus(pool: Pool): Promise<PgCronStatus> {
  const spl = await pool.query("SELECT current_setting('shared_preload_libraries') AS spl")
  const ext = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'")
  const installed = ext.rows.length > 0

  // cron.job only exists once the extension is created, so guard the read.
  let jobs: PgCronJob[] = []
  if (installed) {
    const j = await pool.query(
      'SELECT jobname, schedule, active, database, command FROM cron.job ORDER BY jobname',
    )
    jobs = j.rows
  }

  return {
    shared_preload_libraries: spl.rows[0].spl,
    pg_cron_installed: installed,
    jobs,
  }
}
