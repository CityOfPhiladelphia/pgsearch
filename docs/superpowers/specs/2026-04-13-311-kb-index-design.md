# 311 Knowledge Base Ingestion Design

## Problem

We want to evaluate pgsearch search quality against a real Philly 311 knowledge base (Salesforce Knowledge export, ~1000 articles). Today there is no ingestion path for REST-pull sources — the only existing ingestion source is the phila.gov web crawler. We need to pull articles from a REST API, convert Salesforce HTML to clean markdown, and index them into a new pgsearch index so we can drive queries against the existing manual search page.

The immediate goal is evaluation, not production. The design must not preclude scheduled ingestion later.

## Scope

In scope:
- One-shot CLI script that pulls all articles from the 311 knowledge-articles endpoint and indexes them.
- A new pgsearch index named `knowledge-311` in the dev environment.
- Unit test coverage for the HTML→markdown transform (the only piece with non-trivial logic).

Out of scope:
- Scheduled/recurring ingestion. Script must be structured so promoting to scheduled is a mechanical move, not a rewrite.
- Incremental sync. Every run is a full pull; pgsearch ingest is idempotent by `external_id`, so re-runs update in place.
- Reconciliation of deleted articles (articles removed upstream will remain in the index until we add that).
- Search tuning. We use pgsearch defaults and see what the corpus looks like before touching BM25F or RRF weights.
- Filtering by visibility/audience. We treat every article from the endpoint as public per Darren; a future pass can add filtering once we confirm visibility semantics.

## Data source

**List endpoint:** `GET ${KB_API_BASE}/private/key/knowledge-articles` with header `x-api-key: ${KB_API_KEY}`.

Response:
```json
{
  "articles": [
    {
      "id": "000002701",
      "title": "A security warning appears when I navigate to the Eclipse website",
      "lastPublishedAt": "2019-10-02T13:08:54.000+0000",
      "url": "A-security-warning-appears-when-I-navigate-to-the-Eclipse-website"
    }
  ]
}
```

Pagination is via the `Link` response header:
```
Link: <...?offset=0&limit=50>; rel="first",
      <...?offset=1000&limit=50>; rel="last",
      <...?offset=50&limit=50>; rel="next"
```

The script walks `rel="next"` until it is absent. `rel="last"` is not used as a stop condition because new articles can be published mid-run.

**Detail endpoint:** `GET ${KB_API_BASE}/private/key/knowledge-articles/{id}` returns the same fields plus `content` — raw Salesforce Knowledge HTML with inline `style=` attributes, nested `<span>`s, `&nbsp;` entities, and `<br>`-driven paragraph breaks.

The `url` field is a slug (not a full URL). The canonical article URL is constructed as `https://philly311.my.salesforce-sites.com/Articles/{url}`. The base may change; it lives in a single constant so re-ingestion is a one-line fix.

## Target index

**Name:** `knowledge-311`

**Environment:** pgsearch dev (`https://3qkikancml.execute-api.us-east-1.amazonaws.com/dev`) — matches the existing manual search page at `apps/api/dev/search.html`.

**Config:** defaults from `apps/api/config.ts`. We have no signal yet to justify tuning.

**Setup flow (`ensureIndex`):**
1. `GET /private/key/admin/indexes/knowledge-311`. If it exists, return its info with `created: false`.
2. Otherwise `POST /private/key/admin/indexes` with `{ name: "knowledge-311", description: "Philly 311 knowledge base articles (Salesforce Knowledge export)" }` and return `created: true` along with the freshly generated `index_key` and `search_key`.

On first run the script prints a visible banner with both keys — they are bcrypt-hashed server-side and cannot be retrieved again. On subsequent runs the script reads `KNOWLEDGE_311_INDEX_KEY` from env. This mirrors the pattern in `apps/api/scripts/bootstrap-dev-index.ts`, with one intentional divergence: that script has a `BOOTSTRAP_UNSAFE` guard that refuses to run against non-localhost targets. This one does not — it explicitly targets the remote dev URL. Do not "align" this script with the bootstrap guard; remote dev is the target.

