# HTML Parser Library Design

**Status:** Approved
**Date:** 2026-04-08
**Author:** Darren McDowell, Claude

## Summary

A composable, functional HTML parsing library for transforming raw HTML into search-ready documents. The library provides primitive transforms that compose into pipelines tuned per-corpus. It produces a `ParsedDocument` (`{ title, body, metadata }`) where `body` is markdown, ready to hand to the pgsearch ingest API.

## Goals

- **Composable.** Developers build pipelines from small primitives, not god-functions with sprawling option objects.
- **Generic.** No corpus-specific knowledge baked in. The same primitives parse phila.gov, a blog, and a documentation site.
- **Markdown output.** Bodies are stored as markdown so search snippets can preserve structure (headings, lists) without HTML sanitization concerns.
- **Sensible defaults.** Standard metadata extraction (opengraph, description, canonical URL, language) requires zero configuration.
- **Cheerio-native.** Built on Cheerio so Crawlee-based ingestion scripts can hand us their existing `$` instance with no overhead.
- **Decoupled from storage.** The parser produces a plain object. The caller is responsible for posting it to the API.

## Non-Goals

- **Fetching.** The library starts from HTML or a Cheerio instance. Fetching, rate limiting, retries, and crawling are the caller's job (typically Crawlee).
- **Chunking.** Chunking happens server-side in the pgsearch API based on per-index config. The parser produces a single markdown body string.
- **Plain text parsing.** If a developer has plain text, they construct `{ title, body, metadata }` directly. No `parseText` helper.
- **Storage opinions.** The library doesn't know about the database schema. It produces `ParsedDocument`; the caller decides what to do with it.

## Architecture

### Core types

```ts
import type { CheerioAPI } from 'cheerio'

interface ParseContext {
  $: CheerioAPI                          // mutable Cheerio instance
  title: string | null                   // populated by extractTitle
  body: string | null                    // populated by toMarkdown (terminal step)
  metadata: Record<string, unknown>      // populated by extractMeta and others
}

type Transform = (ctx: ParseContext) => ParseContext | Promise<ParseContext>

interface ParsedDocument {
  title: string
  body: string
  metadata: Record<string, unknown>
}
```

### Pipeline composition

```ts
function pipeline(
  ...transforms: Transform[]
): (input: string | CheerioAPI) => Promise<ParsedDocument>
```

**Public exports:** The package exports `pipeline`, every built-in transform, and the `Transform`, `ParseContext`, and `ParsedDocument` types. Exporting the types is essential — developers writing custom transforms need them to type the function signatures correctly.

The returned function:
1. Accepts an HTML string or a Cheerio instance
2. If string: loads it via Cheerio
3. Performs implicit cleanup (strip `<script>`, `<style>`, `<noscript>`, HTML comments)
4. Constructs a `ParseContext` with `title: null`, `body: null`, `metadata: {}`
5. Awaits each transform in order, passing the context through
6. Coerces final `title` from `null` to `''`
7. Coerces final `body` from `null` to `''`
8. Returns `{ title, body, metadata }`

### Usage example

```ts
import {
  pipeline,
  extractMeta,
  extractTitle,
  selectContent,
  remove,
  cleanWhitespace,
  toMarkdown,
} from '@phila/search-parse'

const parsePhilaService = pipeline(
  extractMeta(),                                  // metadata first (needs <head>)
  extractTitle('.entry-header h2'),
  remove('.breadcrumbs', '.related-content'),
  selectContent('.entry-content'),
  cleanWhitespace(),
  toMarkdown(),
)

const doc = await parsePhilaService(html)
// doc.title   → "Pay a water bill"
// doc.body    → "Learn how to make...\n\n## You can pay with..."
// doc.metadata → { description, og_title, canonical_url, language, ... }
```

## Built-in Transforms

### `extractMeta(options?)`

Extracts standard metadata into `ctx.metadata`. By default grabs every `<meta>` tag (with normalization and a junk blocklist), the `<title>` element, `<link rel="canonical">`, and `<html lang="...">`.

**Default extracted keys:**
- `description` (from `meta[name="description"]`)
- `keywords`, `author`
- `language` (from `<html lang>`)
- `html_title` (from `<title>` element)
- `canonical_url` (from `link[rel="canonical"]` or `meta[property="og:url"]`)
- All `og:*` tags as `og_*` (e.g. `og_title`, `og_description`, `og_image`, `og_url`, `og_type`, `og_site_name`, `og_image_alt`)
- All `article:*` tags as `article_*` (e.g. `article_published_time`, `article_modified_time`, `article_author`, `article_section`)

**Default-blocked tags:**
- Browser/rendering: `viewport`, `charset`, `X-UA-Compatible`, `format-detection`, `referrer`, `color-scheme`, `theme-color`
- Mobile app shims: `apple-mobile-web-app-*`, `msapplication-*`, `mobile-web-app-capable`, `application-name`, `HandheldFriendly`, `MobileOptimized`
- SEO directives: `robots`, `googlebot`, `bingbot`
- Verification: `google-site-verification`, `yandex-verification`, `msvalidate.01`, `facebook-domain-verification`, `fb:app_id`, `p:domain_verify`, `norton-safeweb-site-verification`
- Tooling: `generator`
- Twitter cards: all `twitter:*` (almost always duplicates of `og:*`)

