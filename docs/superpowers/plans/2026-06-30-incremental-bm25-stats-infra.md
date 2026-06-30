# Incremental BM25 Stats — Infra & Rollout Implementation Plan (Plan B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. These are infrastructure/operational tasks (provision + verify), not TDD — each step pairs an action with an explicit verification command.

**Goal:** Enable pg_cron on the pgsearch RDS instance and schedule the reconcile function in-DB, then deploy the incremental-stats feature (Plan A) and correct the live `phila-gov` index's stale statistics.

**Architecture:** Reconcile (`reconcile_index_stats`, built in Plan A) is a SQL function that must run in-database to escape the 30 s Lambda ceiling. pg_cron runs it on a schedule with no external timeout. Enabling pg_cron requires a custom RDS parameter group (`shared_preload_libraries` includes `pg_cron`) + a reboot. All of this is in the **pgsearch stack** — independent of any search client (e.g. govsync).

**Tech Stack:** AWS CDK (`aws-cdk-lib/aws-rds`), RDS PostgreSQL 15, pg_cron, the `city` CLI for deploy, AWS CLI (profile `OpenSearchDev`, account 224522205970, region us-east-1).

**Depends on:** Plan A merged and deployed (the `reconcile_index_stats` function and the table form of `term_document_frequencies` must exist). Plan A and Plan B should reach production together, because `phila-gov` stats stay stale until Task 4 runs.

**Spec:** `docs/superpowers/specs/2026-06-30-incremental-bm25-stats-design.md`

---

## Pre-flight facts (verified)

