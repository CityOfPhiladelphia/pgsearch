# Incremental BM25 statistic maintenance

## Problem

BM25 scoring needs two corpus statistics per index:

- **Document frequency** per term — `term_document_frequencies(index_id, term, document_frequency)`, consumed by `search.ts` for IDF.
- **Average field lengths** — `search_indexes.avg_title_length` / `avg_body_length`, consumed by `search.ts` for length normalization.

Today both are recomputed in bulk by `refreshIndex`:

- A **global** `REFRESH MATERIALIZED VIEW CONCURRENTLY term_document_frequencies` whose cost scales with the total term volume across *all* indexes (it `unnest`s every lexeme of every segment + title and `GROUP BY index_id, term`).
- `AVG()` queries for the two lengths.

`checkAndRefresh` fires this **inline on the ingest request** every `refresh_threshold` documents. The matview refresh runs synchronously inside the request and **exceeds the 30s Lambda / API Gateway timeout** once a corpus reaches ~16k docs, producing 504s during bulk ingest. Both the inline path and the admin refresh endpoint are Lambda-bound (30s), so neither can refresh a large corpus. This is a scaling timebomb.

## Goal

Eliminate bulk refresh. Maintain document frequency and average lengths **incrementally and transactionally** on ingest and delete, scoped to the affected index, with a low-frequency **reconcile** job as a drift backstop.

## Decisions (settled in brainstorming)

- **App-level maintenance on the hot path** — the per-document DF/stat deltas live in application (TypeScript) code inside the existing ingest/delete transaction, not DB triggers. The distinct-document term-set needs whole-document context (natural in app code, awkward per-row in triggers); the API is the only writer, so triggers' multi-writer advantage barely applies; and the per-document delta logic is testable in TypeScript. The one trigger advantage that matters — index-deletion cascade — is closed by a cascade FK instead.
- **Retire refresh entirely**: maintain both DF *and* average lengths; drop the matview, `refreshIndex`, and `checkAndRefresh`.
- **Reconcile is a SQL function (cold path)** — the whole-index recompute is set-based work that runs rarely and off the request path, so it lives in the database as a SQL/PL-pgSQL function (`reconcile_index_stats(index_id)`). The admin endpoint is a thin wrapper over it, and the scheduler (pg_cron, or EventBridge → endpoint as fallback) calls it directly. This is deliberately *not* the hot-path code: it's the drift backstop, and SQL is the right tool for a recompute-from-source. Any drift (out-of-band SQL, a delta bug) self-heals on the next reconcile — which is what makes the hot-path app-level maintenance safe without triggers.

## The DF unit

A term's `document_frequency` for an index = the number of documents whose **term set** contains it. A document's term set = the distinct lexemes in `title_tsvector` ∪ every segment's `body_tsvector`, deduped across segments. (The segment `content_hash` dedup in ingest is irrelevant here: DF counts distinct documents per term, not term occurrences.) Deltas are derived from the **stored tsvectors**, guaranteeing the lexemes match exactly what search matches against.

## Schema changes (migration v3)

- `term_document_frequencies`: **materialized view → table**
  `(index_id INT REFERENCES search_indexes(index_id) ON DELETE CASCADE, term TEXT, document_frequency INT NOT NULL, PRIMARY KEY (index_id, term))`.
  The PK replaces today's unique index; the cascade FK makes index deletion clean (DF rows vanish with the index — no app or trigger logic).
- `search_indexes`: add running sums so averages are maintained, not recomputed:
  `total_title_length BIGINT NOT NULL DEFAULT 0`, `total_body_length BIGINT NOT NULL DEFAULT 0`, `total_segments BIGINT NOT NULL DEFAULT 0`.
  `avg_title_length` / `avg_body_length` columns are **kept** and recomputed from the sums in the same write, so `search.ts` is unchanged. Use **float division** to match today's `AVG()` (Postgres truncates BIGINT/INTEGER):
  `avg_title_length = total_title_length::float / NULLIF(total_documents, 0)`, `avg_body_length = total_body_length::float / NULLIF(total_segments, 0)`.
- `docs_changed_since_refresh` becomes unused (only `checkAndRefresh` read it), but is **not dropped in v3** — see Deploy ordering. Its drop is deferred to the squash.

## Ingest maintenance (inside the existing transaction)

`ingestDocument` already wraps its writes in `BEGIN … COMMIT`. Insert the maintenance there:

1. **Before** writing (existing doc only): capture `oldTerms` (distinct lexemes over the doc's current `title_tsvector` + its segments' `body_tsvector`) and old stats (`title_length`, `Σ body_length`, `segment_count`). New doc ⇒ all empty.
2. Write document + segments (existing logic unchanged).
3. **After** writing: compute `newTerms` the same way and the new stats.
4. `added = newTerms − oldTerms`, `removed = oldTerms − newTerms`.
5. Apply DF deltas, batched, with terms **sorted** for consistent lock order:
   - `INSERT INTO term_document_frequencies SELECT $idx, t, 1 FROM unnest($added::text[]) t ON CONFLICT (index_id, term) DO UPDATE SET document_frequency = term_document_frequencies.document_frequency + 1`
   - `UPDATE term_document_frequencies SET document_frequency = document_frequency - 1 WHERE index_id = $idx AND term = ANY($removed::text[])`
   - `DELETE FROM term_document_frequencies WHERE index_id = $idx AND document_frequency <= 0`
6. `UPDATE search_indexes` applying the counter/length deltas and recomputing the two averages: `total_title_length += Δtitle_length`, `total_body_length += Δbody_length`, `total_segments += Δsegment_count`. `total_documents` continues to be maintained as today (`+1` only on insert). All four feed the averages (float division).
7. **Skip 4–6** when nothing changed (no changed segments AND title unchanged) — the common re-run case. "Title unchanged" is detected by comparing the incoming `request.title` to the stored title read in the existing-document lookup (the current diff tracks only segment hashes, so this comparison is added).

**Deadlock handling:** concurrent ingests touching the same term contend on that DF row (inherent to any shared counter). Sorting the term arrays gives a consistent lock order; on `SQLSTATE 40P01` the ingest retries (it is idempotent).

## Delete maintenance

Make `deleteDocument` transactional: capture the doc's term set + stats → `DELETE FROM search_documents` (segments cascade) → DF `−1` for its terms (delete rows reaching 0) → subtract the length sums, `total_documents − 1`, recompute averages.

## Index deletion

No new logic: the DF table cascades on `index_id`, and the `search_indexes` row (with its sums) is removed by `deleteIndex`.

## Reconcile (drift backstop)

`reconcile_index_stats(index_id)` is an **in-database SQL/PL-pgSQL function** (it must be, so a DB scheduler can call it directly):