**Options:**
```ts
extractMeta()                                    // default behavior
extractMeta({ only: ['description', 'og_title'] })   // narrow to specific keys
extractMeta({ exclude: [/^article_/] })          // add to default exclusions
extractMeta({ extras: { custom_field: 'meta[name=foo]' } })  // map custom selectors to metadata keys
```

`only`, `exclude`, and `extras` are combinable in a single call. When `only` is set, the default extraction is restricted to those keys before applying `exclude`. `extras` is always added regardless of `only`/`exclude` (the user explicitly asked for them).

**Key naming convention:** Colons in source meta names become underscores (`og:title` → `og_title`) for SQL friendliness in JSONB queries.

### `extractTitle(selector?, options?)`

Sets `ctx.title`. With no selector, uses a fallback chain:
1. The first `<h1>` in the document
2. `metadata.og_title` (must be set first by `extractMeta`)
3. `metadata.html_title` (must be set first by `extractMeta`)

With a selector, uses the selector exclusively (no fallback). Pass `{ required: true }` to throw if the title can't be resolved.

### `selectContent(selector, options?)`

Narrows `ctx.$` to the selected subtree by replacing it with a Cheerio instance scoped to the matched element. Subsequent content transforms operate only within this subtree.

**Ordering note:** All transforms query whichever Cheerio instance is in `ctx.$` at the time they run. `extractMeta` must therefore run **before** `selectContent` if you want it to see the `<head>` tags. The library does not maintain a separate "root" reference — pipeline ordering is the discipline.

Pass `{ required: true }` to throw if the selector matches nothing. Otherwise, missing content is a no-op.

### `remove(...selectors)`

Removes all elements matching any of the given selectors from the working DOM. Mutates `ctx.$` in place. Idempotent. Useful for stripping breadcrumbs, related-content sidebars, sharing widgets, etc.

### `unwrap(...selectors)`

Removes the wrapper element but keeps its children in place. Useful for stripping presentational `<span>`, `<div>`, or `<font>` tags without losing their text content.

### `cleanWhitespace()`

Normalizes whitespace in the working DOM:
- Collapses runs of whitespace within text nodes to a single space
- Normalizes unicode whitespace (`\u00A0`, `\u200B`, etc.) to standard spaces
- Trims leading/trailing whitespace from text nodes

Markdown converters often produce messy output from HTML with irregular whitespace. This step cleans the input first.

### `injectIntoBody(options)`

Optional transform to inject metadata fields into the body before markdown conversion. Useful for boosting search relevance by including the publisher's description in the embedded content.

```ts
injectIntoBody({ from: 'description', position: 'prepend' })
```

The injected text is wrapped in a `<p>` element so it survives markdown conversion as a standalone paragraph (rather than being concatenated into adjacent text). For `position: 'prepend'`, the `<p>` is inserted as the first child of the working DOM root; for `position: 'append'`, it becomes the last child.

If `metadata[from]` is missing or empty, the transform is a no-op.

### `toMarkdown(options?)`

Terminal step. Converts the working DOM to markdown using `turndown` with GitHub-flavored markdown extensions (tables, strikethrough). Sets `ctx.body` to the result.

**Default turndown configuration:**
- Headings: ATX style (`# Heading`)
- Lists: dash bullets, no extra blank lines
- Code blocks: fenced
- Link style: inline

