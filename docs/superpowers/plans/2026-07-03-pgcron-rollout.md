# pg_cron Reconcile Rollout — Implementation Plan (Plan B, revised)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Most steps here are infrastructure/operational (action + explicit verification), not TDD — the one exception (migration v4) has a real portability test. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Get the incremental-BM25-stats feature (Plan A) live on dev, then enable the `reconcile_index_stats` nightly backstop via pg_cron **from code** — a CDK parameter group + a guarded SQL migration run by the app's existing master connection — so a freshly-spun-up environment gets pg_cron out of the box with no manual steps, and correct the live `phila-gov` index's stale DF as a side effect of the job's first run.

**Architecture:** pg_cron enablement is split by privilege domain so no credentials are ever handled out-of-band:
- **`shared_preload_libraries` + `cron.database_name`** are static RDS parameters → set on a **custom CDK parameter group** (AWS deploy-role IAM, *not* DB creds). A brand-new instance boots with pg_cron preloaded; only a pre-existing instance needs a one-time reboot to pick up a static parameter.
- **`CREATE EXTENSION pg_cron` + `cron.schedule(...)`** are SQL requiring `rds_superuser` → run inside a **normal versioned migration (v4)**. The app already connects as the RDS master (`postgres`), so the migration runner has the privilege for free. The migration is **guarded** on `shared_preload_libraries` actually containing `pg_cron`, so it is a clean no-op on the dockerized test DB / any environment without pg_cron.