- Recompute DF for the one index (today's matview query, scoped to that `index_id`) and overwrite the table rows for that index in a transaction (`DELETE … WHERE index_id` + `INSERT … SELECT`).
- Recompute `total_*` sums + averages from source for that index (float division, as above).

Surfaces two ways, both thin wrappers over the function:

- **Admin endpoint** `POST /private/key/admin/indexes/:name/reconcile` (replaces the old `/refresh` route) — resolves the name to `index_id` and `SELECT reconcile_index_stats($1)`. Note: this runs on the 30 s API Lambda, so it is suitable for small/medium indexes and ad-hoc use, **not** as the path for a large-corpus recompute (that is what pg_cron is for).
- **Scheduler: pg_cron**, low frequency (a single job looping indexes, or per-index). pg_cron runs the function **in-database with no external timeout**, which is the whole point — the recompute is unbounded and must not run under the 30 s Lambda ceiling. A non-pg_cron path was considered (a dedicated long-timeout reconcile Lambda); the existing 30 s API-endpoint path is explicitly **not** viable for the heavy recompute. The EventBridge alternative was rejected in favor of pg_cron.

This is the only place the O(corpus) recompute runs, and it runs rarely and off the request path.

### Ownership boundary

Reconcile and its scheduler are **pgsearch's**, deployed to the **pgsearch stack** — they maintain pgsearch's own index statistics. They are independent of any particular search client; govsync is just one client (the phila.gov case) and owns none of this. The two services are not assumed to be co-deployed.

### Enabling pg_cron (pgsearch stack infra)

The dev instance is RDS **PostgreSQL 15.17** on the **`default.postgres15`** parameter group (`shared_preload_libraries = pg_stat_statements`). pg_cron is a supported value for this engine but is not loaded, and default parameter groups cannot be modified. Enablement (in the pgsearch CDK):

1. Create a custom DB parameter group (family `postgres15`) with `shared_preload_libraries = pg_stat_statements,pg_cron` (preserve the existing entry; this is a **static** parameter).
2. Attach it to the instance and **reboot** (required for the static parameter; brief, acceptable on dev).
3. `CREATE EXTENSION pg_cron;`. pg_cron's job scheduler runs in one database (`cron.database_name`); the reconcile jobs must target the pgsearch application database — use `cron.schedule_in_database(...)` (pg_cron ≥ 1.4) or set `cron.database_name` accordingly. Confirm the exact mechanism during planning.

Whether `LambdaPostgresApi` exposes parameter-group customization, or whether it needs a CDK escape hatch (as the WAF override already uses), is a planning detail.

## Removed

- `checkAndRefresh` call in `ingestDocument`; the `refreshIndex` function; the materialized view; the `/refresh` admin route (repurposed to `/reconcile`).
- `refresh_threshold` config field and its default (the recently-bumped 1000) — now moot.

## Migration v3 — uniform for fresh and existing databases

Migrations are versioned and append-only (`schema_migrations` tracks applied versions; each runs once, in order, on cold start). **Do not edit v1.** Append **version 3**:

1. `CREATE TABLE term_document_frequencies_tbl (…)`; `INSERT INTO term_document_frequencies_tbl SELECT index_id, term, document_frequency FROM term_document_frequencies`; `DROP MATERIALIZED VIEW term_document_frequencies`; `ALTER TABLE term_document_frequencies_tbl RENAME TO term_document_frequencies`.
2. `ALTER TABLE search_indexes ADD COLUMN total_title_length/total_body_length/total_segments …`; backfill each per index from `SUM(title_length)` / `SUM(body_length)` / `SUM(segment_count)`; recompute `avg_*` from the new sums (float division).
3. Create the `reconcile_index_stats(index_id)` SQL function.

v3 does **not** drop `docs_changed_since_refresh` (see Deploy ordering); that drop is deferred to the squash.

**Fresh spinup**: v1 creates the (empty) matview → v2 → v3 converts the empty matview to an empty table and backfills zeros. **Existing DB**: v3 converts the populated matview and backfills real sums. Same migration, same end state.

**Deploy ordering** — two old-code interactions during the rollout window (while warm old instances coexist with the migrated schema):

- Old `refreshIndex` calls `REFRESH MATERIALIZED VIEW` on the now-dropped matview. This runs **after commit, outside the transaction** (`checkAndRefresh` is post-commit), so it errors harmlessly and the resilient sync retries. Acceptable.
- Old ingest/delete update `docs_changed_since_refresh` **inside the transaction** (ingest.ts:162-165, delete at 203). If v3 dropped that column, those UPDATEs would fail and **roll back the whole ingest** — a real failure, not just stale stats. This is why v3 **keeps the column**; new code simply stops writing it, and the squash drops it once no old instances remain.

## Live `phila-gov`

It currently has stale stats (inline refresh was disabled and `refresh_threshold` set to 100M to get the bulk load through). Post-deploy, run `reconcile_index_stats(phila-gov)` once to correct DF + averages. Because its ~15k-doc recompute exceeds 30 s, this one-time run must go **in-DB** (a manual pg_cron job or direct `SELECT` once the extension is enabled), not the API endpoint. Incremental maintenance keeps it correct thereafter; scheduled pg_cron reconcile is the backstop.

## Testing

- **Unit** (docker test DB): new doc → DF + averages correct; update adding a term → `+1`; update removing a term → `−1` with row cleanup at 0; update with no change → no DF/stat change; delete → `−1` and stats subtracted; index delete → DF rows gone.
- **Invariant (primary guard)**: after an arbitrary sequence of ingests/deletes, `reconcile_index_stats` produces **zero changes** — i.e. incremental == from-scratch. Implement by snapshotting DF + sums, running reconcile, asserting equality.
- **Concurrency** (optional): two concurrent ingests on overlapping terms converge to correct DF without deadlock (sorted ordering + retry).

## Future work (tracked separately, not in this change)

- **Squash migrations to a clean baseline.** There is currently a single dev instance of the service, so the only precondition is that **v3 has applied to dev** — no multi-environment rollout to wait on. Once dev is at v3, collapse v1–v3 into one baseline that creates the correct end state directly (table + sum columns, no matview, **no `docs_changed_since_refresh`**), guarded to apply only to brand-new databases (empty `schema_migrations`) so the existing dev DB keeps its recorded history. This is also where `docs_changed_since_refresh` is finally dropped from the existing DB — safe by then because no old instances writing it remain. Removes the create-matview-then-convert step for fresh spinups. We keep v3 (rather than wiping and re-ingesting) so the ~14k docs already loaded into `phila-gov` survive the transition. (File a `bd` issue.)
- **pg_cron interval tuning** per real reconcile timings.

## Out of scope

- Changing tokenization / `text_search_config`.
- Incremental maintenance of anything beyond DF and the two average lengths.
