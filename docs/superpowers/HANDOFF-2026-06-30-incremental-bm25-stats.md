# Handoff — phila.gov search: govsync load + pgsearch incremental BM25 stats

**Date:** 2026-06-30
**Purpose:** Resume cold in a fresh session. Two linked workstreams: a completed govsync sync feature, and a fully-planned-but-unimplemented pgsearch stats refactor.

---

## TL;DR — what to do next

1. **Implement pgsearch Plan A** (the core feature) subagent-driven, task by task. Plan: `docs/superpowers/plans/2026-06-30-incremental-bm25-stats-core.md`.
2. **Then Plan B** (pg_cron infra + rollout + one-time `phila-gov` reconcile): `docs/superpowers/plans/2026-06-30-incremental-bm25-stats-infra.md`. A and B should reach dev together.
3. **Then re-run the govsync sync once** to sweep the ~476 pages that failed during the initial load (they failed on the inline-refresh stall, which this feature removes).

Spec for both: `docs/superpowers/specs/2026-06-30-incremental-bm25-stats-design.md`.

**Start-of-build prerequisites:** `pnpm dev:db` (dockerized Postgres :5433) running; create branch `feat/incremental-bm25-stats` off `main`.

---

## The two repos

### govsync (`~/Projects/govsync`) — COMPLETE, working
A scheduled Lambda that syncs phila.gov scraped HTML (S3) into the pgsearch `phila-gov` index. **This is one client of pgsearch; the two services are not coupled.**

- **Local-only git repo** (no remote). On branch **`wip/s3-sync-scheduler`** (not merged to `main`); the feature is done and ran successfully. Ready to merge at Darren's discretion.
- What it does: EventBridge Scheduler (every 2h, 6am–6pm America/New_York) → Lambda → reconcile CMS page list vs S3 ETags vs index state → upsert/delete via the pgsearch documents API. Idempotent/self-healing; bounded concurrency (default 6); HTML→markdown via a vendored fork of `@phila/search-parse` under `packages/`.
- Built with `@phila/constructs` (LambdaApi was swapped for a bare `PhilaLambda`; 900s timeout). 109 tests passing; clean `cdk synth` (0 nag errors).
- **Config lives in `cdk/.env.local`** (gitignored) with the LIVE values: `SOURCE_BUCKET=prod-phila-gov-website-s3`, `PGSEARCH_API_BASE`, `PGSEARCH_INDEX_KEY` (the minted phila-gov index key), `PAGES_URL` (internal ELB), `INDEX_NAME=phila-gov`.
- **First full load done: ~15,585 / 16,066 pages indexed.** Run locally via `AWS_PROFILE=philagov npm run sync:local --workspace apps/sync` (or `node apps/sync/scripts/run-local.js`). Diagnostic scripts: `apps/sync/scripts/diag.ts` (real-content re-ingest timing), `apps/sync/scripts/dumpbody.ts` (dump a parsed body).
- **Residual: ~476 pages unindexed** (the HTTP 500s) — root-caused as the pgsearch inline-refresh stall, NOT a govsync bug. They sweep up on the next run once pgsearch Plan A/B ship.

### pgsearch (`~/pgsearch`) — stats refactor PLANNED, not implemented
The search service. Multi-index; `phila-gov` is one index.

- On `main`. **4 unpushed commits** (spec + both plans + a spec refinement) — push them so the fresh session has them. Earlier commits (WAF rate limit, refresh_threshold default) are already pushed.
- **Plans A & B + spec are written and review-passed** (see paths above). Nothing in `apps/api` or `cdk` has been changed for this feature yet.

---

## What is currently DEPLOYED to pgsearch dev (account 224522205970)

- **WAF `RateLimitRule` raised 1000 → 10000 / 5min** (deployed; committed+pushed). This unblocked the govsync bulk load.
- **`refresh_threshold` default 100 → 1000** is committed+pushed to `main` but **NOT deployed**, and is **superseded** by Plan A (which removes `refresh_threshold` entirely). Don't bother deploying it on its own.
- **Index `phila-gov` exists** with a **Bedrock** embedding config (`amazon.titan-embed-text-v2:0`, 1024-dim) — the default `local` provider does NOT work on the deployed Lambda (that was a live discovery). It holds **~15.5k docs** but its **BM25 stats are STALE**: inline refresh was disabled and its `config.refresh_threshold` set to **100000000** as a stopgap, because the refresh exceeds the 30s Lambda timeout. **Plan B Task 4 corrects this** via an in-DB reconcile. Search works meanwhile; ranking is just suboptimal.