The heavy one-time `phila-gov` DF recompute (>30 s, the exact operation whose old inline form 504'd) rides the pg_cron worker in-DB with no request-path ceiling — so this plan needs **no bastion and no bootstrap Lambda**.

**Tech Stack:** AWS CDK (`aws-cdk-lib/aws-rds`), RDS PostgreSQL 15 (`dev-pgsearch-database`), pg_cron, the `city` CLI (`phila-ctl`), AWS CLI (profile `OpenSearchDev`, account 224522205970, region us-east-1), node-postgres migrations (`apps/api/db/migrations.ts`), Vitest against dockerized Postgres (`pnpm dev:db`).

**Supersedes:** `docs/superpowers/plans/2026-06-30-incremental-bm25-stats-infra.md` (the original Plan B, which routed the reconcile through a to-be-built in-VPC execution path). This revision folds that execution path into the migration mechanism instead. The spec is unchanged: `docs/superpowers/specs/2026-06-30-incremental-bm25-stats-design.md`.

**Depends on:** Plan A merged to `main` (done, commits `06eb676`..`d0d710b`). Plan A is **not yet deployed** to dev — Task 1 deploys it.

---

## Pre-flight facts (verified from code; re-confirm where noted)

- **Instance:** `dev-pgsearch-database`, standalone `db.t3.micro`, engine `postgres` **15.17**, port **5433**, `PubliclyAccessible: false`, private subnets, currently on parameter group **`default.postgres15`** (`shared_preload_libraries = pg_stat_statements`). Default parameter groups are not modifiable; `pg_cron` is an allowed `shared_preload_libraries` value for this engine.
- **Migrations auto-apply on Lambda cold start.** `apps/api/index.ts` runs `runMigrations(pool)` in the `app.use('*', …)` middleware; `apps/api/db/migrate.ts` guards with a module-level `migrated` flag so it runs once per container. **There is no separate migrate command or Lambda** — deploying new code + one request applies pending migrations. Dev is at **migration v2** (v3 from Plan A is not deployed yet).
- **The app connects as the RDS master `postgres` (`rds_superuser`).** `@phila/constructs` 0.6.4 sets `dbUsername = 'postgres'`; `apps/api/db/pool.ts` connects with the secret's username via `DB_SECRET_ARN`. So `CREATE EXTENSION pg_cron` from a migration is permitted. Re-confirm by reading `apps/api/db/pool.ts` if anything looks off.
- **Deploy is from the local working tree.** `cdk/app.ts` uses `codeDir: '../apps/api/dist'`; `city deploy dev` (full CDK) and `city ship dev --lambda` (Lambda-only) both bundle local `apps/api/dist/`. **No git push is required to deploy.** Always `pnpm --filter api build` first.
- **Application database name = `pgsearch`** (no `databaseName` passed to `LambdaPostgresApi`). Re-confirm: `aws rds describe-db-instances --profile OpenSearchDev --region us-east-1 --db-instance-identifier dev-pgsearch-database --query 'DBInstances[0].DBName'`.
- **Reaching the RDS L1 for the parameter group:** `pgsearchApi.database` is a `PhilaPostgres`; `pgsearchApi.database.instance` is the `rds.DatabaseInstance` (provisioned; `.cluster` undefined for dev). Escape hatch: `pgsearchApi.database.instance!.node.defaultChild as rds.CfnDBInstance`. `@phila/constructs` is `^0.6.4`.
- **`phila-gov` stats are stale.** Bulk-loaded with refresh disabled (`config.refresh_threshold` set to 100000000 as a stopgap). After Task 1, migration v3 copies the stale matview DF into the new table and **backfills the running sums/averages from the real `search_documents`/`search_segments` columns** — so post-v3 the **averages are correct but the per-term DF is stale**. Incremental maintenance will not self-heal the DF of the ~15k already-indexed docs; only the pg_cron reconcile (Task 5) fixes it. Search works meanwhile; ranking is suboptimal.
- **AWS creds:** `aws sso login --profile OpenSearchDev` if the session is expired. AWS account/S3 for govsync is a *different* account (`philagov`, 676612114792) — see the `phila-aws-accounts` note.

---

## Task 0: Preconditions

- [ ] **Step 1: Confirm branch, build, and local DB**

`main` holds Plan A. Run from `~/pgsearch`:
```bash
git -C ~/pgsearch log --oneline -1        # expect d0d710b or later on main
pnpm --filter api exec vitest run 2>&1 | grep -E "Test Files|Tests "  # 23 files pass; only e2e (AWS) fails
pnpm dev:db                                # dockerized Postgres on :5433 for the v4 test in Task 4
```

- [ ] **Step 2: Confirm AWS access**

```bash
aws sts get-caller-identity --profile OpenSearchDev   # if this fails: aws sso login --profile OpenSearchDev
aws rds describe-db-instances --profile OpenSearchDev --region us-east-1 \
  --db-instance-identifier dev-pgsearch-database \
  --query 'DBInstances[0].{DBName:DBName,PG:DBParameterGroups,Status:DBInstanceStatus}'
```
Expected: `DBName = pgsearch`, parameter group `default.postgres15`, status `available`. This is the last read before any change.

> **Outward-action gate:** Tasks 1–5 mutate the live dev environment (deploys, an RDS reboot, DB writes). Confirm with Darren before the first `city` deploy and before the reboot.

---

## Task 1: Deploy Plan A to dev; verify incremental maintenance is live

This is independent of pg_cron and is the prerequisite for everything (and unblocks the govsync sweep, Task 6). No CDK change yet.

- [ ] **Step 1: Build and ship the Lambda**

```bash
pnpm --filter api build
AWS_PROFILE=OpenSearchDev city ship dev --lambda    # Lambda-only; no infra change
```
Expected: a new Lambda code bundle deploys.

- [ ] **Step 2: Trigger migration v3 and verify it applied**

Migrations run on the first request after the cold start. Issue any authenticated admin read to warm the container, then verify. Because there is no interactive SQL path, verify **through the API**:
- Confirm `phila-gov` is still readable and inspect its stats: `GET /private/key/admin/indexes/phila-gov` with the admin key (`x-api-key: $PGSEARCH_ADMIN_KEY`). This route returns the whole `search_indexes` row, so after v3 it exposes `total_documents`, `avg_title_length`, `avg_body_length`, and the new `total_title_length`/`total_body_length`/`total_segments` columns. **It does NOT expose the `term_document_frequencies` (DF) row count — no endpoint does.**
- Confirm the `/reconcile` route now exists (Plan A) by calling it on a **tiny** index (create a throwaway index, ingest 1 doc, `POST /private/key/admin/indexes/<throwaway>/reconcile`, expect `{status:'reconciled'}`), NOT on `phila-gov` (that would 504). Delete the throwaway index after.

> A deeper check — `schema_migrations` max version = 3, `term_document_frequencies` relkind = table, `reconcile_index_stats` exists — requires an in-VPC SQL path we deliberately don't have. The API checks above plus the presence of the new `total_*` columns in the admin-get response are the intended confirmation that v3 applied; `migrate.ts` also logs applied versions to CloudWatch Lambda logs if you need it.

- [ ] **Step 3: Verify incremental maintenance on a throwaway index**

Using the throwaway index from Step 2 (before deleting it): ingest a second doc that shares a term with the first, then `GET /private/key/admin/indexes/<throwaway>` and confirm `total_documents` and the `avg_*`/`total_*` columns reflect both docs; delete one doc and confirm they move back. This observes the length/average half of the Plan A invariant live through the API. (The DF half is covered by the local invariant test, not re-verifiable via API — no endpoint exposes DF counts.)

> No commit — operational. Record in the rollout log which index name was used and that it was cleaned up.

---

## Task 2: CDK custom parameter group enabling pg_cron

**Files:**
- Modify: `cdk/app.ts` (after the `LambdaPostgresApi` construction, near the existing WAF/Bedrock overrides)

- [ ] **Step 1: Add the parameter group and attach via the escape hatch**

```ts
import * as rds from 'aws-cdk-lib/aws-rds'

// pg_cron runs the BM25 reconcile in-DB (off the 30s request-path ceiling). It
// must be in shared_preload_libraries — a static parameter the default parameter
// group cannot carry — so attach a custom one. A brand-new instance boots with it
// preloaded; an existing instance needs a one-time reboot (Task 3).
const dbParams = new rds.ParameterGroup(stack, 'PgCronParameters', {
  engine: rds.DatabaseInstanceEngine.postgres({
    version: rds.PostgresEngineVersion.of('15.17', '15'),
  }),
  description: 'pgsearch: enable pg_cron alongside pg_stat_statements',
  parameters: {
    shared_preload_libraries: 'pg_stat_statements,pg_cron',
    'cron.database_name': 'pgsearch', // app DB, confirmed Task 0
  },
})

const cfnDb = pgsearchApi.database.instance!.node.defaultChild as rds.CfnDBInstance
cfnDb.dbParameterGroupName = dbParams.bindToInstance({}).parameterGroupName
```

> - `PostgresEngineVersion.of('15.17','15')` avoids depending on a named enum member. The parameter-group family is `postgres15`.
> - `bindToInstance({})` materializes the `CfnDBParameterGroup` and returns `{ parameterGroupName }`; assigning it to `cfnDb.dbParameterGroupName` re-points the existing instance at the new group **without replacing the instance**.
> - If cdk-nag flags the new resource, add a scoped suppression with justification, following the existing WAF/Bedrock suppression style in this file.

- [ ] **Step 2: Synthesize and verify it is an in-place parameter-group swap (NOT a replacement)**

```bash
cd cdk && AWS_PROFILE=OpenSearchDev npx cdk diff dev 2>&1 | grep -iE "DBParameterGroup|DBInstance|replace|Replacement|destroy"
```
Expected: a **new** `AWS::RDS::DBParameterGroup`, and the `AWS::RDS::DBInstance` shows a **modification of `DBParameterGroupName`** (a `[~]` line) — **not** a replacement/destroy (`[-]` then `[+]` on the DBInstance, or the word "replace"/"destroy"). **If it shows replacement, STOP** (a replacement destroys the database). Resolve before deploying.

- [ ] **Step 3: Commit**

```bash
git add cdk/app.ts
git commit -m "infra(pgsearch): custom parameter group enabling pg_cron"
```

- [ ] **Step 4: Deploy the parameter-group change (no reboot yet)**

```bash
pnpm --filter api build
AWS_PROFILE=OpenSearchDev city deploy dev
```
Expected: stack updates; the instance's `DBParameterGroups` now lists the custom group with `ParameterApplyStatus: pending-reboot`. The instance is still running the old preload — that's fine; v3 has no pg_cron dependency and the app keeps working. **Do NOT ship migration v4 yet** (it must run only after the reboot).

Verify:
```bash
aws rds describe-db-instances --profile OpenSearchDev --region us-east-1 \
  --db-instance-identifier dev-pgsearch-database \
  --query 'DBInstances[0].DBParameterGroups'
```
Expected: custom group present, `ParameterApplyStatus: pending-reboot`.

---

## Task 3: Reboot the existing instance to load pg_cron

Static parameters take effect only on reboot, and CloudFormation does not reboot for you. New environments skip this entirely (born preloaded); this is a one-time transition step for the existing dev instance.

- [ ] **Step 1: Reboot and wait for available**

```bash
aws rds reboot-db-instance --profile OpenSearchDev --region us-east-1 --db-instance-identifier dev-pgsearch-database
aws rds wait db-instance-available --profile OpenSearchDev --region us-east-1 --db-instance-identifier dev-pgsearch-database
```
Expected: brief dev DB unavailability (~1–3 min), then `available`.

- [ ] **Step 2: Verify the parameter group is in-sync (preload applied)**

```bash
aws rds describe-db-instances --profile OpenSearchDev --region us-east-1 \
  --db-instance-identifier dev-pgsearch-database \
  --query 'DBInstances[0].DBParameterGroups'
```
Expected: `ParameterApplyStatus: in-sync`. This is the AWS-side confirmation that `shared_preload_libraries` now includes `pg_cron`. (The definitive confirmation is Task 4 succeeding — `CREATE EXTENSION pg_cron` only works when preloaded.)

> No commit — operational.

---

## Task 4: Migration v4 — guarded `CREATE EXTENSION pg_cron` + schedule the reconcile job

**Files:**
- Modify: `apps/api/db/migrations.ts` (append version 4 after version 3)
- Test: `apps/api/test/migration-v4.test.ts` (create)

This migration MUST first run on the existing dev instance only **after** Task 3's reboot (guard skips it silently otherwise — see the ordering note). New environments are unaffected (born preloaded). Follow TDD for the portability behavior.

- [ ] **Step 1: Write the failing portability test**

The test runs against the dockerized Postgres (`:5433`), which has **no** pg_cron. It asserts v4 applies cleanly there and is a no-op (no extension created, no error) — proving the guard makes the migration portable to local/CI.

Create `apps/api/test/migration-v4.test.ts`:
```ts
// ABOUTME: Verifies migration v4 is a clean no-op where pg_cron is not preloaded
// ABOUTME: (the dockerized test DB), so the pg_cron migration stays portable.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getTestPool, setupSchema, teardownSchema, closePool } from './setup'
import type { Pool } from 'pg'

describe('migration v4 (pg_cron, guarded)', () => {
  let pool: Pool
  beforeAll(async () => { await setupSchema(); pool = await getTestPool() })
  afterAll(async () => { await teardownSchema(); await closePool() })

  it('records version 4 as applied', async () => {
    const r = await pool.query('SELECT MAX(version)::int AS v FROM schema_migrations')
    expect(r.rows[0].v).toBeGreaterThanOrEqual(4)
  })

  it('does not create the pg_cron extension where it is not preloaded', async () => {
    // Docker Postgres has no pg_cron in shared_preload_libraries, so the guard
    // must skip CREATE EXTENSION rather than error.
    const r = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'")
    expect(r.rows).toHaveLength(0)
  })

  it('applies without raising (setupSchema above would have thrown otherwise)', () => {
    expect(true).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter api exec vitest run test/migration-v4.test.ts`
Expected: FAIL on the version assertion (max version is 3; v4 not added yet).

- [ ] **Step 3: Append migration version 4**

In `apps/api/db/migrations.ts`, after the version 3 object:
```ts
  {
    version: 4,
    description: 'Enable pg_cron and schedule the nightly reconcile_index_stats job (guarded: no-op where pg_cron is not preloaded)',
    sql: `
-- Only act where pg_cron is actually preloaded (RDS with the custom parameter
-- group). On the dockerized test DB / any env without it, this is a clean no-op,
-- so the migration stays portable. Guarding on shared_preload_libraries (not
-- pg_available_extensions) means we never attempt CREATE EXTENSION before the
-- instance has been rebooted with the new parameter group.
DO $mig$
BEGIN
  IF current_setting('shared_preload_libraries') LIKE '%pg_cron%' THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    PERFORM cron.schedule(
      'reconcile-index-stats',
      '17 3 * * *',                                   -- 03:17 UTC daily; tune later
      $job$ SELECT reconcile_index_stats(index_id) FROM search_indexes $job$
    );
  END IF;
END
$mig$;
`,
  },
```

> Notes:
> - `cron.schedule` upserts by job name, so re-running is harmless.
> - Match the exact formatting/style of the version 1–3 entries (read them first).
> - **Why this is expected to work in `pgsearch`:** setting `cron.database_name = pgsearch` in the parameter group (Task 2) is precisely what lets modern RDS permit `CREATE EXTENSION pg_cron` in the `pgsearch` database (rather than pinning it to `postgres`). That param is a prerequisite for this migration, not just scheduler config.
> - **RDS live-verify risk + REQUIRED RECOVERY (this is a hard-failure path — do not skip):** if, despite `cron.database_name`, `CREATE EXTENSION pg_cron` errors when connected to `pgsearch`, the DO block throws → `pool.query(migration.sql)` throws → `runMigrations()` throws → the `migrated` flag stays `false` (set only on success in `migrate.ts`), so **every subsequent request re-runs the failing migration and 500s indefinitely** (not just cold starts; and `schema_migrations` never records v4). **Recovery, immediately:** remove the version-4 object from `migrations.ts`, `pnpm --filter api build`, and `AWS_PROFILE=OpenSearchDev city ship dev --lambda` to stop the 500s. THEN resolve the extension-location problem (fallback: create the extension in `postgres` and use `cron.schedule_in_database('reconcile-index-stats','17 3 * * *',$job$…$job$,'pgsearch')` — but that create cannot run from the `pgsearch` app connection, so it reopens the "no in-VPC path" problem for that one statement; escalate to Darren for a decision). Do not silently swallow the error, and do not leave v4 deployed while it fails.

- [ ] **Step 4: Run the test to verify it passes locally (guard skips cleanly)**

Run: `pnpm --filter api exec vitest run test/migration-v4.test.ts`
Expected: PASS (version 4 applied; no pg_cron extension locally; no error).

- [ ] **Step 5: Run the full stats suite for no regression**

Run: `pnpm --filter api exec vitest run test/migration-v3.test.ts test/reconcile.test.ts test/stats.test.ts test/ingest-stats.test.ts test/stats-invariant.test.ts test/migration-v4.test.ts`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/db/migrations.ts apps/api/test/migration-v4.test.ts
git commit -m "feat(stats): migration v4 — enable pg_cron + schedule nightly reconcile (guarded)"
```

- [ ] **Step 7: Ship to dev (only after Task 3 reboot is confirmed in-sync)**

```bash
pnpm --filter api build
AWS_PROFILE=OpenSearchDev city ship dev --lambda
```
Then warm the container with any authenticated request so the cold-start migration runs. On dev the guard is now true → `CREATE EXTENSION pg_cron` runs and the job is scheduled.

> **Ordering guard-rail:** if this is shipped/ran *before* the reboot, the guard is false, v4 is recorded as applied-but-skipped, and the extension is never created. Recovery is a follow-up migration v5 that repeats the same guarded block (it is idempotent). So: **confirm Task 3 Step 2 shows `in-sync` before this step.**

---

## Task 5: Verify pg_cron works and corrects `phila-gov`

The heavy `phila-gov` DF recompute runs inside the pg_cron worker (no request-path ceiling). Two verification paths: outcome (phila-gov stats corrected) and, if needed, pg_cron internals via CloudWatch.

- [ ] **Step 1: Snapshot `phila-gov` state and a ranking baseline**

`GET /private/key/admin/indexes/phila-gov` (admin key) and record `total_documents`, `avg_title_length`, `avg_body_length`. (These are already correct post-v3 — they backfill from real columns.) The **DF row count is not exposed by any endpoint**, so instead capture a **ranking baseline**: run 2–3 representative queries against `phila-gov` (`GET` the public search route with the search key) and save the top results/scores. The DF fix is observable as *changed ranking*, not as a readable number.

- [ ] **Step 2: Let the job's first run reconcile it**

The nightly job fires at **03:17 UTC**. Ad-hoc triggering would need one `cron.schedule('reconcile-soon', …)` statement, which requires an in-VPC SQL path we intentionally don't have — so **the default is to let the nightly run do it and verify the following morning.** ⚠️ Plan the rollout day accordingly: if you finish Task 4 at, say, 10:00 UTC, this verification cannot complete until ~03:17 UTC the next day (~17 h later). That wait is expected and is not a failure.

- [ ] **Step 3: Verify corrected state**

Re-run the Step 1 queries. Expected: the `phila-gov` search ranking has **shifted** versus the baseline (IDF now reflects the full ~15k-doc corpus rather than the stale snapshot), and results are sensible; `total_documents`/averages unchanged (they were already correct). Note: DF correction is **inferred** from the ranking change + the job having run — there is no API to read the DF row count directly.

- [ ] **Step 4: Confirm the job ran** (diagnostic, if outcome is unclear)

pg_cron writes to `cron.job_run_details`, readable only in-DB — so use **CloudWatch**: the RDS PostgreSQL logs record pg_cron worker activity, and the Lambda logs show nothing (the job doesn't touch the app). If the outcome in Step 3 is correct, `cron.job` is provably active; deeper inspection is only needed on failure.

- [ ] **Step 5: (Optional) Clean up `phila-gov` stopgap config**

`phila-gov`'s stored `config.refresh_threshold` (100000000) is now an ignored key (Plan A removed the field). No action needed for correctness; optionally strip it via the admin index-update endpoint for tidiness. Record the decision.

---

## Task 6: Re-run the govsync residual sweep

Depends only on Task 1 (Plan A deployed) — can run any time after it; placed last for narrative order. The ~476 pages that failed the initial load did so on the old inline-refresh stall, which Plan A removed.

- [ ] **Step 1: Re-run the sync**

From `~/Projects/govsync` (see the `phila-search-stats-refactor` note for exact command/config):
```bash
AWS_PROFILE=philagov npm run sync:local --workspace apps/sync
```
Expected: the previously-failing pages ingest successfully (no more 500s); the sync reports the residual now indexed.

- [ ] **Step 2: Verify the corpus is complete**

Confirm the `phila-gov` `total_documents` is at/near the full ~16,066 (was ~15,585). Any still-failing pages are a *new* issue to investigate, not the old refresh stall.

> govsync is a separate repo (local-only git, branch `wip/s3-sync-scheduler`) and a *different* AWS account (`philagov`). It is a client of pgsearch, not part of this deploy.

---

## Done criteria

- Plan A deployed to dev: `/reconcile` route live, incremental maintenance observed on a throwaway index (Task 1).
- `shared_preload_libraries` includes `pg_cron` (param group `in-sync` after reboot); migration v4 created the extension and scheduled `reconcile-index-stats`. Job execution is confirmed via CloudWatch RDS logs; DF correction is **inferred** from an observed `phila-gov` ranking shift on the job's first run (no API exposes the DF row count directly).
- `phila-gov` averages already correct (post-v3); ranking sensible after the reconcile.
- **No instance replacement** occurred during the parameter-group change (verified at Task 2 Step 2).
- The reconcile never runs on the 30 s request path for a large corpus.
- govsync residual swept; `phila-gov` corpus ~complete.
- **Reproducibility:** a freshly-spun-up environment gets pg_cron with zero manual steps — the CDK parameter group preloads it and migration v4 (guarded) creates the extension + job on first cold start. The only non-code act in this whole plan is the one-time reboot of the *pre-existing* dev instance.

## Future work

- `bd` issue **squash migrations to a clean baseline** once dev is confirmed at ≥ v4 (single-instance precondition) — also drops `docs_changed_since_refresh`. (Relates to existing `pgsearch-nze`.)
- Tune the cron interval from observed `reconcile_index_stats` durations.
- If ad-hoc (non-nightly) reconciles become a common need, revisit adding a minimal read-only `GET …/admin/pgcron-status` route and/or an on-demand trigger — deferred here as YAGNI.
- Apply the same parameter-group + v4 pattern to **prod** when Plan A reaches prod (prod is multi-AZ — the reboot is a failover; schedule accordingly).
