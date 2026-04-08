# HTML Parser Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@phila/search-parse`, a composable functional pipeline library that transforms raw HTML into a `ParsedDocument` (`{ title, body, metadata }`) with markdown body output, replacing the dead `@phila/search-ingest` package.

**Architecture:** Functional pipeline of transforms built on Cheerio. Each transform reads/writes a `ParseContext` carrying the working DOM, title, body, and metadata. The terminal `toMarkdown` transform serializes the working DOM to markdown via turndown. All built-in transforms are pure structural primitives — corpus-specific tuning lives in pipeline composition, not in the library.

**Tech Stack:** TypeScript, Cheerio (`^1.0.0`), turndown (`^7.2.0`), turndown-plugin-gfm (`^1.0.2`), Vitest

**Spec:** `docs/superpowers/specs/2026-04-08-html-parser-library-design.md`

---

## File Structure

**New package: `packages/parse/`**

```
packages/parse/
├── src/
│   ├── index.ts                     — public exports (pipeline, transforms, types)
│   ├── pipeline.ts                  — pipeline() runner, Transform/ParseContext/ParsedDocument types
│   ├── context.ts                   — context creation + implicit cleanup (script/style/noscript/comments)
│   ├── markdown.ts                  — turndown instance with GFM and empty-paragraph rule
│   └── transforms/
│       ├── extract-meta.ts          — extractMeta() — meta tags, og:*, article:*, canonical, lang
│       ├── extract-title.ts         — extractTitle() — selector or h1 → og_title → html_title fallback
│       ├── select-content.ts        — selectContent() — narrows ctx.$ to a subtree
│       ├── remove.ts                — remove(...selectors) — strips elements
│       ├── unwrap.ts                — unwrap(...selectors) — removes wrapper, keeps children
│       ├── clean-whitespace.ts      — cleanWhitespace() — normalize whitespace in text nodes
│       ├── inject-into-body.ts      — injectIntoBody() — inject metadata field as <p> into body
│       └── to-markdown.ts           — toMarkdown() — terminal step, serializes to markdown
├── test/
│   ├── pipeline.test.ts             — composition, async, error coercion, implicit cleanup
│   ├── context.test.ts              — context creation, accepts string or CheerioAPI
│   ├── extract-meta.test.ts         — extraction, blocklist, key normalization, options
│   ├── extract-title.test.ts        — fallback chain, explicit selector, required mode
│   ├── select-content.test.ts       — narrowing, required mode
│   ├── remove.test.ts               — basic + multiple selectors
│   ├── unwrap.test.ts               — preserves children
│   ├── clean-whitespace.test.ts     — whitespace runs, unicode whitespace
│   ├── inject-into-body.test.ts     — prepend, append, missing key no-op
│   ├── to-markdown.test.ts          — headings, lists, links, empty paragraph stripping
│   └── e2e.test.ts                  — full pipeline against cached phila.gov fixture
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

**Modified files:**

- `apps/api/test/e2e-hybrid-search.test.ts` — replace inlined `parseServicePage()` with `@phila/search-parse` pipeline
- `apps/api/package.json` — add `@phila/search-parse` as dev dependency
- `package.json` (root) — update test script to reference `./packages/parse` instead of `./packages/ingest`

**Deleted files:**

- Entire `packages/ingest/` directory

---

## Task 1: Scaffold the new package

**Files:**
- Create: `packages/parse/package.json`
- Create: `packages/parse/tsconfig.json`
- Create: `packages/parse/vitest.config.ts`
- Create: `packages/parse/src/index.ts` (placeholder)

- [ ] **Step 1: Create package.json**

Create `packages/parse/package.json`:

```json
{
  "name": "@phila/search-parse",
  "version": "0.0.1",
  "private": true,
  "main": "src/index.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "cheerio": "^1.0.0",
    "turndown": "^7.2.0",
    "turndown-plugin-gfm": "^1.0.2"
  },
  "devDependencies": {
    "@types/turndown": "^5.0.5",
    "typescript": "^5.3.0",
    "vitest": "^3.1.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Create `packages/parse/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "declaration": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

Create `packages/parse/vitest.config.ts`:

```ts
// ABOUTME: Vitest configuration for the search-parse package.
// ABOUTME: Targets test files under the test/ directory.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})
```

- [ ] **Step 4: Create placeholder src/index.ts**

Create `packages/parse/src/index.ts`:

```ts
// ABOUTME: Public exports for the @phila/search-parse package.
// ABOUTME: Exports pipeline runner, built-in transforms, and core types.

export {}
```

- [ ] **Step 5: Install dependencies**

Run from repo root:

```bash
pnpm install
```

Expected: pnpm picks up the new workspace package and installs cheerio, turndown, turndown-plugin-gfm, and @types/turndown.

- [ ] **Step 6: Verify the package builds**

Run:

```bash
cd packages/parse && pnpm build && cd ../..
```

Expected: `tsc` runs without errors, produces an empty `dist/` directory.

- [ ] **Step 7: Commit**

```bash
git add packages/parse/ pnpm-lock.yaml
git commit -m "feat(parse): scaffold @phila/search-parse package"
```

---

## Task 2: Core types and pipeline runner

**Files:**
- Create: `packages/parse/src/pipeline.ts`
- Create: `packages/parse/src/context.ts`
- Create: `packages/parse/test/pipeline.test.ts`
- Create: `packages/parse/test/context.test.ts`

**TDD discipline:** Write the tests first. Each test should fail before the implementation exists.

- [ ] **Step 1: Write the failing test for context creation from string**

Create `packages/parse/test/context.test.ts`:

```ts
// ABOUTME: Tests for ParseContext creation and implicit cleanup.
// ABOUTME: Verifies that scripts, styles, noscript, and comments are stripped on load.

import { describe, it, expect } from 'vitest'
import { createContext } from '../src/context'

describe('createContext', () => {
  it('accepts an HTML string and returns a populated context', () => {
    const ctx = createContext('<html><body><p>hello</p></body></html>')
    expect(ctx.$).toBeDefined()
    expect(ctx.title).toBeNull()
    expect(ctx.body).toBeNull()
    expect(ctx.metadata).toEqual({})
    expect(ctx.$('p').text()).toBe('hello')
  })

  it('strips script tags on creation', () => {
    const ctx = createContext('<html><body><script>alert(1)</script><p>hi</p></body></html>')
    expect(ctx.$('script').length).toBe(0)
    expect(ctx.$('p').text()).toBe('hi')
  })

  it('strips style tags on creation', () => {
    const ctx = createContext('<html><head><style>body { color: red }</style></head><body><p>hi</p></body></html>')
    expect(ctx.$('style').length).toBe(0)
  })

  it('strips noscript tags on creation', () => {
    const ctx = createContext('<html><body><noscript>nope</noscript><p>hi</p></body></html>')
    expect(ctx.$('noscript').length).toBe(0)
  })

  it('strips HTML comments on creation', () => {
    const ctx = createContext('<html><body><!-- a comment --><p>hi</p></body></html>')
    const html = ctx.$.html()
    expect(html).not.toContain('a comment')
  })

  it('accepts an existing CheerioAPI instance', async () => {
    const cheerio = await import('cheerio')
    const $ = cheerio.load('<html><body><script>x</script><p>hi</p></body></html>')
    const ctx = createContext($)
    expect(ctx.$('script').length).toBe(0)
    expect(ctx.$('p').text()).toBe('hi')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/parse && pnpm test
```

Expected: FAIL — `createContext` does not exist.

- [ ] **Step 3: Implement context.ts**

Create `packages/parse/src/context.ts`:

```ts
// ABOUTME: ParseContext creation and implicit HTML cleanup.
// ABOUTME: Strips script, style, noscript, and HTML comments before any user transforms run.

import * as cheerio from 'cheerio'
import type { CheerioAPI } from 'cheerio'
import type { ParseContext } from './pipeline'

export function createContext(input: string | CheerioAPI): ParseContext {
  const $ = typeof input === 'string' ? cheerio.load(input) : input

  // Implicit cleanup: strip elements that have zero search value.
  $('script, style, noscript').remove()

  // Remove HTML comments. Cheerio represents comments as nodes with type 'comment'.
  $('*')
    .contents()
    .filter(function () {
      return this.type === 'comment'
    })
    .remove()

  return {
    $,
    title: null,
    body: null,
    metadata: {},
  }
}
```

- [ ] **Step 4: Write the failing test for the pipeline runner**

Create `packages/parse/test/pipeline.test.ts`:

```ts
// ABOUTME: Tests for the pipeline() runner — composition, async, error coercion.
// ABOUTME: Verifies transforms execute in order and final document shape is correct.

import { describe, it, expect } from 'vitest'
import { pipeline } from '../src/pipeline'
import type { Transform } from '../src/pipeline'

describe('pipeline', () => {
  it('returns a function that produces a ParsedDocument', async () => {
    const parse = pipeline()
    const doc = await parse('<html><body><p>hi</p></body></html>')
    expect(doc).toEqual({ title: '', body: '', metadata: {} })
  })

  it('runs transforms in order', async () => {
    const order: number[] = []
    const t1: Transform = (ctx) => { order.push(1); return ctx }
    const t2: Transform = (ctx) => { order.push(2); return ctx }
    const t3: Transform = (ctx) => { order.push(3); return ctx }

    const parse = pipeline(t1, t2, t3)
    await parse('<html></html>')

    expect(order).toEqual([1, 2, 3])
  })

  it('awaits async transforms', async () => {
    const setTitle: Transform = async (ctx) => {
      await new Promise((r) => setTimeout(r, 10))
      ctx.title = 'async title'
      return ctx
    }

    const parse = pipeline(setTitle)
    const doc = await parse('<html></html>')

    expect(doc.title).toBe('async title')
  })

  it('coerces null title to empty string', async () => {
    const parse = pipeline()
    const doc = await parse('<html></html>')
    expect(doc.title).toBe('')
  })

  it('coerces null body to empty string', async () => {
    const parse = pipeline()
    const doc = await parse('<html></html>')
    expect(doc.body).toBe('')
  })

  it('passes metadata through unchanged', async () => {
    const setMeta: Transform = (ctx) => {
      ctx.metadata.foo = 'bar'
      return ctx
    }

    const parse = pipeline(setMeta)
    const doc = await parse('<html></html>')

    expect(doc.metadata).toEqual({ foo: 'bar' })
  })

  it('accepts a CheerioAPI as input', async () => {
    const cheerio = await import('cheerio')
    const $ = cheerio.load('<html><body><p>hi</p></body></html>')

    const captureText: Transform = (ctx) => {
      ctx.title = ctx.$('p').text()
      return ctx
    }

    const parse = pipeline(captureText)
    const doc = await parse($)

    expect(doc.title).toBe('hi')
  })

  it('runs implicit cleanup before user transforms', async () => {
    const checkScripts: Transform = (ctx) => {
      ctx.title = String(ctx.$('script').length)
      return ctx
    }

    const parse = pipeline(checkScripts)
    const doc = await parse('<html><body><script>x</script></body></html>')

    expect(doc.title).toBe('0')
  })
})
```

- [ ] **Step 5: Run the test to verify it fails**

```bash
pnpm test
```

Expected: FAIL — `pipeline` does not exist.

- [ ] **Step 6: Implement pipeline.ts**

Create `packages/parse/src/pipeline.ts`:

```ts
// ABOUTME: Pipeline runner and core types for the @phila/search-parse package.
// ABOUTME: Composes transforms into a callable that produces a ParsedDocument from HTML.

import type { CheerioAPI } from 'cheerio'
import { createContext } from './context'

export interface ParseContext {
  $: CheerioAPI
  title: string | null
  body: string | null
  metadata: Record<string, unknown>
}

export type Transform = (ctx: ParseContext) => ParseContext | Promise<ParseContext>

export interface ParsedDocument {
  title: string
  body: string
  metadata: Record<string, unknown>
}

export function pipeline(
  ...transforms: Transform[]
): (input: string | CheerioAPI) => Promise<ParsedDocument> {
  return async (input) => {
    let ctx = createContext(input)
    for (const transform of transforms) {
      ctx = await transform(ctx)
    }
    return {
      title: ctx.title ?? '',
      body: ctx.body ?? '',
      metadata: ctx.metadata,
    }
  }
}
```

- [ ] **Step 7: Run all tests to verify they pass**

```bash
pnpm test
```

Expected: PASS — all context and pipeline tests green.

- [ ] **Step 8: Update src/index.ts to export the public surface**

Replace `packages/parse/src/index.ts`:

```ts
// ABOUTME: Public exports for the @phila/search-parse package.
// ABOUTME: Exports pipeline runner, built-in transforms, and core types.

export { pipeline } from './pipeline'
export type { Transform, ParseContext, ParsedDocument } from './pipeline'
```

- [ ] **Step 9: Verify the package still builds**

```bash
pnpm build
```

Expected: PASS — no TypeScript errors.

- [ ] **Step 10: Commit**

```bash
git add packages/parse/src packages/parse/test
git commit -m "feat(parse): add pipeline runner with implicit cleanup"
```

---

## Task 3: extractMeta transform

**Files:**
- Create: `packages/parse/src/transforms/extract-meta.ts`
- Create: `packages/parse/test/extract-meta.test.ts`
- Modify: `packages/parse/src/index.ts`

The bulk of this transform's complexity is the blocklist and key normalization. Test those carefully.

- [ ] **Step 1: Write the failing tests for extractMeta**

Create `packages/parse/test/extract-meta.test.ts`:

```ts
// ABOUTME: Tests for extractMeta — meta tag extraction with blocklist and key normalization.
// ABOUTME: Covers default extraction, options (only/exclude/extras), and standard tag handling.

import { describe, it, expect } from 'vitest'
import { pipeline } from '../src/pipeline'
import { extractMeta } from '../src/transforms/extract-meta'

const html = (head: string) => `<html lang="en-US"><head>${head}</head><body><p>x</p></body></html>`

describe('extractMeta', () => {
  it('extracts description', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse(html('<meta name="description" content="A test page">'))
    expect(doc.metadata.description).toBe('A test page')
  })

  it('extracts og:* tags as og_*', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse(html(`
      <meta property="og:title" content="Page Title">
      <meta property="og:description" content="Page description">
      <meta property="og:url" content="https://example.com/page">
      <meta property="og:image" content="https://example.com/img.jpg">
      <meta property="og:type" content="article">
      <meta property="og:site_name" content="Example">
    `))
    expect(doc.metadata.og_title).toBe('Page Title')
    expect(doc.metadata.og_description).toBe('Page description')
    expect(doc.metadata.og_url).toBe('https://example.com/page')
    expect(doc.metadata.og_image).toBe('https://example.com/img.jpg')
    expect(doc.metadata.og_type).toBe('article')
    expect(doc.metadata.og_site_name).toBe('Example')
  })

  it('extracts article:* tags as article_*', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse(html(`
      <meta property="article:published_time" content="2026-01-01T00:00:00Z">
      <meta property="article:modified_time" content="2026-02-01T00:00:00Z">
      <meta property="article:author" content="Jane Doe">
    `))
    expect(doc.metadata.article_published_time).toBe('2026-01-01T00:00:00Z')
    expect(doc.metadata.article_modified_time).toBe('2026-02-01T00:00:00Z')
    expect(doc.metadata.article_author).toBe('Jane Doe')
  })

  it('extracts <title> as html_title', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse('<html><head><title>Page</title></head><body></body></html>')
    expect(doc.metadata.html_title).toBe('Page')
  })

  it('extracts <html lang> as language', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse(html(''))
    expect(doc.metadata.language).toBe('en-US')
  })

  it('extracts canonical URL from link[rel=canonical]', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse(html('<link rel="canonical" href="https://example.com/canonical">'))
    expect(doc.metadata.canonical_url).toBe('https://example.com/canonical')
  })

  it('falls back to og:url for canonical when no link[rel=canonical]', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse(html('<meta property="og:url" content="https://example.com/og">'))
    expect(doc.metadata.canonical_url).toBe('https://example.com/og')
  })

  it('blocks twitter:* tags by default', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse(html(`
      <meta name="twitter:title" content="Tweet Title">
      <meta name="twitter:description" content="Tweet desc">
      <meta name="twitter:image" content="https://example.com/tw.jpg">
    `))
    expect(doc.metadata.twitter_title).toBeUndefined()
    expect(doc.metadata.twitter_description).toBeUndefined()
    expect(doc.metadata.twitter_image).toBeUndefined()
  })

  it('blocks viewport, charset, and other browser hints', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse(html(`
      <meta name="viewport" content="width=device-width">
      <meta charset="utf-8">
      <meta http-equiv="X-UA-Compatible" content="IE=edge">
      <meta name="theme-color" content="#fff">
      <meta name="format-detection" content="telephone=no">
      <meta name="referrer" content="no-referrer">
    `))
    expect(doc.metadata.viewport).toBeUndefined()
    expect(doc.metadata.charset).toBeUndefined()
    expect(doc.metadata.theme_color).toBeUndefined()
    expect(doc.metadata.format_detection).toBeUndefined()
    expect(doc.metadata.referrer).toBeUndefined()
  })

  it('blocks SEO directives (robots, googlebot)', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse(html(`
      <meta name="robots" content="index,follow">
      <meta name="googlebot" content="noarchive">
    `))
    expect(doc.metadata.robots).toBeUndefined()
    expect(doc.metadata.googlebot).toBeUndefined()
  })

  it('blocks verification tags', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse(html(`
      <meta name="google-site-verification" content="abc123">
      <meta name="msvalidate.01" content="xyz">
      <meta property="fb:app_id" content="12345">
    `))
    expect(doc.metadata.google_site_verification).toBeUndefined()
    expect(doc.metadata['msvalidate.01']).toBeUndefined()
    expect(doc.metadata.fb_app_id).toBeUndefined()
  })

  it('blocks mobile app shims', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse(html(`
      <meta name="apple-mobile-web-app-capable" content="yes">
      <meta name="msapplication-TileColor" content="#fff">
      <meta name="application-name" content="App">
      <meta name="HandheldFriendly" content="True">
    `))
    expect(doc.metadata.apple_mobile_web_app_capable).toBeUndefined()
    expect(doc.metadata.msapplication_tilecolor).toBeUndefined()
    expect(doc.metadata.application_name).toBeUndefined()
    expect(doc.metadata.handheldfriendly).toBeUndefined()
  })

  it('respects only option to narrow extraction', async () => {
    const parse = pipeline(extractMeta({ only: ['description'] }))
    const doc = await parse(html(`
      <meta name="description" content="kept">
      <meta name="author" content="dropped">
      <meta property="og:title" content="dropped">
    `))
    expect(doc.metadata.description).toBe('kept')
    expect(doc.metadata.author).toBeUndefined()
    expect(doc.metadata.og_title).toBeUndefined()
  })

  it('respects exclude option to add to default exclusions', async () => {
    const parse = pipeline(extractMeta({ exclude: [/^article_/] }))
    const doc = await parse(html(`
      <meta name="description" content="kept">
      <meta property="article:published_time" content="dropped">
    `))
    expect(doc.metadata.description).toBe('kept')
    expect(doc.metadata.article_published_time).toBeUndefined()
  })

  it('respects extras option to map custom selectors', async () => {
    const parse = pipeline(extractMeta({ extras: { custom_field: 'meta[name=custom]' } }))
    const doc = await parse(html('<meta name="custom" content="custom value">'))
    expect(doc.metadata.custom_field).toBe('custom value')
  })

  it('extras are added even when only is set', async () => {
    const parse = pipeline(extractMeta({
      only: ['description'],
      extras: { custom_field: 'meta[name=custom]' },
    }))
    const doc = await parse(html(`
      <meta name="description" content="kept">
      <meta name="custom" content="extra value">
      <meta name="author" content="dropped">
    `))
    expect(doc.metadata.description).toBe('kept')
    expect(doc.metadata.custom_field).toBe('extra value')
    expect(doc.metadata.author).toBeUndefined()
  })

  it('normalizes colon-separated names to snake_case', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse(html('<meta property="og:image:alt" content="Alt text">'))
    expect(doc.metadata.og_image_alt).toBe('Alt text')
  })

  it('skips meta tags with no content attribute', async () => {
    const parse = pipeline(extractMeta())
    const doc = await parse(html('<meta name="description">'))
    expect(doc.metadata.description).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test
```

Expected: FAIL — `extractMeta` does not exist.

- [ ] **Step 3: Implement extract-meta.ts**

Create `packages/parse/src/transforms/extract-meta.ts`:

```ts
// ABOUTME: extractMeta transform — pulls meta tags, og:*, article:*, canonical, language into metadata.
// ABOUTME: Default behavior extracts everything sensible with a blocklist for browser/SEO/verification noise.

import type { Transform } from '../pipeline'

export interface ExtractMetaOptions {
  only?: string[]
  exclude?: RegExp[]
  extras?: Record<string, string>
}

const DEFAULT_EXCLUDES: RegExp[] = [
  // Browser/rendering hints
  /^viewport$/,
  /^charset$/,
  /^x_ua_compatible$/,
  /^format_detection$/,
  /^referrer$/,
  /^color_scheme$/,
  /^theme_color$/,
  // Mobile app shims
  /^apple_mobile_web_app_/,
  /^msapplication_/,
  /^mobile_web_app_capable$/,
  /^application_name$/,
  /^handheldfriendly$/,
  /^mobileoptimized$/,
  // SEO directives
  /^robots$/,
  /^googlebot$/,
  /^bingbot$/,
  // Verification
  /^google_site_verification$/,
  /^yandex_verification$/,
  /^msvalidate/,
  /^facebook_domain_verification$/,
  /^fb_app_id$/,
  /^p_domain_verify$/,
  /^norton_safeweb_site_verification$/,
  // Tooling
  /^generator$/,
  // Twitter cards (almost always duplicates of og:*)
  /^twitter_/,
]

function normalizeKey(name: string): string {
  return name.replace(/[:\-]/g, '_').toLowerCase()
}

function isBlocked(key: string, userExcludes: RegExp[]): boolean {
  for (const re of DEFAULT_EXCLUDES) {
    if (re.test(key)) return true
  }
  for (const re of userExcludes) {
    if (re.test(key)) return true
  }
  return false
}

export function extractMeta(options: ExtractMetaOptions = {}): Transform {
  const userExcludes = options.exclude ?? []
  const onlyKeys = options.only ? new Set(options.only) : null
  const extras = options.extras ?? {}

  return (ctx) => {
    const $ = ctx.$

    // Extract <meta> tags
    $('meta').each((_, el) => {
      const name = $(el).attr('name') ?? $(el).attr('property')
      const content = $(el).attr('content')
      if (!name || content === undefined) return

      const key = normalizeKey(name)
      if (onlyKeys && !onlyKeys.has(key)) return
      if (isBlocked(key, userExcludes)) return

      ctx.metadata[key] = content
    })

    // Extract <title>
    const titleText = $('title').first().text().trim()
    if (titleText) {
      const key = 'html_title'
      if (!onlyKeys || onlyKeys.has(key)) {
        if (!isBlocked(key, userExcludes)) {
          ctx.metadata[key] = titleText
        }
      }
    }

    // Extract <html lang>
    const lang = $('html').attr('lang')
    if (lang) {
      const key = 'language'
      if (!onlyKeys || onlyKeys.has(key)) {
        if (!isBlocked(key, userExcludes)) {
          ctx.metadata[key] = lang
        }
      }
    }

    // Extract canonical URL — link[rel=canonical] takes precedence over og:url
    const canonicalKey = 'canonical_url'
    if (!onlyKeys || onlyKeys.has(canonicalKey)) {
      if (!isBlocked(canonicalKey, userExcludes)) {
        const linkCanonical = $('link[rel="canonical"]').attr('href')
        if (linkCanonical) {
          ctx.metadata[canonicalKey] = linkCanonical
        } else if (ctx.metadata.og_url) {
          ctx.metadata[canonicalKey] = ctx.metadata.og_url
        }
      }
    }

    // Extras: always added, even when only is set
    for (const [key, selector] of Object.entries(extras)) {
      const el = $(selector).first()
      const content = el.attr('content') ?? el.attr('href') ?? el.text().trim()
      if (content) {
        ctx.metadata[key] = content
      }
    }

    return ctx
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test
```

Expected: PASS — all extractMeta tests green.

- [ ] **Step 5: Export extractMeta from index.ts**

Update `packages/parse/src/index.ts`:

```ts
// ABOUTME: Public exports for the @phila/search-parse package.
// ABOUTME: Exports pipeline runner, built-in transforms, and core types.

export { pipeline } from './pipeline'
export type { Transform, ParseContext, ParsedDocument } from './pipeline'
export { extractMeta } from './transforms/extract-meta'
export type { ExtractMetaOptions } from './transforms/extract-meta'
```

- [ ] **Step 6: Verify the build**

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/parse/src/transforms/extract-meta.ts packages/parse/test/extract-meta.test.ts packages/parse/src/index.ts
git commit -m "feat(parse): add extractMeta transform with blocklist and normalization"
```

---

## Task 4: extractTitle transform

**Files:**
- Create: `packages/parse/src/transforms/extract-title.ts`
- Create: `packages/parse/test/extract-title.test.ts`
- Modify: `packages/parse/src/index.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/parse/test/extract-title.test.ts`:

```ts
// ABOUTME: Tests for extractTitle — explicit selector or h1 → og_title → html_title fallback.
// ABOUTME: Covers required mode and the relationship with extractMeta-populated metadata.

import { describe, it, expect } from 'vitest'
import { pipeline } from '../src/pipeline'
import { extractMeta } from '../src/transforms/extract-meta'
import { extractTitle } from '../src/transforms/extract-title'

describe('extractTitle', () => {
  it('uses explicit selector when provided', async () => {
    const parse = pipeline(extractTitle('.page-title'))
    const doc = await parse('<html><body><h1>Wrong</h1><div class="page-title">Right</div></body></html>')
    expect(doc.title).toBe('Right')
  })

  it('with no selector, falls back to first h1', async () => {
    const parse = pipeline(extractTitle())
    const doc = await parse('<html><body><h1>From H1</h1><h1>Second</h1></body></html>')
    expect(doc.title).toBe('From H1')
  })

  it('with no selector, falls back to og_title from metadata', async () => {
    const parse = pipeline(extractMeta(), extractTitle())
    const doc = await parse('<html><head><meta property="og:title" content="From OG"></head><body></body></html>')
    expect(doc.title).toBe('From OG')
  })

  it('with no selector, falls back to html_title from metadata', async () => {
    const parse = pipeline(extractMeta(), extractTitle())
    const doc = await parse('<html><head><title>From Title Tag</title></head><body></body></html>')
    expect(doc.title).toBe('From Title Tag')
  })

  it('h1 wins over og_title and html_title', async () => {
    const parse = pipeline(extractMeta(), extractTitle())
    const doc = await parse(`
      <html>
        <head>
          <title>From Title Tag</title>
          <meta property="og:title" content="From OG">
        </head>
        <body><h1>From H1</h1></body>
      </html>
    `)
    expect(doc.title).toBe('From H1')
  })

  it('og_title wins over html_title', async () => {
    const parse = pipeline(extractMeta(), extractTitle())
    const doc = await parse(`
      <html>
        <head>
          <title>From Title Tag</title>
          <meta property="og:title" content="From OG">
        </head>
        <body></body>
      </html>
    `)
    expect(doc.title).toBe('From OG')
  })

  it('returns empty title when nothing matches', async () => {
    const parse = pipeline(extractTitle())
    const doc = await parse('<html><body></body></html>')
    expect(doc.title).toBe('')
  })

  it('throws when required: true and explicit selector matches nothing', async () => {
    const parse = pipeline(extractTitle('.does-not-exist', { required: true }))
    await expect(parse('<html><body></body></html>')).rejects.toThrow(/title/i)
  })

  it('throws when required: true and no fallback resolves', async () => {
    const parse = pipeline(extractTitle(undefined, { required: true }))
    await expect(parse('<html><body></body></html>')).rejects.toThrow(/title/i)
  })

  it('trims whitespace from extracted title', async () => {
    const parse = pipeline(extractTitle('h1'))
    const doc = await parse('<html><body><h1>   spaced out   </h1></body></html>')
    expect(doc.title).toBe('spaced out')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test
```

Expected: FAIL — `extractTitle` does not exist.

- [ ] **Step 3: Implement extract-title.ts**

Create `packages/parse/src/transforms/extract-title.ts`:

```ts
// ABOUTME: extractTitle transform — explicit selector or h1 → og_title → html_title fallback chain.
// ABOUTME: Sets ctx.title; throws in required mode when nothing resolves.

import type { Transform } from '../pipeline'

export interface ExtractTitleOptions {
  required?: boolean
}

export function extractTitle(selector?: string, options: ExtractTitleOptions = {}): Transform {
  return (ctx) => {
    let title: string | null = null

    if (selector) {
      const text = ctx.$(selector).first().text().trim()
      if (text) title = text
    } else {
      // Fallback chain: h1 → metadata.og_title → metadata.html_title
      const h1Text = ctx.$('h1').first().text().trim()
      if (h1Text) {
        title = h1Text
      } else if (typeof ctx.metadata.og_title === 'string') {
        title = ctx.metadata.og_title
      } else if (typeof ctx.metadata.html_title === 'string') {
        title = ctx.metadata.html_title
      }
    }

    if (title === null && options.required) {
      throw new Error(
        selector
          ? `extractTitle: required selector "${selector}" matched no elements`
          : 'extractTitle: required title could not be resolved (no h1, og_title, or html_title)'
      )
    }

    ctx.title = title
    return ctx
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 5: Export from index.ts**

Add to `packages/parse/src/index.ts`:

```ts
export { extractTitle } from './transforms/extract-title'
export type { ExtractTitleOptions } from './transforms/extract-title'
```

- [ ] **Step 6: Commit**

```bash
git add packages/parse/src/transforms/extract-title.ts packages/parse/test/extract-title.test.ts packages/parse/src/index.ts
git commit -m "feat(parse): add extractTitle transform with fallback chain"
```

---

## Task 5: selectContent transform

**Files:**
- Create: `packages/parse/src/transforms/select-content.ts`
- Create: `packages/parse/test/select-content.test.ts`
- Modify: `packages/parse/src/index.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/parse/test/select-content.test.ts`:

```ts
// ABOUTME: Tests for selectContent — narrows the working DOM to a subtree.
// ABOUTME: Covers narrowing behavior, missing selectors, and required mode.

import { describe, it, expect } from 'vitest'
import { pipeline } from '../src/pipeline'
import { selectContent } from '../src/transforms/select-content'
import type { Transform } from '../src/pipeline'

describe('selectContent', () => {
  const captureBody: Transform = (ctx) => {
    ctx.body = ctx.$.html()
    return ctx
  }

  it('narrows the working DOM to the selected subtree', async () => {
    const parse = pipeline(selectContent('.content'), captureBody)
    const doc = await parse(`
      <html><body>
        <nav>navigation text</nav>
        <div class="content"><p>kept</p></div>
        <footer>footer text</footer>
      </body></html>
    `)
    expect(doc.body).toContain('kept')
    expect(doc.body).not.toContain('navigation text')
    expect(doc.body).not.toContain('footer text')
  })

  it('is a no-op when selector matches nothing', async () => {
    const parse = pipeline(selectContent('.does-not-exist'), captureBody)
    const doc = await parse('<html><body><p>kept</p></body></html>')
    expect(doc.body).toContain('kept')
  })

  it('throws when required: true and selector matches nothing', async () => {
    const parse = pipeline(selectContent('.does-not-exist', { required: true }))
    await expect(parse('<html><body></body></html>')).rejects.toThrow(/selectContent/i)
  })

  it('uses the first match when selector matches multiple elements', async () => {
    const parse = pipeline(selectContent('.content'), captureBody)
    const doc = await parse(`
      <html><body>
        <div class="content"><p>first</p></div>
        <div class="content"><p>second</p></div>
      </body></html>
    `)
    expect(doc.body).toContain('first')
    expect(doc.body).not.toContain('second')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test
```

Expected: FAIL.

- [ ] **Step 3: Implement select-content.ts**

Create `packages/parse/src/transforms/select-content.ts`:

```ts
// ABOUTME: selectContent transform — narrows ctx.$ to a subtree selected by CSS selector.
// ABOUTME: Subsequent content transforms operate within the narrowed scope.

import * as cheerio from 'cheerio'
import type { Transform } from '../pipeline'

export interface SelectContentOptions {
  required?: boolean
}

export function selectContent(selector: string, options: SelectContentOptions = {}): Transform {
  return (ctx) => {
    const matched = ctx.$(selector).first()
    if (matched.length === 0) {
      if (options.required) {
        throw new Error(`selectContent: required selector "${selector}" matched no elements`)
      }
      return ctx
    }

    const html = ctx.$.html(matched)
    ctx.$ = cheerio.load(html)
    return ctx
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 5: Export from index.ts**

Add to `packages/parse/src/index.ts`:

```ts
export { selectContent } from './transforms/select-content'
export type { SelectContentOptions } from './transforms/select-content'
```

- [ ] **Step 6: Commit**

```bash
git add packages/parse/src/transforms/select-content.ts packages/parse/test/select-content.test.ts packages/parse/src/index.ts
git commit -m "feat(parse): add selectContent transform"
```

---

## Task 6: remove and unwrap transforms

**Files:**
- Create: `packages/parse/src/transforms/remove.ts`
- Create: `packages/parse/src/transforms/unwrap.ts`
- Create: `packages/parse/test/remove.test.ts`
- Create: `packages/parse/test/unwrap.test.ts`
- Modify: `packages/parse/src/index.ts`

These two are simple enough to bundle in one task.

- [ ] **Step 1: Write the failing tests for remove**

Create `packages/parse/test/remove.test.ts`:

```ts
// ABOUTME: Tests for remove transform — strips elements matching CSS selectors.
// ABOUTME: Covers single selector, multiple selectors, and missing selectors.

import { describe, it, expect } from 'vitest'
import { pipeline } from '../src/pipeline'
import { remove } from '../src/transforms/remove'
import type { Transform } from '../src/pipeline'

const captureBody: Transform = (ctx) => {
  ctx.body = ctx.$.html()
  return ctx
}

describe('remove', () => {
  it('removes elements matching a single selector', async () => {
    const parse = pipeline(remove('nav'), captureBody)
    const doc = await parse('<html><body><nav>menu</nav><p>content</p></body></html>')
    expect(doc.body).not.toContain('menu')
    expect(doc.body).toContain('content')
  })

  it('removes elements matching multiple selectors', async () => {
    const parse = pipeline(remove('nav', 'footer', '.sidebar'), captureBody)
    const doc = await parse(`
      <html><body>
        <nav>menu</nav>
        <p>content</p>
        <div class="sidebar">side</div>
        <footer>foot</footer>
      </body></html>
    `)
    expect(doc.body).not.toContain('menu')
    expect(doc.body).not.toContain('side')
    expect(doc.body).not.toContain('foot')
    expect(doc.body).toContain('content')
  })

  it('is a no-op when no selectors match', async () => {
    const parse = pipeline(remove('.does-not-exist'), captureBody)
    const doc = await parse('<html><body><p>content</p></body></html>')
    expect(doc.body).toContain('content')
  })
})
```

- [ ] **Step 2: Write the failing tests for unwrap**

Create `packages/parse/test/unwrap.test.ts`:

```ts
// ABOUTME: Tests for unwrap transform — removes wrapper elements but keeps their children.
// ABOUTME: Covers single selector, nested unwrapping, and missing selectors.

import { describe, it, expect } from 'vitest'
import { pipeline } from '../src/pipeline'
import { unwrap } from '../src/transforms/unwrap'
import type { Transform } from '../src/pipeline'

const captureBody: Transform = (ctx) => {
  ctx.body = ctx.$.html()
  return ctx
}

describe('unwrap', () => {
  it('removes the wrapper element but keeps children', async () => {
    const parse = pipeline(unwrap('span'), captureBody)
    const doc = await parse('<html><body><p>hello <span>world</span></p></body></html>')
    expect(doc.body).toContain('hello world')
    expect(doc.body).not.toContain('<span>')
  })

  it('handles multiple selectors', async () => {
    const parse = pipeline(unwrap('span', 'em'), captureBody)
    const doc = await parse('<html><body><p>a <span>b</span> <em>c</em></p></body></html>')
    expect(doc.body).not.toContain('<span>')
    expect(doc.body).not.toContain('<em>')
    expect(doc.body).toContain('a b c')
  })

  it('is a no-op when no selectors match', async () => {
    const parse = pipeline(unwrap('.does-not-exist'), captureBody)
    const doc = await parse('<html><body><p>content</p></body></html>')
    expect(doc.body).toContain('content')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
pnpm test
```

Expected: FAIL.

- [ ] **Step 4: Implement remove.ts**

Create `packages/parse/src/transforms/remove.ts`:

```ts
// ABOUTME: remove transform — strips elements matching one or more CSS selectors.
// ABOUTME: Mutates ctx.$ in place. Idempotent and lenient when selectors match nothing.

import type { Transform } from '../pipeline'

export function remove(...selectors: string[]): Transform {
  return (ctx) => {
    for (const selector of selectors) {
      ctx.$(selector).remove()
    }
    return ctx
  }
}
```

- [ ] **Step 5: Implement unwrap.ts**

Create `packages/parse/src/transforms/unwrap.ts`:

```ts
// ABOUTME: unwrap transform — removes wrapper elements but keeps their children in place.
// ABOUTME: Useful for stripping presentational span/div/font tags without losing text content.

import type { Transform } from '../pipeline'

export function unwrap(...selectors: string[]): Transform {
  return (ctx) => {
    for (const selector of selectors) {
      ctx.$(selector).each((_, el) => {
        const $el = ctx.$(el)
        $el.replaceWith($el.contents())
      })
    }
    return ctx
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 7: Export from index.ts**

Add to `packages/parse/src/index.ts`:

```ts
export { remove } from './transforms/remove'
export { unwrap } from './transforms/unwrap'
```

- [ ] **Step 8: Commit**

```bash
git add packages/parse/src/transforms/remove.ts packages/parse/src/transforms/unwrap.ts packages/parse/test/remove.test.ts packages/parse/test/unwrap.test.ts packages/parse/src/index.ts
git commit -m "feat(parse): add remove and unwrap transforms"
```

---

## Task 7: cleanWhitespace transform

**Files:**
- Create: `packages/parse/src/transforms/clean-whitespace.ts`
- Create: `packages/parse/test/clean-whitespace.test.ts`
- Modify: `packages/parse/src/index.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/parse/test/clean-whitespace.test.ts`:

```ts
// ABOUTME: Tests for cleanWhitespace transform — normalizes whitespace in text nodes.
// ABOUTME: Collapses runs of whitespace and unicode whitespace characters to single spaces.

import { describe, it, expect } from 'vitest'
import { pipeline } from '../src/pipeline'
import { cleanWhitespace } from '../src/transforms/clean-whitespace'
import type { Transform } from '../src/pipeline'

const captureBody: Transform = (ctx) => {
  ctx.body = ctx.$('p').text()
  return ctx
}

describe('cleanWhitespace', () => {
  it('collapses runs of spaces to a single space', async () => {
    const parse = pipeline(cleanWhitespace(), captureBody)
    const doc = await parse('<html><body><p>hello    world</p></body></html>')
    expect(doc.body).toBe('hello world')
  })

  it('collapses tabs and newlines', async () => {
    const parse = pipeline(cleanWhitespace(), captureBody)
    const doc = await parse('<html><body><p>hello\t\n   world</p></body></html>')
    expect(doc.body).toBe('hello world')
  })

  it('normalizes unicode whitespace (nbsp, zero-width space)', async () => {
    const parse = pipeline(cleanWhitespace(), captureBody)
    const doc = await parse('<html><body><p>hello\u00A0world\u200Bagain</p></body></html>')
    expect(doc.body).toBe('hello world again')
  })

  it('trims leading and trailing whitespace from text nodes', async () => {
    const parse = pipeline(cleanWhitespace(), captureBody)
    const doc = await parse('<html><body><p>   hello world   </p></body></html>')
    expect(doc.body).toBe('hello world')
  })

  it('preserves spaces between inline siblings (anchor mid-sentence)', async () => {
    const parse = pipeline(cleanWhitespace(), captureBody)
    const doc = await parse('<html><body><p>Please <a href="/x">click here</a> to continue.</p></body></html>')
    expect(doc.body).toBe('Please click here to continue.')
  })

  it('preserves spaces between inline siblings (strong and em)', async () => {
    const parse = pipeline(cleanWhitespace(), captureBody)
    const doc = await parse('<html><body><p><strong>bold</strong> and <em>italic</em></p></body></html>')
    expect(doc.body).toBe('bold and italic')
  })

  it('collapses but does not strip whitespace-only text between siblings', async () => {
    const parse = pipeline(cleanWhitespace(), captureBody)
    const doc = await parse('<html><body><p><span>a</span>   <span>b</span></p></body></html>')
    expect(doc.body).toBe('a b')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test
```

Expected: FAIL.

- [ ] **Step 3: Implement clean-whitespace.ts**

Create `packages/parse/src/transforms/clean-whitespace.ts`:

```ts
// ABOUTME: cleanWhitespace transform — normalizes whitespace in text nodes.
// ABOUTME: Collapses runs of whitespace and unicode whitespace to single spaces.

import type { Transform } from '../pipeline'

// Matches runs of any unicode whitespace, including tabs, newlines, nbsp, zero-width space, etc.
const WHITESPACE_RUN = /[\s\u00A0\u200B\u200C\u200D\uFEFF]+/g

export function cleanWhitespace(): Transform {
  return (ctx) => {
    ctx.$('*')
      .contents()
      .filter(function () {
        return this.type === 'text'
      })
      .each(function () {
        // Cheerio text nodes have data, prev, and next properties.
        // Only trim text nodes that are sole children of their parent;
        // text nodes with siblings preserve their whitespace runs (collapsed to single space)
        // so spaces between inline siblings like <a>, <strong>, <em> are not lost.
        const node = this as unknown as { data: string; prev: unknown; next: unknown }
        const collapsed = node.data.replace(WHITESPACE_RUN, ' ')
        if (node.prev === null && node.next === null) {
          node.data = collapsed.trim()
        } else {
          node.data = collapsed
        }
      })
    return ctx
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 5: Export from index.ts**

Add to `packages/parse/src/index.ts`:

```ts
export { cleanWhitespace } from './transforms/clean-whitespace'
```

- [ ] **Step 6: Commit**

```bash
git add packages/parse/src/transforms/clean-whitespace.ts packages/parse/test/clean-whitespace.test.ts packages/parse/src/index.ts
git commit -m "feat(parse): add cleanWhitespace transform"
```

---

## Task 8: toMarkdown transform

**Files:**
- Create: `packages/parse/src/markdown.ts`
- Create: `packages/parse/src/transforms/to-markdown.ts`
- Create: `packages/parse/test/to-markdown.test.ts`
- Modify: `packages/parse/src/index.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/parse/test/to-markdown.test.ts`:

```ts
// ABOUTME: Tests for toMarkdown transform — terminal step that serializes the working DOM to markdown.
// ABOUTME: Verifies headings, lists, links, table support, and empty paragraph stripping.

import { describe, it, expect } from 'vitest'
import { pipeline } from '../src/pipeline'
import { toMarkdown } from '../src/transforms/to-markdown'

describe('toMarkdown', () => {
  it('converts h1 to ATX heading', async () => {
    const parse = pipeline(toMarkdown())
    const doc = await parse('<html><body><h1>Heading</h1></body></html>')
    expect(doc.body).toContain('# Heading')
  })

  it('converts h2 and h3', async () => {
    const parse = pipeline(toMarkdown())
    const doc = await parse('<html><body><h2>Two</h2><h3>Three</h3></body></html>')
    expect(doc.body).toContain('## Two')
    expect(doc.body).toContain('### Three')
  })

  it('converts unordered lists with dash bullets', async () => {
    const parse = pipeline(toMarkdown())
    const doc = await parse('<html><body><ul><li>one</li><li>two</li></ul></body></html>')
    expect(doc.body).toContain('- one')
    expect(doc.body).toContain('- two')
  })

  it('converts ordered lists', async () => {
    const parse = pipeline(toMarkdown())
    const doc = await parse('<html><body><ol><li>first</li><li>second</li></ol></body></html>')
    expect(doc.body).toContain('1. first')
    expect(doc.body).toContain('2. second')
  })

  it('converts links with inline style', async () => {
    const parse = pipeline(toMarkdown())
    const doc = await parse('<html><body><p>see <a href="https://example.com">example</a></p></body></html>')
    expect(doc.body).toContain('[example](https://example.com)')
  })

  it('converts strong and em', async () => {
    const parse = pipeline(toMarkdown())
    const doc = await parse('<html><body><p><strong>bold</strong> and <em>italic</em></p></body></html>')
    expect(doc.body).toContain('**bold**')
    expect(doc.body).toContain('_italic_')
  })

  it('converts GFM tables', async () => {
    const parse = pipeline(toMarkdown())
    const doc = await parse(`
      <html><body>
        <table>
          <thead><tr><th>Col1</th><th>Col2</th></tr></thead>
          <tbody><tr><td>A</td><td>B</td></tr></tbody>
        </table>
      </body></html>
    `)
    expect(doc.body).toContain('| Col1')
    expect(doc.body).toContain('| Col2')
    expect(doc.body).toContain('| A')
    expect(doc.body).toContain('| B')
  })

  it('strips empty paragraphs', async () => {
    const parse = pipeline(toMarkdown())
    const doc = await parse('<html><body><p>kept</p><p></p><p>   </p></body></html>')
    // Should have "kept" but no orphan blank lines from empty paragraphs
    expect(doc.body).toContain('kept')
    // The body should not have more than two consecutive newlines from the empties
    expect(doc.body).not.toMatch(/\n\n\n\n/)
  })

  it('sets ctx.body and the final document body matches', async () => {
    const parse = pipeline(toMarkdown())
    const doc = await parse('<html><body><h1>Title</h1><p>para</p></body></html>')
    expect(doc.body).toContain('# Title')
    expect(doc.body).toContain('para')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test
```

Expected: FAIL.

- [ ] **Step 3: Implement markdown.ts**

Create `packages/parse/src/markdown.ts`:

```ts
// ABOUTME: Turndown configuration for HTML→markdown conversion.
// ABOUTME: Adds GFM extensions (tables, strikethrough) and a custom rule to strip empty paragraphs.

import TurndownService from 'turndown'
// @ts-ignore — turndown-plugin-gfm has no types
import { gfm } from 'turndown-plugin-gfm'

export function createTurndown(options: TurndownService.Options = {}): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    linkStyle: 'inlined',
    emDelimiter: '_',
    ...options,
  })

  td.use(gfm)

  // Custom rule: strip empty paragraphs (turndown has no built-in option for this).
  td.addRule('strip-empty-paragraphs', {
    filter: (node) => {
      return node.nodeName === 'P' && node.textContent?.trim() === ''
    },
    replacement: () => '',
  })

  return td
}
```

- [ ] **Step 4: Implement to-markdown.ts**

Create `packages/parse/src/transforms/to-markdown.ts`:

```ts
// ABOUTME: toMarkdown transform — terminal step that serializes the working DOM to markdown.
// ABOUTME: Sets ctx.body using turndown with GFM and empty-paragraph stripping.

import type TurndownService from 'turndown'
import type { Transform } from '../pipeline'
import { createTurndown } from '../markdown'

export function toMarkdown(options: TurndownService.Options = {}): Transform {
  const td = createTurndown(options)
  return (ctx) => {
    const html = ctx.$.html()
    ctx.body = td.turndown(html).trim()
    return ctx
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 6: Export from index.ts**

Add to `packages/parse/src/index.ts`:

```ts
export { toMarkdown } from './transforms/to-markdown'
```

- [ ] **Step 7: Commit**

```bash
git add packages/parse/src/markdown.ts packages/parse/src/transforms/to-markdown.ts packages/parse/test/to-markdown.test.ts packages/parse/src/index.ts
git commit -m "feat(parse): add toMarkdown transform with GFM and empty-paragraph stripping"
```

---

## Task 9: injectIntoBody transform

**Files:**
- Create: `packages/parse/src/transforms/inject-into-body.ts`
- Create: `packages/parse/test/inject-into-body.test.ts`
- Modify: `packages/parse/src/index.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/parse/test/inject-into-body.test.ts`:

```ts
// ABOUTME: Tests for injectIntoBody transform — injects metadata fields as paragraphs into the working DOM.
// ABOUTME: Used pre-toMarkdown to add publisher descriptions or other metadata into the embedded body.

import { describe, it, expect } from 'vitest'
import { pipeline } from '../src/pipeline'
import { extractMeta } from '../src/transforms/extract-meta'
import { injectIntoBody } from '../src/transforms/inject-into-body'
import { toMarkdown } from '../src/transforms/to-markdown'

describe('injectIntoBody', () => {
  it('prepends metadata field as a paragraph', async () => {
    const parse = pipeline(
      extractMeta(),
      injectIntoBody({ from: 'description', position: 'prepend' }),
      toMarkdown(),
    )
    const doc = await parse(`
      <html>
        <head><meta name="description" content="A great summary"></head>
        <body><p>Original content</p></body>
      </html>
    `)
    const lines = doc.body.split('\n').filter((l) => l.trim())
    expect(lines[0]).toContain('A great summary')
    expect(doc.body).toContain('Original content')
  })

  it('appends metadata field as a paragraph', async () => {
    const parse = pipeline(
      extractMeta(),
      injectIntoBody({ from: 'description', position: 'append' }),
      toMarkdown(),
    )
    const doc = await parse(`
      <html>
        <head><meta name="description" content="Footer summary"></head>
        <body><p>Original content</p></body>
      </html>
    `)
    const lines = doc.body.split('\n').filter((l) => l.trim())
    expect(lines[lines.length - 1]).toContain('Footer summary')
    expect(doc.body).toContain('Original content')
  })

  it('is a no-op when metadata field is missing', async () => {
    const parse = pipeline(
      injectIntoBody({ from: 'description', position: 'prepend' }),
      toMarkdown(),
    )
    const doc = await parse('<html><body><p>Original content</p></body></html>')
    expect(doc.body).toContain('Original content')
    expect(doc.body).not.toContain('description')
  })

  it('is a no-op when metadata field is empty string', async () => {
    const parse = pipeline(
      extractMeta(),
      injectIntoBody({ from: 'description', position: 'prepend' }),
      toMarkdown(),
    )
    const doc = await parse(`
      <html>
        <head><meta name="description" content=""></head>
        <body><p>Original content</p></body>
      </html>
    `)
    expect(doc.body).toContain('Original content')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test
```

Expected: FAIL.

- [ ] **Step 3: Implement inject-into-body.ts**

Create `packages/parse/src/transforms/inject-into-body.ts`:

```ts
// ABOUTME: injectIntoBody transform — injects a metadata field as a paragraph into the working DOM.
// ABOUTME: Wraps the value in a <p> so it survives markdown conversion as a standalone paragraph.

import type { Transform } from '../pipeline'

export interface InjectIntoBodyOptions {
  from: string
  position: 'prepend' | 'append'
}

export function injectIntoBody(options: InjectIntoBodyOptions): Transform {
  return (ctx) => {
    const value = ctx.metadata[options.from]
    if (typeof value !== 'string' || value.trim() === '') {
      return ctx
    }

    const escaped = ctx.$('<p></p>').text(value)
    const root = ctx.$.root()
    if (options.position === 'prepend') {
      root.prepend(escaped)
    } else {
      root.append(escaped)
    }
    return ctx
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 5: Export from index.ts**

Add to `packages/parse/src/index.ts`:

```ts
export { injectIntoBody } from './transforms/inject-into-body'
export type { InjectIntoBodyOptions } from './transforms/inject-into-body'
```

- [ ] **Step 6: Commit**

```bash
git add packages/parse/src/transforms/inject-into-body.ts packages/parse/test/inject-into-body.test.ts packages/parse/src/index.ts
git commit -m "feat(parse): add injectIntoBody transform"
```

---

## Task 10: End-to-end test with cached phila.gov fixture

**Files:**
- Create: `packages/parse/test/fixtures/phila-pay-water-bill.html`
- Create: `packages/parse/test/e2e.test.ts`

This test runs the full pipeline against a real phila.gov page (cached as a fixture) to validate the library matches what we expect for our actual corpus.

- [ ] **Step 1: Save the cached HTML fixture**

The HTML for `https://www.phila.gov/services/water-gas-utilities/pay-or-dispute-a-water-bill/pay-a-water-bill/` is already at `/tmp/phila-leaf.html` from earlier exploration. Copy it to the test fixtures directory:

```bash
mkdir -p packages/parse/test/fixtures
cp /tmp/phila-leaf.html packages/parse/test/fixtures/phila-pay-water-bill.html
```

If `/tmp/phila-leaf.html` is gone, refetch:

```bash
curl -sL -A "Mozilla/5.0" 'https://www.phila.gov/services/water-gas-utilities/pay-or-dispute-a-water-bill/pay-a-water-bill/' > packages/parse/test/fixtures/phila-pay-water-bill.html
```

- [ ] **Step 2: Write the e2e test**

Create `packages/parse/test/e2e.test.ts`:

```ts
// ABOUTME: End-to-end test of the full pipeline against a cached phila.gov page fixture.
// ABOUTME: Validates that the library produces the expected ParsedDocument shape for real-world HTML.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  pipeline,
  extractMeta,
  extractTitle,
  selectContent,
  remove,
  cleanWhitespace,
  toMarkdown,
} from '../src'

describe('e2e: full pipeline against phila.gov fixture', () => {
  const html = readFileSync(join(__dirname, 'fixtures/phila-pay-water-bill.html'), 'utf-8')

  const parsePhilaService = pipeline(
    extractMeta(),
    extractTitle('.entry-header h2'),
    remove('.breadcrumbs', '.related-content'),
    selectContent('.entry-content'),
    cleanWhitespace(),
    toMarkdown(),
  )

  it('extracts the correct title', async () => {
    const doc = await parsePhilaService(html)
    expect(doc.title).toBe('Pay a water bill')
  })

  it('extracts standard metadata', async () => {
    const doc = await parsePhilaService(html)
    expect(doc.metadata.description).toBe('Instructions and fees for accessing and paying your water and sewer services bill.')
    expect(doc.metadata.og_title).toBe('Pay a water bill | Services')
    expect(doc.metadata.og_description).toBe('Instructions and fees for accessing and paying your water and sewer services bill.')
    expect(doc.metadata.og_type).toBe('website')
    expect(doc.metadata.og_site_name).toBe('City of Philadelphia')
    expect(doc.metadata.canonical_url).toBe('https://www.phila.gov/services/water-gas-utilities/pay-or-dispute-a-water-bill/pay-a-water-bill/')
  })

  it('blocks twitter:* metadata', async () => {
    const doc = await parsePhilaService(html)
    expect(doc.metadata.twitter_title).toBeUndefined()
    expect(doc.metadata.twitter_description).toBeUndefined()
    expect(doc.metadata.twitter_image).toBeUndefined()
  })

  it('produces markdown body with headings and lists', async () => {
    const doc = await parsePhilaService(html)
    expect(doc.body.length).toBeGreaterThan(500)
    expect(doc.body).toMatch(/##\s+/)        // at least one heading
    expect(doc.body).toMatch(/^-\s+/m)       // at least one list item
  })

  it('does not contain navigation, breadcrumbs, or footer text', async () => {
    const doc = await parsePhilaService(html)
    expect(doc.body).not.toContain('Skip to main content')
    expect(doc.body).not.toContain('Elected officials')
    expect(doc.body).not.toContain('Open government')
  })

  it('preserves the substantive content', async () => {
    const doc = await parsePhilaService(html)
    // Content known to be on the page
    expect(doc.body.toLowerCase()).toContain('water bill')
    expect(doc.body.toLowerCase()).toMatch(/echeck|automatic bank/)
  })
})
```

- [ ] **Step 3: Run the test**

```bash
pnpm test
```

Expected: PASS — all e2e assertions green. If any fail, inspect the parsed output and adjust either the test expectations (if the page content changed) or the pipeline (if the library is misbehaving).

- [ ] **Step 4: Commit**

```bash
git add packages/parse/test/fixtures packages/parse/test/e2e.test.ts
git commit -m "test(parse): add e2e test against cached phila.gov fixture"
```

---

## Task 11: Update apps/api e2e test to use the new library

**Files:**
- Modify: `apps/api/package.json`
- Modify: `apps/api/test/e2e-hybrid-search.test.ts`

The existing e2e test at `apps/api/test/e2e-hybrid-search.test.ts` has an inlined `parseServicePage()` function. Replace it with the new library.

- [ ] **Step 1: Add @phila/search-parse as a dev dependency**

```bash
cd apps/api && pnpm add -D @phila/search-parse@workspace:* && cd ../..
```

Expected: pnpm adds the workspace dependency.

- [ ] **Step 2: Modify apps/api/test/e2e-hybrid-search.test.ts**

Replace the inlined parser. Find these lines (around lines 11-22):

```ts
import { createBedrockAdapter } from '@phila/search-embeddings'
import { parse } from 'node-html-parser'
import type { Pool } from 'pg'
import type { EmbeddingAdapter } from '@phila/search-embeddings'

function parseServicePage(html: string): { title: string; body: string } {
  const root = parse(html)
  const title = root.querySelector('.entry-header h2')?.textContent?.trim()
    || root.querySelector('title')?.textContent?.trim()
    || ''
  const body = root.querySelector('.entry-content')?.textContent?.trim() || ''
  return { title, body }
}
```

Replace with:

```ts
import { createBedrockAdapter } from '@phila/search-embeddings'
import {
  pipeline,
  extractMeta,
  extractTitle,
  selectContent,
  remove,
  cleanWhitespace,
  toMarkdown,
} from '@phila/search-parse'
import type { Pool } from 'pg'
import type { EmbeddingAdapter } from '@phila/search-embeddings'

const parsePhilaService = pipeline(
  extractMeta(),
  extractTitle('.entry-header h2'),
  remove('.breadcrumbs', '.related-content'),
  selectContent('.entry-content'),
  cleanWhitespace(),
  toMarkdown(),
)
```

- [ ] **Step 3: Replace the call site**

In the same file, find this block (around lines 100-115):

```ts
      let html: string
      try {
        html = await fetchPage(url)
      } catch (err: any) {
        console.log(`  Skipping ${slug} (fetch failed: ${err.message})`)
        continue
      }
      const parsed = parseServicePage(html)
```

Replace with:

```ts
      let html: string
      try {
        html = await fetchPage(url)
      } catch (err: any) {
        console.log(`  Skipping ${slug} (fetch failed: ${err.message})`)
        continue
      }
      const parsed = await parsePhilaService(html)
```

- [ ] **Step 4: Pass metadata through to the API call**

In the same file, find:

```ts
      const result = await ingestDocument(pool, indexId, adapter, {
        external_id: slug,
        title: parsed.title,
        body: parsed.body,
        metadata: { source_url: url },
      })
```

Replace with:

```ts
      const result = await ingestDocument(pool, indexId, adapter, {
        external_id: slug,
        title: parsed.title,
        body: parsed.body,
        metadata: { ...parsed.metadata, source_url: url },
      })
```

- [ ] **Step 5: Remove the now-unused node-html-parser dependency**

```bash
cd apps/api && pnpm remove node-html-parser && cd ../..
```

Expected: pnpm removes it from `apps/api/package.json`.

- [ ] **Step 6: Run the e2e test to verify it still passes**

```bash
cd apps/api && AWS_PROFILE=OpenSearchDev pnpm test test/e2e-hybrid-search.test.ts && cd ../..
```

Expected: PASS — all 15 tests still pass. The pipeline now produces markdown body content instead of plain text, so chunk counts and snippets may differ from the previous run, but search relevance assertions should still hold.

If a test fails because markdown content tokenizes differently than the prior plaintext, that's expected and acceptable — the test assertions check for substring matches like "water" and "permit" which should survive markdown conversion.

- [ ] **Step 7: Commit**

```bash
git add apps/api/test/e2e-hybrid-search.test.ts apps/api/package.json pnpm-lock.yaml
git commit -m "refactor(api): use @phila/search-parse in e2e test"
```

---

## Task 12: Delete the old @phila/search-ingest package

**Files:**
- Delete: `packages/ingest/` (entire directory)
- Modify: `package.json` (root)

- [ ] **Step 1: Verify nothing imports @phila/search-ingest**

```bash
grep -rn "@phila/search-ingest" --include="*.ts" --include="*.json" --include="*.md" .
```

Expected: no matches in `apps/`, `packages/parse/`, or `cdk/`. Matches in `docs/` (planning documents) are fine — those reference the old package by name in historical context.

If any code still imports it, fix the imports before proceeding.

- [ ] **Step 2: Delete the directory**

```bash
rm -rf packages/ingest
```

- [ ] **Step 3: Update root package.json test script**

In the root `package.json`, find the `test` script:

```json
"test": "pnpm -r --filter './apps/*' --filter './packages/embeddings' --filter './packages/client' --filter './packages/ingest' test",
```

Replace with:

```json
"test": "pnpm -r --filter './apps/*' --filter './packages/embeddings' --filter './packages/client' --filter './packages/parse' test",
```

- [ ] **Step 4: Reinstall to update lockfile**

```bash
pnpm install
```

Expected: pnpm-lock.yaml updates to remove the deleted package.

- [ ] **Step 5: Run all tests to make sure nothing is broken**

```bash
pnpm test
```

Expected: All tests pass across all packages.

Note: The e2e test in `apps/api/test/e2e-hybrid-search.test.ts` requires `AWS_PROFILE=OpenSearchDev` and a running Postgres on port 5433. If those aren't available, that test will fail — but the unit tests for `@phila/search-parse` and other packages should all pass independently.

For a more reliable check that excludes the e2e:

```bash
pnpm -r --filter './packages/parse' test
pnpm -r --filter './packages/embeddings' test
pnpm -r --filter './packages/client' test
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove dead @phila/search-ingest package"
```

---

## Task 13: Final integration sanity check

**Files:**
- None (verification only)

- [ ] **Step 1: Run the full test suite**

```bash
docker compose -f docker-compose.test.yml up -d
AWS_PROFILE=OpenSearchDev pnpm test
```

Expected: All tests across all packages pass, including the apps/api e2e against Bedrock.

- [ ] **Step 2: Check the final state of the repository**

```bash
git status
git log --oneline main..HEAD
```

Expected: clean working tree, with one commit per task above (~13 commits total).

- [ ] **Step 3: Verify package structure is correct**

```bash
ls packages/parse/src/transforms/
```

Expected output:
```
clean-whitespace.ts
extract-meta.ts
extract-title.ts
inject-into-body.ts
remove.ts
select-content.ts
to-markdown.ts
unwrap.ts
```

- [ ] **Step 4: Verify the package exports are complete**

Read `packages/parse/src/index.ts` and confirm it exports:
- `pipeline`
- Types: `Transform`, `ParseContext`, `ParsedDocument`
- All 8 transforms: `extractMeta`, `extractTitle`, `selectContent`, `remove`, `unwrap`, `cleanWhitespace`, `injectIntoBody`, `toMarkdown`
- Option types: `ExtractMetaOptions`, `ExtractTitleOptions`, `SelectContentOptions`, `InjectIntoBodyOptions`

If anything is missing, add it and create a follow-up commit.

---

## Done

The library is built, tested, integrated into the e2e test, and the dead package is removed. The next obvious follow-up (not in this plan) is to write actual ingestion scripts using Crawlee + `@phila/search-parse` to populate a production search index.