---

## Access / credentials

- **govsync / S3 / phila account:** `AWS_PROFILE=philagov` (account **676612114792**). Holds `prod-phila-gov-website-s3`. SSO; re-login with `aws sso login --profile philagov` if expired.
- **pgsearch RDS / its account:** `AWS_PROFILE=OpenSearchDev` (account **224522205970**). The dev DB is `dev-pgsearch-database` (RDS Postgres 15.17). pgsearch deploys via `city deploy dev`.
- **pgsearch API + admin/index keys:** `~/pgsearch/.env.local` (gitignored) — `PGSEARCH_API_BASE` (`https://3qkikancml.execute-api.us-east-1.amazonaws.com/dev/`), `PGSEARCH_ADMIN_KEY` (the API-Gateway `x-api-key` for `/private/key/admin/*`), and index/search keys. The govsync `cdk/.env.local` separately holds the minted `phila-gov` index key.
- Admin index ops pattern (used repeatedly): `curl -H "x-api-key: $PGSEARCH_ADMIN_KEY" $PGSEARCH_API_BASE/private/key/admin/indexes[...]`.

---

## Key decisions & gotchas (the non-obvious context)

- **The whole stats refactor exists because** BM25 corpus-stat recompute (`refreshIndex`'s global `REFRESH MATERIALIZED VIEW CONCURRENTLY term_document_frequencies` + AVG queries) runs **inline on the ingest request** every `refresh_threshold` docs, scales with total corpus, and **exceeds the 30s Lambda/API-GW timeout at ~16k docs** → 504s. Proven: a doc took 29,352ms→504 with refresh on, 689ms→200 with it off.
- **Mechanism decision:** hot-path maintenance is **app-level (TypeScript) in the ingest/delete transaction**, not DB triggers (distinct-document term-set needs whole-doc context; single writer; testable). **Reconcile is a SQL function** (`reconcile_index_stats`) because it must run in-DB to escape the 30s ceiling, scheduled by **pg_cron**.
- **pg_cron is supported on the instance but NOT enabled** (it's on `default.postgres15` with `shared_preload_libraries=pg_stat_statements`; default param groups can't be modified). Plan B enables it via a custom param group + reboot. The app connects as master `postgres`/`rds_superuser`, so `CREATE EXTENSION pg_cron` is permitted. App DB name = `pgsearch`.
- **The heavy reconcile must never run through API Gateway** (30s cap) — Plan B pins it to `aws lambda invoke`/bastion (`run_sql_heavy`).
- **Migration is append-only v3** (matview→table, sum columns, reconcile fn). It **keeps `docs_changed_since_refresh`** (dropping it would roll back in-flight old-code ingests). Averages use `COALESCE(..., 0)` (the columns are `FLOAT NOT NULL`; a found-in-review latent bug).
- **Follow-up (file a `bd` issue):** squash migrations to a clean baseline once dev is at ≥v3 (single dev instance, so the only precondition is v3 applied) — that's where `docs_changed_since_refresh` finally drops.
- **`apps/api/scripts/ingest-311-kb.ts:251`** calls the `/refresh` endpoint → 404s after Plan A renames it to `/reconcile` (Plan A Task 8 updates it).

---

## Execution approach (already chosen)

**Subagent-driven** (superpowers:subagent-driven-development): fresh subagent per task, review between tasks. Start with Plan A Task 1 (migration v3). Plan B's tasks are provision+verify (not TDD) and end with a `city deploy dev` + DB-mutating reconcile — treat with care.

## Definition of done (whole effort)

- Plan A: `pnpm --filter api test` green incl. the reconcile-equivalence invariant; no `refreshIndex`/`checkAndRefresh`/`refresh_threshold` left; build clean.
- Plan B: pg_cron enabled + `reconcile-index-stats` cron job active + a successful run in `cron.job_run_details`; `phila-gov` DF/averages corrected; no RDS instance replacement during the param-group change.
- govsync: a final re-run indexes the residual ~476 pages.
