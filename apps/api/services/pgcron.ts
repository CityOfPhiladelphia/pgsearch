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

export interface PgCronRun {
  jobname: string
  status: string
  return_message: string | null
  start_time: string | null
  end_time: string | null
}

export interface PgCronStatus {
  shared_preload_libraries: string
  pg_cron_installed: boolean
  jobs: PgCronJob[]
  recent_runs: PgCronRun[]
}

export async function pgCronStatus(pool: Pool): Promise<PgCronStatus> {
  const spl = await pool.query("SELECT current_setting('shared_preload_libraries') AS spl")
  const ext = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'")
  const installed = ext.rows.length > 0

  // cron.job / cron.job_run_details only exist once the extension is created,
  // so guard the reads.
  let jobs: PgCronJob[] = []
  let recentRuns: PgCronRun[] = []
  if (installed) {
    const j = await pool.query(
      'SELECT jobname, schedule, active, database, command FROM cron.job ORDER BY jobname',
    )
    jobs = j.rows
    const r = await pool.query(
      `SELECT j.jobname, d.status, d.return_message, d.start_time, d.end_time
       FROM cron.job_run_details d
       JOIN cron.job j ON j.jobid = d.jobid
       ORDER BY d.start_time DESC
       LIMIT 10`,
    )
    recentRuns = r.rows
  }

  return {
    shared_preload_libraries: spl.rows[0].spl,
    pg_cron_installed: installed,
    jobs,
    recent_runs: recentRuns,
  }
}