## Document mapping

```ts
{
  external_id: raw.id,                         // "000002701"
  title:       raw.title,
  body:        htmlToMarkdown(raw.content),    // see "HTML parsing"
  metadata: {
    source:            "phila-311-kb",
    source_slug:       raw.url,
    source_url:        `${ARTICLE_URL_BASE}${raw.url}`,
    last_published_at: raw.lastPublishedAt,
  }
}
```

- `source: "phila-311-kb"` is a constant on every document so a future unified index can filter by origin.
- `source_slug` is the stable identifier from the API; `source_url` is derived for search-page click-through convenience.
- If `body` is empty (whitespace only) after conversion, `transform()` returns `null` and the driver skips the article with a warning. Empty bodies are useless for search evaluation.

## HTML parsing

The existing `@phila/search-parse` pipeline is the HTML→markdown solution:

```ts
import { pipeline, cleanWhitespace, toMarkdown } from "@phila/search-parse";

const parseKbHtml = pipeline(
  cleanWhitespace(),
  toMarkdown(),
);
```

No `selectContent()` — the API already returns just the article body, no nav or breadcrumbs to strip. No `extractTitle()`/`extractMeta()` — those come from the list response. The pipeline's shared context already strips `<script>`, `<style>`, and comment nodes (`packages/parse/src/context.ts:8-36`), which handles inline `<style>` blocks. `toMarkdown` collapses consecutive `<br>` into paragraph breaks and drops `style=` attributes.

If `pipeline()` throws on a malformed article, the driver catches per-article, logs the id, and skips. One bad article must not abort a 1000-article run.

## Architecture

Single file: `apps/api/scripts/ingest-311-kb.ts`.

Exported pure functions (each independently testable, each extractable to a module later without edits):

```ts
fetchArticleList(base, apiKey, offset, limit): Promise<{ articles, nextLink }>
fetchArticle(base, apiKey, id):                Promise<RawArticle>
transform(raw):                                IngestDocument | null
ensureIndex(pgsearchBase, adminKey, name):     Promise<EnsureIndexResult>
// EnsureIndexResult:
//   { created: true,  index_key, search_key }   // fresh create: keys present
//   { created: false }                            // already existed: keys unretrievable
pushDocument(pgsearchBase, indexKey, doc):     Promise<IngestResponse>
refreshIndex(pgsearchBase, adminKey, name):    Promise<void>
```

A bottom-of-file `main()` wires them together and is invoked only when the file is the entry point (`if (import.meta.url === ...)`), so the module stays importable without running the CLI.

**Environment variables:**

| Var | When required | Value |
|---|---|---|
| `KB_API_BASE` | always | `https://yw32n3h725.execute-api.us-east-1.amazonaws.com/test` |
| `KB_API_KEY` | always | 311 knowledge articles API key |
| `PGSEARCH_API_BASE` | always | `https://3qkikancml.execute-api.us-east-1.amazonaws.com/dev` |
| `PGSEARCH_ADMIN_KEY` | always | dev admin key |
| `KNOWLEDGE_311_INDEX_KEY` | only when the index already exists | captured from the first-run banner |

The four "always" vars are validated at startup; missing any is a fail-fast exit. `KNOWLEDGE_311_INDEX_KEY` is validated later, only after `ensureIndex` returns `created: false` — on a first run the index does not yet exist, so requiring the key up front would be a chicken-and-egg problem.

**Invocation:** `pnpm --filter @phila/pgsearch-api ingest:311-kb`, matching the style used for `bootstrap-dev-index.ts`.

## Execution flow

1. Load and validate env vars. Exit 1 with a clear message on missing values.
2. `ensureIndex(PGSEARCH_API_BASE, PGSEARCH_ADMIN_KEY, "knowledge-311")`.
   - On `created: true`, print a banner with both keys and instruct the operator to save them.
   - On `created: false`, read `KNOWLEDGE_311_INDEX_KEY` from env; exit 1 if not present.