A custom turndown rule strips empty paragraphs (turndown doesn't have a built-in option for this — it requires registering a rule that filters `<p>` elements with no text content).

**Options pass through to turndown:**
```ts
toMarkdown({ headingStyle: 'setext' })
toMarkdown({ linkStyle: 'referenced' })
```

**If `toMarkdown` is omitted from a pipeline:** `ctx.body` stays `null` and is coerced to `''` at output. This is consistent with the lenient-by-default philosophy — if a developer wants the document body intentionally empty, they can omit the transform.

## Error Handling

The pipeline is **lenient by default**. Each transform writes what it can and skips what it can't.

| Scenario | Default behavior |
|---|---|
| `extractTitle` finds nothing | `ctx.title` stays `null`, becomes `''` at output |
| `selectContent` selector misses | No-op; working DOM unchanged |
| `extractMeta` finds no meta tags | `ctx.metadata` stays empty |
| Malformed HTML | Cheerio auto-corrects |
| Empty input | Returns `{ title: '', body: '', metadata: {} }` |

For strict mode, transforms that take selectors accept `{ required: true }`:

```ts
extractTitle('.entry-header h2', { required: true })   // throws if not found
selectContent('.entry-content', { required: true })    // throws if not found
```

The caller decides whether empty fields are acceptable. The library does not validate the final document.

## Implicit Cleanup

When the pipeline first loads HTML (string or Cheerio), it always strips:

- `<script>` elements
- `<style>` elements
- `<noscript>` elements
- HTML comments

These have zero search value and add noise to every transform downstream. They are removed before any user transforms run.

`<svg>` and `<iframe>` are **not** stripped by default — some sites embed meaningful content via these. Use `remove('svg', 'iframe')` if you want them gone.

## Async Transforms

Transforms return `ParseContext | Promise<ParseContext>`. The pipeline always `await`s, so synchronous transforms work without overhead and async transforms are possible. This enables custom transforms that need to make HTTP calls (e.g. resolving relative URLs against a sitemap, fetching JSON-LD context documents).

The built-in transforms are all synchronous.

## Markdown Conversion

Uses `turndown` with `turndown-plugin-gfm` for tables and strikethrough. Turndown is mature, well-tested, and configurable.

**Why markdown over plain text:**
- Preserves structure (headings, lists) for search result snippets
- Embeds just as well as plain text — embedding models don't gain meaning from raw HTML tags
- Source-agnostic — frontend doesn't need to sanitize HTML from arbitrary sites
- Storage cost is minimal (markdown is compact)

**Why markdown over storing raw HTML:**
- The original HTML is always available at the source URL
- Re-parsing HTML on every snippet render is wasted work
- If parsing logic changes, we re-ingest anyway

## File Structure

```
packages/parse/
├── src/
│   ├── index.ts                     — public exports
│   ├── pipeline.ts                  — pipeline(), Transform, ParseContext, ParsedDocument types
│   ├── context.ts                   — context creation + implicit cleanup
│   ├── markdown.ts                  — turndown configuration
│   └── transforms/
│       ├── extract-meta.ts
│       ├── extract-title.ts
│       ├── select-content.ts
│       ├── remove.ts
│       ├── unwrap.ts
│       ├── clean-whitespace.ts
│       ├── inject-into-body.ts
│       └── to-markdown.ts
├── test/
│   ├── pipeline.test.ts             — composition, async, error handling
│   ├── extract-meta.test.ts         — meta extraction + blocklist + key normalization
│   ├── extract-title.test.ts        — fallback chain, required mode
│   ├── select-content.test.ts       — narrowing, required mode
│   ├── remove.test.ts
│   ├── unwrap.test.ts
│   ├── clean-whitespace.test.ts
│   ├── inject-into-body.test.ts
│   ├── to-markdown.test.ts          — markdown conversion fidelity
│   └── e2e.test.ts                  — full pipeline against real phila.gov fixture
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Dependencies

**Runtime:**
- `cheerio` (`^1.0.0`) — HTML parser
- `turndown` (`^7.2.0`) — HTML→markdown converter
- `turndown-plugin-gfm` (`^1.0.2`) — GitHub-flavored markdown extensions

**Development:**
- `vitest` — test runner
- `@types/turndown`
- `typescript`

## Migration

The existing `@phila/search-ingest` package contains `parseHtml` and `parseText`. Both have zero callers in the codebase (verified during exploration — the existing e2e test had to inline its own parser).

**Plan:**
1. Create new package at `packages/parse/` with name `@phila/search-parse`
2. Implement the pipeline and transforms
3. Update the e2e test (`apps/api/test/e2e-hybrid-search.test.ts`) to use `@phila/search-parse` instead of its inlined `parseServicePage` function
4. Delete the old `packages/ingest/` directory entirely
5. Update root `pnpm-workspace.yaml` if needed (currently uses `packages/*` glob, so no changes required)
6. Update `package.json` test script to reference `./packages/parse` instead of `./packages/ingest`

The old package is dead code. No backward compatibility shim is needed.

## Testing Strategy

**Unit tests** for each transform with small handcrafted HTML fixtures:
- Each transform tested in isolation
- Both success and failure (missing selectors) cases
- Required vs lenient modes
- Edge cases: empty input, malformed HTML, unicode whitespace

**Integration test** for the pipeline runner:
- Composition order matters
- Async transforms work
- Implicit cleanup runs before user transforms
- Final coercion of null → empty string

**E2E test** with a real phila.gov page (cached as a fixture in the test directory to avoid network flakiness in CI):
- Full pipeline produces expected `ParsedDocument`
- Markdown output is well-formed
- Standard metadata is extracted correctly
- Custom phila.gov pipeline matches what the e2e test in `apps/api/test/e2e-hybrid-search.test.ts` produces

The e2e test in `apps/api/test/e2e-hybrid-search.test.ts` is updated to use the new library, validating end-to-end integration with the actual ingest API and search.

## Future Considerations (Not in Scope)

- **Per-language tsvector config** — `metadata.language` could drive `text_search_config` selection in the API, but that's an API/ingest concern, not a parser concern.
- **JSON-LD extraction** — Could ship as `extractJsonLd()` later. Out of scope for v1.
- **Image extraction** — Could ship as `extractImages()` to populate `metadata.images` for richer result cards. Out of scope for v1.
- **Sitemap-aware transforms** — Resolving relative URLs against a sitemap could be a custom async transform. Doesn't need to be built in.
- **JSONB GIN index on `search_documents.metadata`** — When we want to filter search results by metadata fields (e.g. `language`, `og_type`), we'll add a GIN index. Tracked separately; not a parser concern.