- Instance: `dev-pgsearch-database`, engine `postgres` **15.17**, currently on parameter group **`default.postgres15`** with `shared_preload_libraries = pg_stat_statements`. Default parameter groups are not modifiable.
- `pg_cron` is an allowed `shared_preload_libraries` value for this engine (verified via `describe-db-parameters` AllowedValues).
- CDK reach to the instance: `pgsearchApi.database` is a `PhilaPostgres`; `pgsearchApi.database.instance` is the `rds.DatabaseInstance` (provisioned; `cluster` is undefined for dev). Escape hatch: `pgsearchApi.database.instance!.node.defaultChild as rds.CfnDBInstance`.
- `@phila/constructs` here is **0.6.4** (older than govsync's). `LambdaPostgresApi` exposes `.database`, `.api`, `.lambda`.

---

## Task 0: Confirm facts and choose the execution paths (discovery)

Two facts below were already verified from the code during plan review — re-confirm quickly, then make the one real decision (the SQL execution path), which is split by **how heavy** the SQL is.

- [ ] **F1 — Application database name = `pgsearch`** (CONFIRMED). No `databaseName` is passed to `LambdaPostgresApi` in `cdk/app.ts`, so `PhilaPostgres` uses its default `appName.replace(/-/g,'_')` = `pgsearch`. Re-confirm: `aws rds describe-db-instances --profile OpenSearchDev --region us-east-1 --db-instance-identifier dev-pgsearch-database --query 'DBInstances[0].DBName'`. Use `<APP_DB>` = `pgsearch` below.

- [ ] **F2 — The app connects as the RDS master `postgres` (`rds_superuser`)** (CONFIRMED). `@phila/constructs` 0.6.4 sets `dbUsername = 'postgres'` and `apps/api/db/pool.ts` connects with the secret's `username`. So `CREATE EXTENSION pg_cron` is permitted. Re-confirm by reading `apps/api/db/pool.ts` + the secret if anything looks different.

- [ ] **D1 — Choose the execution path(s), by SQL weight.** All privileged SQL runs in-VPC as the master user; there is no laptop→DB path. Critically, the heavy SQL must **never** run through API Gateway (its 30 s ceiling is the exact bug this whole feature removes).

  - **Fast bootstrap SQL** (`CREATE EXTENSION pg_cron`, `cron.schedule`, small verifies) — sub-second. Any in-VPC path is fine, including (c) a one-shot **API-Lambda admin route** (permitted because of F2).
  - **Heavy reconcile** (`reconcile_index_stats` over `phila-gov` / all indexes — the O(corpus) recompute) — **must bypass the API-Gateway 30 s ceiling.** Use either:
    - (a) a **dedicated in-VPC bootstrap/reconcile Lambda** (timeout up to 15 min) invoked with `aws lambda invoke` — this hits the Lambda directly, not API Gateway, so no 30 s cap; **preferred**; or
    - (b) **bastion / SSM session** → `psql` with the master credentials (unbounded).
    Option (c) via API Gateway is **NOT** acceptable for the heavy reconcile — it will 504.

  Record the concrete mechanism chosen for each weight. Below, **`run_sql_fast`** = the fast path and **`run_sql_heavy`** = the no-ceiling path; they may be the same mechanism (e.g. one bootstrap Lambda does both), as long as the heavy one is not behind API Gateway.

> Do not proceed past Task 2 until D1 is decided. F1/F2 are confirmed; just re-verify.

---

## Task 1: CDK — custom parameter group enabling pg_cron

**Files:**
- Modify: `cdk/app.ts` (add after the `LambdaPostgresApi` construction, near the WAF/Bedrock overrides)

- [ ] **Step 1: Add the parameter group + attach via escape hatch**

```ts
import * as rds from 'aws-cdk-lib/aws-rds'

// pg_cron runs the BM25 reconcile in-DB (off the 30s Lambda ceiling). It must be
// in shared_preload_libraries (a static parameter), which the default parameter
// group cannot carry — so attach a custom one. Requires a reboot (Task 2).
const dbParams = new rds.ParameterGroup(stack, 'PgCronParameters', {
  engine: rds.DatabaseInstanceEngine.postgres({
    version: rds.PostgresEngineVersion.of('15.17', '15'),
  }),
  description: 'pgsearch: enable pg_cron alongside pg_stat_statements',
  parameters: {
    shared_preload_libraries: 'pg_stat_statements,pg_cron',
    'cron.database_name': 'pgsearch', // <APP_DB>, confirmed Task 0 F1
  },
})

const cfnDb = pgsearchApi.database.instance!.node.defaultChild as rds.CfnDBInstance
cfnDb.dbParameterGroupName = dbParams.bindToInstance({}).parameterGroupName
```

> Notes for the implementer:
> - `PostgresEngineVersion.of('15.17','15')` avoids depending on a named enum member existing in this CDK version. The parameter-group *family* is `postgres15`.
> - `bindToInstance({})` forces the L2 to materialize its `CfnDBParameterGroup` and returns `{ parameterGroupName }`; assigning it to `cfnDb.dbParameterGroupName` re-points the existing instance at the new group without replacing the instance.
> - If cdk-nag flags anything on the new resource, add a scoped suppression with justification (follow the existing WAF/Bedrock suppression style in this file).

- [ ] **Step 2: Synthesize and verify the change is an in-place parameter-group swap (no instance replacement)**

Run: `AWS_PROFILE=OpenSearchDev city validate dev` then inspect the diff:
`cd cdk && AWS_PROFILE=OpenSearchDev npx cdk diff dev 2>&1 | grep -iE "DBParameterGroup|DBInstance|replace"`
Expected: a new `AWS::RDS::DBParameterGroup`, and the `AWS::RDS::DBInstance` shows a **modification** of `DBParameterGroupName` — **not** a replacement. If it shows replacement, stop and resolve (a replacement would destroy the database).

- [ ] **Step 3: Commit**

```bash
git add cdk/app.ts
git commit -m "infra(pgsearch): custom parameter group enabling pg_cron"
```

---

## Task 2: Deploy + reboot, verify pg_cron is loaded

- [ ] **Step 1: Deploy**

Run: `AWS_PROFILE=OpenSearchDev city deploy dev`
Expected: stack updates; the DB parameter group association changes.

- [ ] **Step 2: Reboot the instance** (static parameter requires it; CFN does not reboot automatically)

Run: `aws rds reboot-db-instance --profile OpenSearchDev --region us-east-1 --db-instance-identifier dev-pgsearch-database`
Then wait for `available`:
`aws rds wait db-instance-available --profile OpenSearchDev --region us-east-1 --db-instance-identifier dev-pgsearch-database`

- [ ] **Step 3: Verify the parameter group is in sync and pg_cron is preloaded**

Run: `aws rds describe-db-instances --profile OpenSearchDev --region us-east-1 --db-instance-identifier dev-pgsearch-database --query 'DBInstances[0].DBParameterGroups'`
Expected: the custom group, `ParameterApplyStatus: in-sync`.
Then via `run_sql_fast` (Task 0 D1): `SHOW shared_preload_libraries;`
Expected: includes `pg_cron`.

> No commit — this task is operational.

---

## Task 3: Create the extension and schedule the reconcile job

All SQL here is fast bootstrap SQL — run it via `run_sql_fast` (Task 0 D1), as the master `postgres`/`rds_superuser`.

- [ ] **Step 1: Create the extension** (idempotent)

```sql
CREATE EXTENSION IF NOT EXISTS pg_cron;
```
Verify: `SELECT extname FROM pg_extension WHERE extname = 'pg_cron';` → one row.

- [ ] **Step 2: Schedule the reconcile job for all indexes**

Because `cron.database_name = pgsearch` (Task 1), the extension lives in `pgsearch` and a plain `cron.schedule` runs the command there. One job recomputes every index nightly:

```sql
SELECT cron.schedule(
  'reconcile-index-stats',
  '17 3 * * *',                                   -- 03:17 daily; tune later
  $$ SELECT reconcile_index_stats(index_id) FROM search_indexes $$
);
```
(`cron.schedule` upserts by job name, so re-running is safe.)

> If RDS pins `cron.database_name` to `postgres` (it sometimes does), create the extension in `postgres` and use `cron.schedule_in_database('reconcile-index-stats', '17 3 * * *', $$...$$, 'pgsearch')` instead. Record which form was used.

- [ ] **Step 3: Verify the job is registered**

```sql
SELECT jobid, schedule, command, database, active FROM cron.job WHERE jobname = 'reconcile-index-stats';
```
Expected: one active row targeting `pgsearch`.

- [ ] **Step 4: Prove the pg_cron path runs end-to-end** (don't wait for 03:17, and don't run the heavy recompute through a request path)

Schedule a **near-future one-off tick** so the actual pg_cron worker executes the command in-DB (this is the path that has no timeout — the right thing to smoke-test). For example schedule it for the next minute, let it fire, then verify and unschedule:

```sql
-- run via run_sql_fast; pick a minute ~2 minutes ahead (UTC) for the cron expression
SELECT cron.schedule('reconcile-smoke', '<MIN> <HOUR> * * *',
  $$ SELECT reconcile_index_stats(index_id) FROM search_indexes $$);
```
After it fires:
```sql
SELECT status, return_message, end_time FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'reconcile-smoke')
ORDER BY end_time DESC LIMIT 1;
SELECT cron.unschedule('reconcile-smoke');
```
Expected: one `succeeded` run. This proves pg_cron executes the heavy recompute in-DB without a timeout — do **not** smoke-test by calling reconcile through the API endpoint (it would 504 on `phila-gov`).

---

## Task 4: One-time reconcile of the live `phila-gov` index

`phila-gov` was bulk-loaded with refresh disabled; its DF + averages are stale. Its ~15k-doc recompute exceeds 30 s, so **Step 2 must run via `run_sql_heavy`** (the no-API-Gateway path from Task 0 D1). Steps 1 and 3 are fast reads (`run_sql_fast`).

- [ ] **Step 1: Snapshot the stale state** (for before/after evidence), via `run_sql_fast`:

```sql
SELECT total_documents, avg_title_length, avg_body_length,
       (SELECT COUNT(*) FROM term_document_frequencies t
        WHERE t.index_id = si.index_id) AS df_rows
FROM search_indexes si WHERE name = 'phila-gov';
```

- [ ] **Step 2: Run the reconcile** via `run_sql_heavy` (NOT the API endpoint — it would 504)

```sql
SELECT reconcile_index_stats(index_id) FROM search_indexes WHERE name = 'phila-gov';
```
Expected: completes (seconds–low minutes; no timeout because it runs in-DB off any request-path ceiling).

- [ ] **Step 3: Verify corrected state**

Re-run the Step 1 query. Expected: `avg_title_length`/`avg_body_length` > 0 and consistent with ~15k docs; `df_rows` is now a large positive number (was ~0/stale).

- [ ] **Step 4: Restore normal refresh cadence config** (it was set to 100M during the bulk load)

`phila-gov`'s `config.refresh_threshold` was set to 100000000 as a stopgap. Plan A removes `refresh_threshold` from `DEFAULT_CONFIG`/`IndexConfig`, but the existing row's JSON still contains it (ignored by code). No action required for correctness; optionally clean it from the stored config for tidiness via the admin PATCH. Record the decision.

---

## Task 5: End-to-end verification

- [ ] **Step 1: Search uses correct stats**

Issue a representative query against `phila-gov` (`GET /public/search/phila-gov?...` with the search key) and confirm results rank sensibly (IDF/length-norm now populated). Compare a term-heavy query before/after if a baseline was captured.

- [ ] **Step 2: Incremental maintenance holds in production**

Ingest one document via the API and delete it; confirm via `run_sql_fast` that `term_document_frequencies` and the `total_*`/`avg_*` columns move by the expected deltas and return to baseline after the delete (the Plan A invariant, observed live).

- [ ] **Step 3: Confirm the scheduled job remains active**

`SELECT active FROM cron.job WHERE jobname = 'reconcile-index-stats';` → `t`.

---

## Done criteria

- `shared_preload_libraries` includes `pg_cron`; `cron.job` has an active `reconcile-index-stats` job; `cron.job_run_details` shows a successful run.
- `phila-gov` DF + averages corrected (large `df_rows`, non-zero averages); search ranks correctly.
- No instance replacement occurred during the parameter-group change (verified at Task 1 Step 2).
- Reconcile never runs on the 30 s API Lambda for a large corpus.

## Future work

- `bd` issue: **squash migrations to a clean baseline** once dev is confirmed at ≥ v3 (single-instance precondition; see spec Future Work) — also drops `docs_changed_since_refresh`.
- Tune the cron interval from observed `reconcile_index_stats` durations.