3. **Phase 1 — collect IDs.** Walk the list endpoint via `Link: rel="next"` pagination, collecting `{id, title}` pairs into memory.
4. **Phase 2 — fetch/transform/push.** Sequentially for each id:
   - `fetchArticle` → `transform` → `pushDocument`.
   - Track counters: `indexed`, `skipped` (empty body), `failed` (fetch/transform/push exceptions).
   - Print a progress line every 50 articles: `[350/1050] indexed=342 skipped=5 failed=3`.
5. `refreshIndex(...)` once at the end, regardless of counter values.
6. Print a final summary with counters and wall-clock time. Exit 0.

Sequential detail fetches are chosen deliberately — at ~200 ms/round-trip × 1000 articles ≈ 3–4 minutes, which is acceptable for a spike, and it keeps error reporting linear. If a future real-world run demonstrates this is too slow, adding `p-limit(4)` is a one-line change.

## Error handling

| Failure | Action | Exit code |
|---|---|---|
| Missing env var | Print what's missing, exit | 1 |
| List fetch failure | Log error, exit (no catalog = can't proceed) | 1 |
| Detail fetch failure | Log `skip ${id}: ${error}`, `failed++`, continue | — |
| Transform exception | Log `skip ${id}: ${error}`, `failed++`, continue | — |
| Empty body after transform | Log `skip ${id}: empty body`, `skipped++`, continue | — |
| Push failure | Log `skip ${id}: ${error}`, `failed++`, continue | — |
| Refresh failure | Log warning (documents still indexed), exit 0 | 0 |

No retries in v1. If flakiness shows up during real runs, we add retry-with-backoff, but only then. Gold-plating error handling we may not need violates YAGNI.

## Testing

**Unit test:** `apps/api/scripts/ingest-311-kb.test.ts`. Covers `transform()` only.

Rationale: fetchers and the push wrapper are thin `fetch` wrappers — testing them tests the runtime. `transform()` is where real logic lives and where drift (Salesforce changing its export format) will bite us.

**Fixtures:** real API responses captured live and checked in to `apps/api/scripts/__fixtures__/311-kb/`:
- `simple.json` — the Eclipse security-warning article (clean, short, single `<div><span>`).
- `nested.json` — a longer article with nested spans, inline styles, and `&nbsp;` entities.
- `malformed.json` — hunted down during implementation; an article where the HTML is broken or the body is effectively empty after stripping.

Using frozen snapshots keeps the test offline and fast.

**Assertions:**
- `simple` → body is non-empty markdown; no `<span>`, `<div>`, or `style=` remnants; no `&nbsp;`.
- `simple` → `external_id`, `title`, `metadata.source`, `metadata.source_slug`, `metadata.source_url` match expected values.
- `nested` → same cleanliness checks plus: consecutive `<br><br>` in source becomes a blank line in the markdown output.
- `malformed` → either returns `null` or throws; exactly one behavior is asserted, and the driver's handling matches.

**No integration test.** The end-to-end validation is running the script against dev pgsearch and manually evaluating results on the existing search page. Integration coverage for a one-shot evaluation tool is not worth the setup cost.

## Non-goals for this pass

- BM25F / RRF / embedding config tuning. We intentionally index with defaults to establish a baseline.
- Deletion reconciliation. Upstream deletes do not propagate until the next manual cleanup.
- Rate limiting, retries, concurrency. Sequential fetch is fast enough and simple is better than robust-but-speculative.
- A shared REST-ingestion abstraction. Not warranted until we have a second REST source to share with.

## Future work (not in this spec, just captured so it isn't forgotten)

- Move `fetchArticleList`/`fetchArticle`/`transform`/`pushDocument` into a reusable module when a scheduled runner is built.
- Add `p-limit` concurrency if the real run is noticeably slow.
- Add retry-with-backoff if flakiness appears.
- Investigate whether the endpoint exposes a visibility/audience filter, and apply it if internal-only articles are slipping in.
- Handle article deletions via a reconciliation pass (list upstream ids, compare with indexed ids, delete the difference).
