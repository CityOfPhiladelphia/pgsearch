<!-- ABOUTME: Guide for getting content into pgsearch — document model, ingestion API, and segmentation. -->
<!-- ABOUTME: Covers the @phila/search-parse library for HTML extraction and the crawler as a reference implementation. -->

# Ingestion

This guide covers how to get content into pgsearch: the document model, the ingestion API, how body text is segmented for embedding, and the `@phila/search-parse` library for extracting structured documents from HTML.

## Document Model

A document in pgsearch has four fields:

| Field | Required | Description |
|-------|----------|-------------|
| `external_id` | Yes | Your unique identifier. Used for upserts — re-ingesting the same `external_id` updates the existing document. |
| `title` | Yes | Document title. Weighted 3x in keyword search by default. Prepended to each segment before embedding. |
| `body` | Yes | Document content as plain text or markdown. Automatically chunked into segments. |
| `metadata` | No | Arbitrary JSON. Passed through to search results unchanged. Use for source URLs, content types, tags — anything your consumer needs. |

## Ingestion API

### Index a Document

```
POST /public/index/:name/documents
Header: x-index-key: <index_key>
```

Request body:

```json
{
  "external_id": "unique-id",
  "title": "Document Title",
  "body": "Full document content...",
  "metadata": {"source_url": "https://...", "content_type": "article"}
}
```

Response:

```json
{
  "external_id": "unique-id",
  "segments": 5,
  "changed": 3,
  "unchanged": 2,
  "status": "indexed"
}
```

Re-ingesting a document with the same `external_id` within an index updates the existing document. Each segment is SHA256 content-hashed — only segments whose content actually changed are re-embedded. This saves embedding API costs on large re-ingestion runs.

### Delete a Document

```
DELETE /public/index/:name/documents/:external_id
Header: x-index-key: <index_key>
```

### Export Index State

```
GET /public/index/:name/documents
Header: x-index-key: <index_key>
```

Query parameters:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `limit` | No | Page size. Default 1000, max 5000. Out-of-range values are clamped, not rejected. |
| `after` | No | Exclusive cursor. Returns documents with `external_id > after`. Omit on the first page; pass the previous response's `next_cursor` on subsequent pages. |

Response:

```json
{
  "documents": [
    {
      "external_id": "page-001",
      "updated_at": "2026-04-10T12:00:00.000Z",
      "metadata": {"source_url": "https://example.com/parking"}
    }
  ],
  "next_cursor": "page-001"
}
```

`next_cursor` is the last document's `external_id` when the page is full, and `null` when there are no more pages.

Documents are returned in ascending `external_id` order. To export the full index, page until `next_cursor` is `null`. Once you have the complete list, delete the `external_id`s that exist in the index but not in your upstream source, and re-ingest documents whose content has changed — using `updated_at` or a fingerprint you stored in `metadata` (for example, an S3 ETag) to identify which ones to re-POST.

## Segmentation

Body text is split into segments for embedding. The chunker splits on the coarsest boundary that fits — paragraph, then line, then sentence, then word, and finally between characters as a last resort — so even an unbreakable token (a long URL, a `data:` URI) is reduced to fit. The resulting pieces are then greedily packed back up to `max_segment_tokens`.

Segment size is measured by an estimate of `ceil(UTF-8 bytes / 3)`. A byte-level BPE token spans at least one byte, so real embedding tokens never exceed the byte count — this keeps every segment safely under the embedding model's hard input limit (Titan Embed v2: 8192) regardless of script or content, without tokenizing locally.

Each segment is embedded independently with the document title prepended for context. Smaller segments produce more focused embeddings; larger segments preserve more surrounding context. Configurable per-index via `max_segment_tokens` (default 1000) and `max_segments_per_document` (default 150).

## The Parse Library (`@phila/search-parse`)

`@phila/search-parse` is a composable pipeline for extracting structured documents from HTML. Build one pipeline per source site's DOM structure.

```typescript
import { pipeline, extractMeta, extractTitle, selectContent, remove, cleanWhitespace, toMarkdown } from '@phila/search-parse'

const parse = pipeline(
  extractMeta(),                          // Pull meta tags, og:*, canonical URL into metadata
  extractTitle('.entry-header h2'),       // Extract title from CSS selector (falls back to h1 → og:title → <title>)
  remove('.breadcrumbs', '.sidebar'),     // Strip elements before content extraction
  selectContent('.main-content'),         // Narrow scope to content container
  cleanWhitespace(),                      // Collapse whitespace, remove empty lines
  toMarkdown()                            // Convert remaining HTML to markdown
)

const doc = await parse(htmlString)
// { title: "...", body: "# Markdown content...", metadata: { canonical_url: "...", ... } }
```

### Built-in Transforms

| Transform | Purpose |
|-----------|---------|
| `extractMeta(options?)` | Extracts `<meta>` tags, Open Graph, `canonical`, `lang` into metadata. Options: `only` (allowlist), `exclude` (regex blocklist), `extras` (map of metadata key → CSS selector for additional extraction targets). |
| `extractTitle(selector?, options?)` | Extracts title from selector, or falls back through h1 → `og_title` → `html_title` from metadata. Run `extractMeta()` first for fallbacks to work. |
| `selectContent(selector, options?)` | Narrows the DOM to a subtree. Everything outside the selector is discarded. |
| `remove(...selectors)` | Removes matching elements from the DOM. |
| `unwrap(...selectors)` | Removes elements but keeps their children (e.g., strip a wrapper div). |
| `cleanWhitespace()` | Collapses multiple whitespace runs and removes empty lines. |
| `toMarkdown(options?)` | Terminal transform. Converts DOM to markdown via Turndown. |
| `injectIntoBody({ from, position })` | Reads a string from `metadata[from]` and injects it as a paragraph into the DOM at the given position (`'prepend'` or `'append'`). |

Pipelines are composable — build one per source site's DOM structure.

## The Crawler as Reference

`apps/crawler` is a working example wiring Crawlee + parse pipelines + ingest API for phila.gov.

```bash
tsx apps/crawler/src/cli.ts \
  --endpoint https://<api-url> \
  --index phila-services-programs \
  --index-key $INDEX_KEY \
  --seed https://www.phila.gov/services/ \
  --seed https://www.phila.gov/programs/ \
  --concurrency 4 \
  --limit 50
```

The crawler routes URLs to parse pipelines by path pattern, parses each page, and POSTs to the ingest API. See `apps/crawler/src/parse/` for pipeline definitions.

## Known Pitfalls

### Duplicate Content from Multiple URLs

CMS sites commonly serve identical content under different URL paths. Each URL ingested as a separate `external_id` creates a separate document — producing duplicate search results with identical titles, snippets, and scores.

Use the page's `canonical_url` (extracted by `extractMeta()`) as the `external_id` instead of the source URL. The phila.gov crawler currently uses the source URL directly — this is a known limitation.

### Statistics Maintenance

BM25F scoring relies on term-frequency and average-length statistics. These are maintained incrementally and transactionally on every ingest and delete, so no refresh step is needed after a bulk load. If you suspect the statistics have drifted, `POST /private/key/admin/indexes/<name>/reconcile` rebuilds them from source.
