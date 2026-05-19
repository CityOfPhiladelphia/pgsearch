# RAG Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a synchronous RAG endpoint atop the existing hybrid search pipeline, with first-class per-index prompt entities, a pluggable LLM adapter, and a lazy-minted RAG key separate from search/index credentials.

**Architecture:** Layer cleanly on top of existing search. New `packages/llm` (LlmAdapter interface + Bedrock implementation) mirrors `packages/embeddings`. Shared `packages/bedrock-client` memoizes Bedrock SDK clients across both adapters. New `rag_prompts` table holds full prompt assemblies (system text, model, generation params, retrieval params) as JSONB. New `rag_key_hash` column on `search_indexes` gates the RAG endpoint, minted lazily via admin. `hybridSearch` gains a `maxChunksPerDoc` option (collapsing the implicit best-segment-per-doc dedup into an explicit count) so RAG can pull multiple segments per source.

**Tech Stack:** TypeScript, Hono, PostgreSQL, AWS Bedrock (Messages API for Claude), Vitest, esbuild.

**Spec:** `docs/superpowers/specs/2026-05-18-rag-endpoint-design.md`

---

## File Structure

### New files

| Path | Purpose |
|------|---------|
| `packages/bedrock-client/package.json` | Workspace package manifest |
| `packages/bedrock-client/tsconfig.json` | TS config matching siblings |
| `packages/bedrock-client/src/index.ts` | `getBedrockClient(region)` memoized factory |
| `packages/llm/package.json` | Workspace package manifest |
| `packages/llm/tsconfig.json` | TS config matching siblings |
| `packages/llm/src/index.ts` | Barrel exports |
| `packages/llm/src/adapter.ts` | `LlmAdapter` interface and types |
| `packages/llm/src/bedrock.ts` | `createBedrockLlmAdapter` for Claude via Messages API |
| `packages/llm/src/test.ts` | Deterministic `createTestLlmAdapter` for integration tests |
| `packages/llm/test/bedrock.test.ts` | Unit tests for request/response shaping (SDK boundary mocked) |
| `packages/llm/test/test-adapter.test.ts` | Tests for the deterministic test adapter |
| `apps/api/services/llm-adapter.ts` | Factory: maps prompt content → LlmAdapter |
| `apps/api/services/prompts.ts` | Prompt CRUD service |
| `apps/api/services/rag.ts` | RAG pipeline orchestration |
| `apps/api/routes/prompts.ts` | `/public/index/:name/prompts` CRUD routes |
| `apps/api/routes/rag.ts` | `POST /public/rag/:name` route |
| `apps/api/test/prompts.test.ts` | Prompt CRUD service tests |
| `apps/api/test/rag.test.ts` | RAG service integration tests |
| `apps/api/test/llm-adapter.test.ts` | Adapter factory tests |
| `apps/api/dev/rag.html` | Browser-based dev tool, sibling to `search.html` |
| `docs/rag.md` | User-facing RAG documentation |

### Modified files

| Path | Change |
|------|--------|
| `pnpm-workspace.yaml` | No change — `packages/*` glob already covers new packages |
| `apps/api/package.json` | Add `@phila/llm` and `@phila/bedrock-client` workspace deps |
| `packages/embeddings/package.json` | Add `@phila/bedrock-client` workspace dep |
| `packages/embeddings/src/bedrock.ts` | Use shared `getBedrockClient` instead of inline lazy import |
| `apps/api/db/migrations.ts` | Add migration v2 (rag_key_hash column + rag_prompts table) |
| `apps/api/types.ts` | Add `RagPrompt`, `PromptContent`, `RagRequest`, `RagResponse`, `Citation`, `RetrievedRef` types |
| `apps/api/services/search.ts` | Add `maxChunksPerDoc` to `HybridSearchOptions`; replace `bestByDoc` block with per-doc cap |
| `apps/api/services/indexes.ts` | Add `mintRagKey`, `revokeRagKey`, update `rowToIndex` for `rag_key_hash` field |
| `apps/api/middleware/auth.ts` | Add `ragAuth` middleware |
| `apps/api/routes/admin.ts` | Add `POST` / `DELETE` for `/:name/rag-key` |
| `apps/api/index.ts` | Add `x-rag-key` to CORS `allowHeaders`; mount `promptsRoutes` and `ragRoutes` |
| `apps/api/test/setup.ts` | Add `rag_prompts` to teardown/cleanup |
| `apps/api/test/routes.test.ts` | Add wiring tests for prompt CRUD and RAG routes |
| `apps/api/test/indexes.test.ts` | Add tests for `mintRagKey` / `revokeRagKey` |
| `apps/api/test/search.test.ts` | Add `maxChunksPerDoc` tests |
| `apps/api/test/schema.test.ts` | Add assertions for new column + table |
| `docs/architecture.md` | Add RAG section after Embedding Strategy |
| `README.md` | Add RAG to key concepts + docs table |

### Boundaries

- `packages/bedrock-client` — sole responsibility: lazy + memoized SDK client per region.
- `packages/llm` — sole responsibility: synthesis. Knows nothing about pgsearch's domain.
- `apps/api/services/rag.ts` — sole responsibility: orchestrate retrieve → render context → call LLM → parse citations → assemble response. No HTTP, no DB queries beyond delegating to `hybridSearch` and `prompts`.
- `apps/api/services/prompts.ts` — sole responsibility: CRUD against `rag_prompts`. No HTTP, no LLM.

---

## Task 1: Extract `packages/bedrock-client`

Pull the lazy Bedrock SDK client into a shared package. Refactor the embedding adapter to use it. This proves the abstraction works before we add a second consumer.

**Files:**
- Create: `packages/bedrock-client/package.json`
- Create: `packages/bedrock-client/tsconfig.json`
- Create: `packages/bedrock-client/src/index.ts`
- Modify: `packages/embeddings/package.json` (add dep)
- Modify: `packages/embeddings/src/bedrock.ts`

- [ ] **Step 1: Create `packages/bedrock-client/package.json`**

```json
{
  "name": "@phila/bedrock-client",
  "version": "0.0.1",
  "private": true,
  "main": "src/index.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "vitest": "^3.1.0"
  }
}
```

- [ ] **Step 2: Create `packages/bedrock-client/tsconfig.json`**

Mirror `packages/embeddings/tsconfig.json`:

```bash
cp packages/embeddings/tsconfig.json packages/bedrock-client/tsconfig.json
```

- [ ] **Step 3: Create `packages/bedrock-client/src/index.ts`**

```typescript
// ABOUTME: Lazy-loaded, region-memoized AWS Bedrock runtime client.
// ABOUTME: Shared by embedding and LLM adapters to avoid duplicate SDK clients per call.

const clients = new Map<string, any>()
let invokeModelCommand: any = null

export interface BedrockClientHandle {
  client: any
  InvokeModelCommand: any
}

export async function getBedrockClient(region: string = 'us-east-1'): Promise<BedrockClientHandle> {
  if (!clients.has(region)) {
    // @ts-ignore — SDK is available at runtime in Lambda, not at build time
    const sdk = await import('@aws-sdk/client-bedrock-runtime')
    if (!invokeModelCommand) {
      invokeModelCommand = sdk.InvokeModelCommand
    }
    clients.set(region, new sdk.BedrockRuntimeClient({ region }))
  }
  return { client: clients.get(region), InvokeModelCommand: invokeModelCommand }
}
```

- [ ] **Step 4: Add dep to `packages/embeddings/package.json`**

Add a `dependencies` block (the file currently has only `devDependencies`):

```json
"dependencies": {
  "@phila/bedrock-client": "workspace:*"
},
```

Place before `devDependencies`.

- [ ] **Step 5: Refactor `packages/embeddings/src/bedrock.ts`**

Replace the entire file:

```typescript
// ABOUTME: AWS Bedrock embedding adapter for production vector generation.
// ABOUTME: Calls Bedrock InvokeModel API for text embedding.

import { getBedrockClient } from '@phila/bedrock-client'
import type { EmbeddingAdapter } from './adapter'

export interface BedrockAdapterConfig {
  model: string
  dimensions: number
  region?: string
}

export function createBedrockAdapter(config: BedrockAdapterConfig): EmbeddingAdapter {
  return {
    model: config.model,
    dimensions: config.dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      const { client, InvokeModelCommand } = await getBedrockClient(config.region)
      const results: number[][] = []
      for (const text of texts) {
        const response = await client.send(new InvokeModelCommand({
          modelId: config.model,
          contentType: 'application/json',
          body: JSON.stringify({
            inputText: text,
            dimensions: config.dimensions,
            normalize: true,
          }),
        }))
        const body = JSON.parse(new TextDecoder().decode(response.body))
        results.push(body.embedding)
      }
      return results
    },
  }
}
```

- [ ] **Step 6: Install and verify nothing is broken**

Run: `pnpm install`
Expected: workspace links resolve, no errors.

Run: `pnpm test -- --run`
Expected: all existing tests pass (the embedding adapter behavior is unchanged).

- [ ] **Step 7: Commit**

```bash
git add packages/bedrock-client packages/embeddings/package.json packages/embeddings/src/bedrock.ts pnpm-lock.yaml
git commit -m "refactor: extract @phila/bedrock-client for shared lazy SDK client"
```

---

## Task 2: Create `packages/llm` with adapter interface + test adapter

TDD the deterministic test adapter first — it's the contract every adapter must satisfy and gives downstream tests a reliable double.

**Files:**
- Create: `packages/llm/package.json`
- Create: `packages/llm/tsconfig.json`
- Create: `packages/llm/src/adapter.ts`
- Create: `packages/llm/src/test.ts`
- Create: `packages/llm/src/index.ts`
- Create: `packages/llm/test/test-adapter.test.ts`

- [ ] **Step 1: Create `packages/llm/package.json`**

```json
{
  "name": "@phila/llm",
  "version": "0.0.1",
  "private": true,
  "main": "src/index.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@phila/bedrock-client": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "vitest": "^3.1.0"
  }
}
```

- [ ] **Step 2: Create `packages/llm/tsconfig.json`**

```bash
cp packages/embeddings/tsconfig.json packages/llm/tsconfig.json
```

- [ ] **Step 3: Create `packages/llm/src/adapter.ts`**

```typescript
// ABOUTME: LLM adapter interface for pluggable text synthesis.
// ABOUTME: Implementations call a chat-completion model and return text + token usage.

export interface LlmMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface LlmCompleteInput {
  system: string
  messages: LlmMessage[]
  max_tokens: number
  temperature: number
}

export interface LlmCompleteResult {
  text: string
  usage: { input_tokens: number; output_tokens: number }
  model: string
}

export interface LlmAdapter {
  model: string
  complete(input: LlmCompleteInput): Promise<LlmCompleteResult>
}
```

- [ ] **Step 4: Create `packages/llm/src/index.ts`**

```typescript
// ABOUTME: LLM adapter package exports.
// ABOUTME: Provides adapter interface, implementations, and factory.

export type {
  LlmAdapter,
  LlmMessage,
  LlmCompleteInput,
  LlmCompleteResult,
} from './adapter'
export { createTestLlmAdapter } from './test'
export { createBedrockLlmAdapter } from './bedrock'
```

(`bedrock.ts` will be added in Task 3; the export here lets us write the test adapter first without touching this file twice.)

- [ ] **Step 5: Write failing tests for the test adapter**

Create `packages/llm/test/test-adapter.test.ts`:

```typescript
// ABOUTME: Tests for the deterministic test LLM adapter.
// ABOUTME: Ensures it produces stable, identifiable output for integration tests.

import { describe, it, expect } from 'vitest'
import { createTestLlmAdapter } from '../src/test'

describe('createTestLlmAdapter', () => {
  it('echoes the latest user message prefixed with [test]', async () => {
    const adapter = createTestLlmAdapter()
    const result = await adapter.complete({
      system: 'be terse',
      messages: [{ role: 'user', content: 'hello world' }],
      max_tokens: 100,
      temperature: 0,
    })
    expect(result.text).toBe('[test] hello world')
  })

  it('reports token usage as character counts of system + last message and output', async () => {
    const adapter = createTestLlmAdapter()
    const result = await adapter.complete({
      system: 'sys',
      messages: [{ role: 'user', content: 'q' }],
      max_tokens: 10,
      temperature: 0,
    })
    expect(result.usage.input_tokens).toBe(4) // "sys" (3) + "q" (1)
    expect(result.usage.output_tokens).toBe(result.text.length)
  })

  it('uses the latest user message even with prior turns', async () => {
    const adapter = createTestLlmAdapter()
    const result = await adapter.complete({
      system: '',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
      max_tokens: 100,
      temperature: 0,
    })
    expect(result.text).toBe('[test] second')
  })

  it('emits citation-friendly output when asked to', async () => {
    const adapter = createTestLlmAdapter({ withCitations: [1, 2] })
    const result = await adapter.complete({
      system: '',
      messages: [{ role: 'user', content: 'q' }],
      max_tokens: 100,
      temperature: 0,
    })
    expect(result.text).toContain('[1]')
    expect(result.text).toContain('[2]')
  })

  it('reports a stable model identifier', async () => {
    const adapter = createTestLlmAdapter()
    expect(adapter.model).toBe('test-llm')
    const result = await adapter.complete({
      system: '', messages: [{ role: 'user', content: 'q' }], max_tokens: 1, temperature: 0,
    })
    expect(result.model).toBe('test-llm')
  })
})
```

- [ ] **Step 6: Run to verify failure**

Run: `pnpm --filter @phila/llm test`
Expected: FAIL — `src/test.ts` does not exist.

- [ ] **Step 7: Implement `packages/llm/src/test.ts`**

```typescript
// ABOUTME: Deterministic test LLM adapter for integration testing.
// ABOUTME: Echoes the latest user message and optionally appends citation markers.

import type { LlmAdapter, LlmCompleteInput, LlmCompleteResult } from './adapter'

export interface TestAdapterOptions {
  withCitations?: number[]
}

export function createTestLlmAdapter(options: TestAdapterOptions = {}): LlmAdapter {
  return {
    model: 'test-llm',
    async complete(input: LlmCompleteInput): Promise<LlmCompleteResult> {
      const latestUser = [...input.messages].reverse().find(m => m.role === 'user')
      const userText = latestUser ? latestUser.content : ''
      let text = `[test] ${userText}`
      if (options.withCitations) {
        text += ' ' + options.withCitations.map(n => `[${n}]`).join(' ')
      }
      return {
        text,
        usage: {
          input_tokens: input.system.length + userText.length,
          output_tokens: text.length,
        },
        model: 'test-llm',
      }
    },
  }
}
```

- [ ] **Step 8: Run tests to verify pass**

Run: `pnpm --filter @phila/llm test`
Expected: 5 tests pass. (Note: the bedrock import in `index.ts` will throw at module load — fix in Task 3. For now, create `packages/llm/src/bedrock.ts` as a stub so the import resolves:

```typescript
// ABOUTME: Bedrock LLM adapter stub — full implementation in next task.
// ABOUTME: Exists to satisfy the index.ts barrel export during early tests.
export function createBedrockLlmAdapter(_config: { model: string }) {
  throw new Error('createBedrockLlmAdapter: implemented in Task 3')
}
```

Re-run tests; they should pass.)

- [ ] **Step 9: Commit**

```bash
git add packages/llm pnpm-lock.yaml
git commit -m "feat: add @phila/llm package with adapter interface and test double"
```

---

## Task 3: Implement `BedrockLlmAdapter` (Claude via Messages API)

Real adapter for Claude on Bedrock. Test by mocking the SDK client at the boundary.

**Files:**
- Modify: `packages/llm/src/bedrock.ts`
- Create: `packages/llm/test/bedrock.test.ts`

- [ ] **Step 1: Write failing tests for the Bedrock adapter**

Create `packages/llm/test/bedrock.test.ts`:

```typescript
// ABOUTME: Tests for the Bedrock LLM adapter request and response shaping.
// ABOUTME: Mocks the Bedrock SDK client at the @phila/bedrock-client boundary.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendMock = vi.fn()

vi.mock('@phila/bedrock-client', () => ({
  getBedrockClient: vi.fn(async () => ({
    client: { send: sendMock },
    InvokeModelCommand: vi.fn((input) => ({ __input: input })),
  })),
}))

import { createBedrockLlmAdapter } from '../src/bedrock'

function encodeResponseBody(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj))
}

describe('createBedrockLlmAdapter', () => {
  beforeEach(() => { sendMock.mockReset() })

  it('sends Anthropic Messages API request shape', async () => {
    sendMock.mockResolvedValueOnce({
      body: encodeResponseBody({
        content: [{ type: 'text', text: 'hello' }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    })

    const adapter = createBedrockLlmAdapter({ model: 'anthropic.claude-haiku-4-5' })
    await adapter.complete({
      system: 'you are terse',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
      temperature: 0.2,
    })

    expect(sendMock).toHaveBeenCalledTimes(1)
    const sentCommand = sendMock.mock.calls[0][0]
    const body = JSON.parse(sentCommand.__input.body)
    expect(sentCommand.__input.modelId).toBe('anthropic.claude-haiku-4-5')
    expect(body.anthropic_version).toBe('bedrock-2023-05-31')
    expect(body.system).toBe('you are terse')
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(body.max_tokens).toBe(100)
    expect(body.temperature).toBe(0.2)
  })

  it('parses text content and usage from response', async () => {
    sendMock.mockResolvedValueOnce({
      body: encodeResponseBody({
        content: [{ type: 'text', text: 'hello world' }],
        usage: { input_tokens: 12, output_tokens: 3 },
      }),
    })

    const adapter = createBedrockLlmAdapter({ model: 'anthropic.claude-haiku-4-5' })
    const result = await adapter.complete({
      system: '', messages: [{ role: 'user', content: 'q' }], max_tokens: 10, temperature: 0,
    })

    expect(result.text).toBe('hello world')
    expect(result.usage).toEqual({ input_tokens: 12, output_tokens: 3 })
    expect(result.model).toBe('anthropic.claude-haiku-4-5')
  })

  it('concatenates multiple text content blocks', async () => {
    sendMock.mockResolvedValueOnce({
      body: encodeResponseBody({
        content: [
          { type: 'text', text: 'part one ' },
          { type: 'text', text: 'part two' },
        ],
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    })

    const adapter = createBedrockLlmAdapter({ model: 'anthropic.claude-haiku-4-5' })
    const result = await adapter.complete({
      system: '', messages: [{ role: 'user', content: 'q' }], max_tokens: 10, temperature: 0,
    })

    expect(result.text).toBe('part one part two')
  })

  it('rejects non-anthropic model IDs with a clear error', async () => {
    const adapter = createBedrockLlmAdapter({ model: 'amazon.titan-text-v1' })
    await expect(adapter.complete({
      system: '', messages: [{ role: 'user', content: 'q' }], max_tokens: 10, temperature: 0,
    })).rejects.toThrow(/only anthropic\..*/i)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @phila/llm test bedrock`
Expected: FAIL — `createBedrockLlmAdapter` is the stub.

- [ ] **Step 3: Implement `packages/llm/src/bedrock.ts`**

Replace the stub:

```typescript
// ABOUTME: AWS Bedrock LLM adapter for Claude via the Anthropic Messages API.
// ABOUTME: Other model families (Titan, Llama) require their own adapter; not implemented.

import { getBedrockClient } from '@phila/bedrock-client'
import type { LlmAdapter, LlmCompleteInput, LlmCompleteResult } from './adapter'

export interface BedrockLlmConfig {
  model: string
  region?: string
}

export function createBedrockLlmAdapter(config: BedrockLlmConfig): LlmAdapter {
  return {
    model: config.model,
    async complete(input: LlmCompleteInput): Promise<LlmCompleteResult> {
      if (!config.model.startsWith('anthropic.')) {
        throw new Error(
          `BedrockLlmAdapter currently supports only anthropic.* models; got '${config.model}'`
        )
      }

      const { client, InvokeModelCommand } = await getBedrockClient(config.region)

      const response = await client.send(new InvokeModelCommand({
        modelId: config.model,
        contentType: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          system: input.system,
          messages: input.messages,
          max_tokens: input.max_tokens,
          temperature: input.temperature,
        }),
      }))

      const body = JSON.parse(new TextDecoder().decode(response.body))

      const text = (body.content || [])
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('')

      return {
        text,
        usage: {
          input_tokens: body.usage?.input_tokens ?? 0,
          output_tokens: body.usage?.output_tokens ?? 0,
        },
        model: config.model,
      }
    },
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @phila/llm test`
Expected: all tests pass (test adapter + bedrock adapter).

- [ ] **Step 5: Commit**

```bash
git add packages/llm/src/bedrock.ts packages/llm/test/bedrock.test.ts
git commit -m "feat: implement BedrockLlmAdapter for Claude via Messages API"
```

---

## Task 4: Database migration (rag_key_hash + rag_prompts)

Add the schema. Migration v2 is additive and idempotent.

**Files:**
- Modify: `apps/api/db/migrations.ts`
- Modify: `apps/api/db/schema.sql` (kept in sync as reference)
- Modify: `apps/api/test/setup.ts`
- Modify: `apps/api/test/schema.test.ts`

- [ ] **Step 1: Write failing schema assertions**

In `apps/api/test/schema.test.ts`, add (or extend an existing `describe`) — assert presence of new column and table. If the file doesn't have a similar assertion block, add:

```typescript
describe('migration v2 — rag', () => {
  it('adds rag_key_hash column to search_indexes', async () => {
    const pool = await getTestPool()
    const result = await pool.query(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'search_indexes' AND column_name = 'rag_key_hash'
    `)
    expect(result.rows.length).toBe(1)
    expect(result.rows[0].is_nullable).toBe('YES')
  })

  it('creates rag_prompts table with expected columns', async () => {
    const pool = await getTestPool()
    const result = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'rag_prompts'
      ORDER BY ordinal_position
    `)
    const columns = result.rows.map(r => r.column_name)
    expect(columns).toEqual(expect.arrayContaining([
      'prompt_id', 'index_id', 'name', 'content', 'created_at', 'updated_at',
    ]))
  })

  it('enforces unique (index_id, name) on rag_prompts', async () => {
    const pool = await getTestPool()
    const result = await pool.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'rag_prompts' AND indexdef LIKE '%UNIQUE%(index_id, name)%'
    `)
    expect(result.rows.length).toBeGreaterThan(0)
  })
})
```

If `schema.test.ts` already has top-level `beforeAll`/`afterAll` boilerplate, fit the new describe in alongside the existing blocks.

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --filter api test schema`
Expected: FAIL — column and table do not exist.

- [ ] **Step 3: Add migration v2 to `apps/api/db/migrations.ts`**

Append to the `migrations` array:

```typescript
  {
    version: 2,
    description: 'RAG: add rag_key_hash to search_indexes; create rag_prompts',
    sql: `
ALTER TABLE search_indexes
  ADD COLUMN IF NOT EXISTS rag_key_hash TEXT;

CREATE TABLE IF NOT EXISTS rag_prompts (
    prompt_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    index_id    INTEGER NOT NULL REFERENCES search_indexes(index_id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    content     JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (index_id, name)
);

CREATE INDEX IF NOT EXISTS idx_rag_prompts_index_id ON rag_prompts (index_id);
    `,
  },
```

- [ ] **Step 4: Mirror in `apps/api/db/schema.sql`** (if it exists as a reference dump; otherwise skip — check first with `cat apps/api/db/schema.sql | head -20`)

If present, add the same `ALTER` and `CREATE TABLE` at the bottom so the standalone schema file stays in sync.

- [ ] **Step 5: Update `apps/api/test/setup.ts`**

In `teardownSchema`, add `rag_prompts` to the drop list (place before `search_indexes` since it has the FK):

```typescript
await p.query('DROP TABLE IF EXISTS rag_prompts CASCADE')
```

In `cleanupTestData`, add (before the `DELETE FROM search_indexes`):

```typescript
await p.query('DELETE FROM rag_prompts')
```

- [ ] **Step 6: Run tests to verify pass**

Run: `pnpm --filter api test schema`
Expected: PASS.

Run: `pnpm --filter api test indexes`
Expected: existing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add apps/api/db/migrations.ts apps/api/db/schema.sql apps/api/test/setup.ts apps/api/test/schema.test.ts
git commit -m "feat(db): add rag_key_hash column and rag_prompts table"
```

---

## Task 5: Add types for RAG entities

Centralize the type definitions so the rest of the work compiles cleanly.

**Files:**
- Modify: `apps/api/types.ts`

- [ ] **Step 1: Extend `apps/api/types.ts`**

Append at the end:

```typescript
export interface PromptRetrievalConfig {
  mode: 'hybrid' | 'bm25' | 'semantic'
  limit: number
  max_chunks_per_doc: number
  min_bm25_score: number
  min_vector_score: number
}

export interface PromptContent {
  system: string
  response_format: string
  model: string
  max_tokens: number
  temperature: number
  retrieval: PromptRetrievalConfig
}

export interface RagPrompt {
  prompt_id: string
  index_id: number
  name: string
  content: PromptContent
  created_at: string
  updated_at: string
}

export interface RagRequest {
  question: string
  messages?: { role: 'user' | 'assistant'; content: string }[]
}

export interface Citation {
  marker: number
  external_id: string
  title: string
  url: string
  snippet: string
}

export interface RetrievedRef {
  external_id: string
  score: number
  used: boolean
}

export interface RagResponse {
  answer: string
  citations: Citation[]
  retrieved: RetrievedRef[]
  model: string
  prompt: string
  usage: { input_tokens: number; output_tokens: number }
  history_sig: string | null
}
```

Also extend `SearchIndex` to include the new column:

```typescript
// In the SearchIndex interface, after search_key_hash:
rag_key_hash: string | null
```

- [ ] **Step 2: Verify TS compiles**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/types.ts
git commit -m "feat(types): add RAG entity types (prompt, citation, response)"
```

---

## Task 6: Prompt CRUD service

Pure data layer. No HTTP.

**Files:**
- Create: `apps/api/services/prompts.ts`
- Create: `apps/api/test/prompts.test.ts`

- [ ] **Step 1: Write failing prompt CRUD tests**

Create `apps/api/test/prompts.test.ts`:

```typescript
// ABOUTME: Tests for the RAG prompt CRUD service.
// ABOUTME: Verifies create / read / list / update / delete and uniqueness behavior.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import type { Pool } from 'pg'
import { getTestPool, setupSchema, teardownSchema, cleanupTestData, closePool } from './setup'
import { createIndex } from '../services/indexes'
import { createPrompt, getPrompt, listPrompts, updatePrompt, deletePrompt } from '../services/prompts'
import type { PromptContent } from '../types'

const sampleContent: PromptContent = {
  system: 'You are a helpful assistant.',
  response_format: 'Cite sources as [N].',
  model: 'anthropic.claude-haiku-4-5',
  max_tokens: 1024,
  temperature: 0.2,
  retrieval: {
    mode: 'hybrid',
    limit: 8,
    max_chunks_per_doc: 3,
    min_bm25_score: 0,
    min_vector_score: 0,
  },
}

describe('prompts service', () => {
  let pool: Pool
  let indexId: number

  beforeAll(async () => {
    await setupSchema()
    pool = await getTestPool()
  })
  afterAll(async () => { await teardownSchema(); await closePool() })
  afterEach(async () => { await cleanupTestData() })

  beforeEach(async () => {
    await createIndex(pool, { name: 'test-idx' })
    const row = await pool.query('SELECT index_id FROM search_indexes WHERE name = $1', ['test-idx'])
    indexId = row.rows[0].index_id
  })

  it('creates and reads a prompt', async () => {
    const created = await createPrompt(pool, indexId, 'navigator', sampleContent)
    expect(created.name).toBe('navigator')
    expect(created.content.model).toBe('anthropic.claude-haiku-4-5')

    const read = await getPrompt(pool, indexId, 'navigator')
    expect(read).not.toBeNull()
    expect(read!.content.system).toBe(sampleContent.system)
  })

  it('returns null for a missing prompt', async () => {
    const read = await getPrompt(pool, indexId, 'does-not-exist')
    expect(read).toBeNull()
  })

  it('lists prompts for an index', async () => {
    await createPrompt(pool, indexId, 'a', sampleContent)
    await createPrompt(pool, indexId, 'b', sampleContent)
    const list = await listPrompts(pool, indexId)
    expect(list.length).toBe(2)
    expect(list.map(p => p.name).sort()).toEqual(['a', 'b'])
  })

  it('enforces unique (index_id, name)', async () => {
    await createPrompt(pool, indexId, 'dupe', sampleContent)
    await expect(createPrompt(pool, indexId, 'dupe', sampleContent)).rejects.toThrow()
  })

  it('updates a prompt content', async () => {
    await createPrompt(pool, indexId, 'p', sampleContent)
    const updated = { ...sampleContent, temperature: 0.7 }
    await updatePrompt(pool, indexId, 'p', updated)
    const read = await getPrompt(pool, indexId, 'p')
    expect(read!.content.temperature).toBe(0.7)
  })

  it('deletes a prompt', async () => {
    await createPrompt(pool, indexId, 'gone', sampleContent)
    await deletePrompt(pool, indexId, 'gone')
    const read = await getPrompt(pool, indexId, 'gone')
    expect(read).toBeNull()
  })
})
```

Note: requires adding `beforeEach` to the vitest import.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter api test prompts`
Expected: FAIL — `services/prompts` does not exist.

- [ ] **Step 3: Implement `apps/api/services/prompts.ts`**

```typescript
// ABOUTME: CRUD operations for per-index RAG prompts stored in rag_prompts.
// ABOUTME: Prompt content is JSONB so future composition (extends, includes) is additive.

import type { Pool } from 'pg'
import type { RagPrompt, PromptContent } from '../types'

function rowToPrompt(row: any): RagPrompt {
  return {
    prompt_id: row.prompt_id,
    index_id: row.index_id,
    name: row.name,
    content: typeof row.content === 'string' ? JSON.parse(row.content) : row.content,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

export async function createPrompt(
  pool: Pool,
  indexId: number,
  name: string,
  content: PromptContent,
): Promise<RagPrompt> {
  const result = await pool.query(
    `INSERT INTO rag_prompts (index_id, name, content)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [indexId, name, JSON.stringify(content)],
  )
  return rowToPrompt(result.rows[0])
}

export async function getPrompt(
  pool: Pool,
  indexId: number,
  name: string,
): Promise<RagPrompt | null> {
  const result = await pool.query(
    `SELECT * FROM rag_prompts WHERE index_id = $1 AND name = $2`,
    [indexId, name],
  )
  if (result.rows.length === 0) return null
  return rowToPrompt(result.rows[0])
}

export async function listPrompts(pool: Pool, indexId: number): Promise<RagPrompt[]> {
  const result = await pool.query(
    `SELECT * FROM rag_prompts WHERE index_id = $1 ORDER BY name`,
    [indexId],
  )
  return result.rows.map(rowToPrompt)
}

export async function updatePrompt(
  pool: Pool,
  indexId: number,
  name: string,
  content: PromptContent,
): Promise<void> {
  const result = await pool.query(
    `UPDATE rag_prompts
     SET content = $1, updated_at = NOW()
     WHERE index_id = $2 AND name = $3`,
    [JSON.stringify(content), indexId, name],
  )
  if (result.rowCount === 0) {
    throw new Error(`Prompt '${name}' not found`)
  }
}

export async function deletePrompt(pool: Pool, indexId: number, name: string): Promise<void> {
  const result = await pool.query(
    `DELETE FROM rag_prompts WHERE index_id = $1 AND name = $2`,
    [indexId, name],
  )
  if (result.rowCount === 0) {
    throw new Error(`Prompt '${name}' not found`)
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter api test prompts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/services/prompts.ts apps/api/test/prompts.test.ts
git commit -m "feat: add prompt CRUD service for rag_prompts"
```

---

## Task 7: Prompt CRUD routes

HTTP layer wrapping the service. Auth: `x-index-key`.

**Files:**
- Create: `apps/api/routes/prompts.ts`
- Modify: `apps/api/index.ts`
- Modify: `apps/api/test/routes.test.ts`

- [ ] **Step 1: Write failing wiring test for prompt routes**

Before pasting, open `apps/api/test/routes.test.ts` and confirm the existing top-level `const app = new Hono()` and import block — the snippet below adds a sibling `promptsApp` and new `Hono` import as a second-instance pattern. Merge imports cleanly rather than duplicating.

Add to `apps/api/test/routes.test.ts` after the existing `search route wiring` describe:

```typescript
import { promptsRoutes } from '../routes/prompts'

const promptsApp = new Hono()
promptsApp.route('/', promptsRoutes)

describe('prompt route wiring', () => {
  it('mounts POST /public/index/:name/prompts behind indexAuth', async () => {
    const res = await promptsApp.request('/public/index/any-index/prompts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'p', content: {} }),
    })
    expect(res.status).toBe(401)
  })

  it('mounts GET /public/index/:name/prompts behind indexAuth', async () => {
    const res = await promptsApp.request('/public/index/any-index/prompts')
    expect(res.status).toBe(401)
  })

  it('mounts GET /public/index/:name/prompts/:promptName behind indexAuth', async () => {
    const res = await promptsApp.request('/public/index/any-index/prompts/foo')
    expect(res.status).toBe(401)
  })

  it('mounts PATCH /public/index/:name/prompts/:promptName behind indexAuth', async () => {
    const res = await promptsApp.request('/public/index/any-index/prompts/foo', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: {} }),
    })
    expect(res.status).toBe(401)
  })

  it('mounts DELETE /public/index/:name/prompts/:promptName behind indexAuth', async () => {
    const res = await promptsApp.request('/public/index/any-index/prompts/foo', { method: 'DELETE' })
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter api test routes`
Expected: FAIL — `routes/prompts` does not exist.

- [ ] **Step 3: Implement `apps/api/routes/prompts.ts`**

```typescript
// ABOUTME: Prompt CRUD routes for per-index RAG prompts.
// ABOUTME: Gated by x-index-key — the team owning the index owns its prompts.

import { Hono } from 'hono'
import { indexAuth } from '../middleware/auth'
import { apiError } from '../middleware/error'
import { getPool } from '../db/pool'
import {
  createPrompt,
  getPrompt,
  listPrompts,
  updatePrompt,
  deletePrompt,
} from '../services/prompts'
import type { AppEnv, PromptContent } from '../types'

export const promptsRoutes = new Hono<AppEnv>()
promptsRoutes.use('/public/index/:name/prompts', indexAuth)
promptsRoutes.use('/public/index/:name/prompts/*', indexAuth)

function validateContent(c: any): { ok: true; content: PromptContent } | { ok: false; message: string } {
  if (!c || typeof c !== 'object') return { ok: false, message: 'content must be an object' }
  const required: (keyof PromptContent)[] = ['system', 'response_format', 'model', 'max_tokens', 'temperature', 'retrieval']
  for (const key of required) {
    if (!(key in c)) return { ok: false, message: `content.${key} is required` }
  }
  if (typeof c.system !== 'string') return { ok: false, message: 'content.system must be a string' }
  if (typeof c.model !== 'string') return { ok: false, message: 'content.model must be a string' }
  if (typeof c.max_tokens !== 'number') return { ok: false, message: 'content.max_tokens must be a number' }
  if (typeof c.temperature !== 'number') return { ok: false, message: 'content.temperature must be a number' }
  if (!c.retrieval || typeof c.retrieval !== 'object') return { ok: false, message: 'content.retrieval must be an object' }
  const r = c.retrieval
  const validModes = ['hybrid', 'bm25', 'semantic']
  if (!validModes.includes(r.mode)) {
    return { ok: false, message: `content.retrieval.mode must be one of: ${validModes.join(', ')}` }
  }
  if (typeof r.limit !== 'number' || r.limit < 1) {
    return { ok: false, message: 'content.retrieval.limit must be a positive number' }
  }
  if (typeof r.max_chunks_per_doc !== 'number' || r.max_chunks_per_doc < 1) {
    return { ok: false, message: 'content.retrieval.max_chunks_per_doc must be >= 1' }
  }
  if (typeof r.min_bm25_score !== 'number' || typeof r.min_vector_score !== 'number') {
    return { ok: false, message: 'content.retrieval.min_bm25_score and min_vector_score must be numbers' }
  }
  return { ok: true, content: c as PromptContent }
}

promptsRoutes.post('/public/index/:name/prompts', async (c) => {
  const body = await c.req.json()
  if (!body.name || typeof body.name !== 'string') {
    return apiError(c, 'VALIDATION_ERROR', 'Missing required field: name (string)')
  }
  const v = validateContent(body.content)
  if (!v.ok) return apiError(c, 'VALIDATION_ERROR', v.message)

  const index = c.get('index')
  const pool = await getPool()
  try {
    const created = await createPrompt(pool, index.index_id, body.name, v.content)
    return c.json(created, 201)
  } catch (err: any) {
    if (err.code === '23505') {
      return apiError(c, 'VALIDATION_ERROR', `Prompt '${body.name}' already exists`)
    }
    throw err
  }
})

promptsRoutes.get('/public/index/:name/prompts', async (c) => {
  const index = c.get('index')
  const pool = await getPool()
  const list = await listPrompts(pool, index.index_id)
  return c.json(list)
})

promptsRoutes.get('/public/index/:name/prompts/:promptName', async (c) => {
  const promptName = c.req.param('promptName')
  const index = c.get('index')
  const pool = await getPool()
  const prompt = await getPrompt(pool, index.index_id, promptName)
  if (!prompt) return apiError(c, 'NOT_FOUND', `Prompt '${promptName}' not found`)
  return c.json(prompt)
})

promptsRoutes.patch('/public/index/:name/prompts/:promptName', async (c) => {
  const promptName = c.req.param('promptName')
  const body = await c.req.json()
  const v = validateContent(body.content)
  if (!v.ok) return apiError(c, 'VALIDATION_ERROR', v.message)

  const index = c.get('index')
  const pool = await getPool()
  try {
    await updatePrompt(pool, index.index_id, promptName, v.content)
  } catch (err: any) {
    if (err.message?.includes('not found')) {
      return apiError(c, 'NOT_FOUND', err.message)
    }
    throw err
  }
  const updated = await getPrompt(pool, index.index_id, promptName)
  return c.json(updated)
})

promptsRoutes.delete('/public/index/:name/prompts/:promptName', async (c) => {
  const promptName = c.req.param('promptName')
  const index = c.get('index')
  const pool = await getPool()
  try {
    await deletePrompt(pool, index.index_id, promptName)
  } catch (err: any) {
    if (err.message?.includes('not found')) {
      return apiError(c, 'NOT_FOUND', err.message)
    }
    throw err
  }
  return c.json({ deleted: true })
})
```

- [ ] **Step 4: Mount in `apps/api/index.ts`**

Add to the imports:

```typescript
import { promptsRoutes } from './routes/prompts'
```

Add after `app.route('/', searchRoutes)`:

```typescript
app.route('/', promptsRoutes)
```

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm --filter api test routes`
Expected: existing + new wiring tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/routes/prompts.ts apps/api/index.ts apps/api/test/routes.test.ts
git commit -m "feat: prompt CRUD routes under x-index-key"
```

---

## Task 8: Add `maxChunksPerDoc` to `hybridSearch`

Collapse the implicit best-segment-per-doc dedup into an explicit count. Search routes stay unchanged (default of 1 preserves current behavior).

**Files:**
- Modify: `apps/api/services/search.ts`
- Modify: `apps/api/test/search.test.ts`

- [ ] **Step 1: Write failing test**

Add to `apps/api/test/search.test.ts` (alongside existing tests):

```typescript
describe('maxChunksPerDoc', () => {
  it('defaults to 1 (best segment per document)', async () => {
    // Ingest a doc with multiple segments via existing fixtures
    // (uses whatever setup the other search tests already use)
    const results = await hybridSearch(pool, indexId, adapter, 'parking', { limit: 20 })
    const docIds = results.results.map(r => r.external_id)
    expect(new Set(docIds).size).toBe(docIds.length) // unique
  })

  it('with maxChunksPerDoc=3 returns up to 3 segments per document', async () => {
    // The exact assertion depends on fixture data — verify no doc appears more than 3 times.
    const results = await hybridSearch(pool, indexId, adapter, 'parking', {
      limit: 20, maxChunksPerDoc: 3,
    })
    const counts = new Map<string, number>()
    for (const r of results.results) {
      counts.set(r.external_id, (counts.get(r.external_id) ?? 0) + 1)
    }
    for (const [, count] of counts) {
      expect(count).toBeLessThanOrEqual(3)
    }
  })

  it('respects per-doc cap when one doc has many strong segments', async () => {
    // With cap=2, even a doc with 10 strong segments returns only 2 entries.
    const results = await hybridSearch(pool, indexId, adapter, 'parking', {
      limit: 50, maxChunksPerDoc: 2,
    })
    const counts = new Map<string, number>()
    for (const r of results.results) {
      counts.set(r.external_id, (counts.get(r.external_id) ?? 0) + 1)
    }
    for (const [, count] of counts) {
      expect(count).toBeLessThanOrEqual(2)
    }
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter api test search`
Expected: FAIL — `maxChunksPerDoc` is not on `HybridSearchOptions`.

- [ ] **Step 3: Update `HybridSearchOptions` in `apps/api/services/search.ts`**

```typescript
export interface HybridSearchOptions {
  limit?: number
  mode?: SearchMode
  minBm25Score?: number
  minVectorScore?: number
  maxChunksPerDoc?: number
}
```

- [ ] **Step 4: Replace the dedup block**

Find the block starting `// Deduplicate: keep the highest-scoring segment per document` (around line 299) through the `.slice(0, limit)` call. Replace with a per-doc cap implementation:

```typescript
  const maxChunksPerDoc = options.maxChunksPerDoc ?? 1

  // Group by document, keep top-N per doc by score
  const byDoc = new Map<string, typeof scored>()
  for (const s of scored) {
    const list = byDoc.get(s.document_id) ?? []
    list.push(s)
    byDoc.set(s.document_id, list)
  }

  const capped: typeof scored = []
  for (const [, list] of byDoc) {
    list.sort((a, b) => b.score - a.score)
    capped.push(...list.slice(0, maxChunksPerDoc))
  }

  const deduped = capped
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
```

Update the `total` calculation: it currently uses `bestByDoc.size`. Replace with `byDoc.size` (the unique document count, regardless of how many segments per doc):

```typescript
  return {
    results,
    total: byDoc.size,
    query: queryText,
  }
```

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm --filter api test search`
Expected: all PASS, including existing behavior for default `maxChunksPerDoc=1`.

- [ ] **Step 6: Run full suite**

Run: `pnpm --filter api test`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/services/search.ts apps/api/test/search.test.ts
git commit -m "feat(search): add maxChunksPerDoc option (default 1) to hybridSearch"
```

---

## Task 9: RAG key mint / revoke

Admin endpoint to lazily mint and revoke per-index RAG keys.

**Files:**
- Modify: `apps/api/services/indexes.ts`
- Modify: `apps/api/routes/admin.ts`
- Modify: `apps/api/test/indexes.test.ts`

- [ ] **Step 1: Update `rowToIndex` in `services/indexes.ts`**

The existing `rowToIndex` spreads `...row`, so the new column will pass through automatically. Just verify it's present in the returned shape by adding a regression test below.

- [ ] **Step 2: Write failing tests for mint/revoke**

Add to `apps/api/test/indexes.test.ts`:

```typescript
import { mintRagKey, revokeRagKey } from '../services/indexes'
import { verifyKey } from '../middleware/auth'

describe('RAG key management', () => {
  it('rag_key_hash is null on a freshly created index', async () => {
    await createIndex(pool, { name: 'no-rag' })
    const index = await getIndex(pool, 'no-rag')
    expect(index!.rag_key_hash).toBeNull()
  })

  it('mintRagKey returns a plaintext key and persists its hash', async () => {
    await createIndex(pool, { name: 'with-rag' })
    const result = await mintRagKey(pool, 'with-rag')
    expect(result.rag_key.startsWith('rag_')).toBe(true)

    const index = await getIndex(pool, 'with-rag')
    expect(index!.rag_key_hash).not.toBeNull()
    expect(await verifyKey(result.rag_key, index!.rag_key_hash!)).toBe(true)
  })

  it('mintRagKey rotates an existing key', async () => {
    await createIndex(pool, { name: 'rotate' })
    const first = await mintRagKey(pool, 'rotate')
    const second = await mintRagKey(pool, 'rotate')
    expect(first.rag_key).not.toBe(second.rag_key)

    const index = await getIndex(pool, 'rotate')
    expect(await verifyKey(second.rag_key, index!.rag_key_hash!)).toBe(true)
    expect(await verifyKey(first.rag_key, index!.rag_key_hash!)).toBe(false)
  })

  it('revokeRagKey nulls the hash', async () => {
    await createIndex(pool, { name: 'revoke-me' })
    await mintRagKey(pool, 'revoke-me')
    await revokeRagKey(pool, 'revoke-me')
    const index = await getIndex(pool, 'revoke-me')
    expect(index!.rag_key_hash).toBeNull()
  })

  it('mintRagKey throws for missing index', async () => {
    await expect(mintRagKey(pool, 'nope')).rejects.toThrow(/not found/i)
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter api test indexes`
Expected: FAIL — functions don't exist.

- [ ] **Step 4: Implement `mintRagKey` and `revokeRagKey` in `services/indexes.ts`**

Append to the file:

```typescript
export interface MintRagKeyResponse {
  rag_key: string
}

export async function mintRagKey(pool: Pool, name: string): Promise<MintRagKeyResponse> {
  const existing = await getIndex(pool, name)
  if (!existing) throw new Error(`Index '${name}' not found`)

  const ragKey = generateKey('rag')
  const ragKeyHash = await hashKey(ragKey)

  await pool.query(
    'UPDATE search_indexes SET rag_key_hash = $1, updated_at = NOW() WHERE name = $2',
    [ragKeyHash, name],
  )
  return { rag_key: ragKey }
}

export async function revokeRagKey(pool: Pool, name: string): Promise<void> {
  const existing = await getIndex(pool, name)
  if (!existing) throw new Error(`Index '${name}' not found`)
  await pool.query(
    'UPDATE search_indexes SET rag_key_hash = NULL, updated_at = NOW() WHERE name = $1',
    [name],
  )
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm --filter api test indexes`
Expected: all PASS.

- [ ] **Step 6: Add admin routes in `apps/api/routes/admin.ts`**

```typescript
import { mintRagKey, revokeRagKey } from '../services/indexes'

adminRoutes.post('/private/key/admin/indexes/:name/rag-key', async (c) => {
  const name = c.req.param('name')
  const pool = await getPool()
  try {
    const result = await mintRagKey(pool, name)
    return c.json(result, 201)
  } catch (err: any) {
    if (err.message?.includes('not found')) {
      return apiError(c, 'NOT_FOUND', err.message)
    }
    throw err
  }
})

adminRoutes.delete('/private/key/admin/indexes/:name/rag-key', async (c) => {
  const name = c.req.param('name')
  const pool = await getPool()
  try {
    await revokeRagKey(pool, name)
  } catch (err: any) {
    if (err.message?.includes('not found')) {
      return apiError(c, 'NOT_FOUND', err.message)
    }
    throw err
  }
  return c.json({ revoked: true })
})
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/services/indexes.ts apps/api/routes/admin.ts apps/api/test/indexes.test.ts
git commit -m "feat: lazy mint and revoke per-index RAG keys"
```

---

## Task 10: `ragAuth` middleware

Mirrors `searchAuth` but uses `x-rag-key` and rejects when `rag_key_hash` is null.

**Files:**
- Modify: `apps/api/middleware/auth.ts`
- Modify: `apps/api/test/auth.test.ts` (if it exists; check first)

- [ ] **Step 1: Append `ragAuth` to `apps/api/middleware/auth.ts`**

```typescript
export const ragAuth = createMiddleware<AppEnv>(async (c, next) => {
  const ragKey = c.req.header('x-rag-key')
  if (!ragKey) {
    return apiError(c, 'UNAUTHORIZED', 'Missing x-rag-key header')
  }
  const indexName = c.req.param('name')
  if (!indexName) {
    return apiError(c, 'VALIDATION_ERROR', 'Missing index name')
  }

  const { getIndex } = await import('../services/indexes')
  const { getPool } = await import('../db/pool')
  const pool = await getPool()
  const index = await getIndex(pool, indexName)
  if (!index) return apiError(c, 'NOT_FOUND', `Index '${indexName}' not found`)
  if (!index.rag_key_hash) {
    return apiError(c, 'UNAUTHORIZED', 'RAG is not enabled for this index')
  }
  if (!(await verifyKey(ragKey, index.rag_key_hash))) {
    return apiError(c, 'UNAUTHORIZED', 'Invalid RAG key')
  }

  c.set('index', index)
  await next()
  return
})
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/middleware/auth.ts
git commit -m "feat: add ragAuth middleware"
```

---

## Task 11: RAG service (orchestration)

Pure orchestration: retrieve → render context → call LLM → parse citations → assemble response.

**Files:**
- Create: `apps/api/services/rag.ts`
- Create: `apps/api/services/llm-adapter.ts`
- Create: `apps/api/test/rag.test.ts`
- Create: `apps/api/test/llm-adapter.test.ts`

- [ ] **Step 1: Implement `apps/api/services/llm-adapter.ts`**

```typescript
// ABOUTME: LLM adapter factory mapping PromptContent → LlmAdapter.
// ABOUTME: Throws on unsupported model prefixes; mirrors services/adapter.ts.

import type { LlmAdapter } from '@phila/llm'
import { createBedrockLlmAdapter } from '@phila/llm'
import type { PromptContent } from '../types'

export function getLlmAdapter(content: PromptContent): LlmAdapter {
  if (content.model.startsWith('anthropic.')) {
    return createBedrockLlmAdapter({ model: content.model })
  }
  throw new Error(
    `LLM model '${content.model}' is not supported. Only 'anthropic.*' models are available in this deployment.`,
  )
}
```

- [ ] **Step 2: Write failing tests for `llm-adapter`**

Create `apps/api/test/llm-adapter.test.ts`:

```typescript
// ABOUTME: Tests for the LLM adapter factory in apps/api.
// ABOUTME: Validates that supported model prefixes return adapters and others throw.

import { describe, it, expect } from 'vitest'
import { getLlmAdapter } from '../services/llm-adapter'
import type { PromptContent } from '../types'

const base: PromptContent = {
  system: '', response_format: '', model: '', max_tokens: 1, temperature: 0,
  retrieval: { mode: 'hybrid', limit: 1, max_chunks_per_doc: 1, min_bm25_score: 0, min_vector_score: 0 },
}

describe('getLlmAdapter', () => {
  it('returns a Bedrock Claude adapter for anthropic.* models', () => {
    const a = getLlmAdapter({ ...base, model: 'anthropic.claude-haiku-4-5' })
    expect(a.model).toBe('anthropic.claude-haiku-4-5')
  })

  it('throws for unsupported model prefixes', () => {
    expect(() => getLlmAdapter({ ...base, model: 'amazon.titan-text' })).toThrow(/not supported/i)
  })
})
```

Run: `pnpm --filter api test llm-adapter`
Expected: PASS (uses live code; no fixtures needed).

- [ ] **Step 3: Write failing tests for RAG service**

Create `apps/api/test/rag.test.ts`:

```typescript
// ABOUTME: Integration tests for the RAG pipeline.
// ABOUTME: Uses test embedding + LLM adapters so retrieval and synthesis are deterministic.

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import { getTestPool, setupSchema, teardownSchema, cleanupTestData, closePool } from './setup'
import { createIndex } from '../services/indexes'
import { ingestDocument } from '../services/ingest'
import { createPrompt } from '../services/prompts'
import { runRag } from '../services/rag'
import { createTestAdapter } from '@phila/search-embeddings'
import { createTestLlmAdapter } from '@phila/llm'
import type { PromptContent } from '../types'

const promptContent: PromptContent = {
  system: 'You are helpful.',
  response_format: 'Cite [N].',
  model: 'anthropic.claude-haiku-4-5',
  max_tokens: 256,
  temperature: 0,
  retrieval: { mode: 'hybrid', limit: 4, max_chunks_per_doc: 2, min_bm25_score: 0, min_vector_score: 0 },
}

describe('runRag', () => {
  let pool: Pool
  let indexId: number
  const embedAdapter = createTestAdapter(384)

  beforeAll(async () => { await setupSchema(); pool = await getTestPool() })
  afterAll(async () => { await teardownSchema(); await closePool() })
  afterEach(async () => { await cleanupTestData() })

  beforeEach(async () => {
    await createIndex(pool, {
      name: 'rag-idx',
      config: { embedding: { provider: 'bedrock', model: 'test', dimensions: 384 } } as any,
    })
    const row = await pool.query('SELECT index_id FROM search_indexes WHERE name = $1', ['rag-idx'])
    indexId = row.rows[0].index_id

    // Seed two docs so we have something to cite
    await ingestDocument(pool, indexId, embedAdapter, {
      external_id: 'parking-apply',
      title: 'Apply for a Parking Permit',
      body: 'You can apply for a parking permit online or in person at the Streets Department.',
      metadata: { source_url: 'https://phila.gov/parking/apply' },
    })
    await ingestDocument(pool, indexId, embedAdapter, {
      external_id: 'parking-veterans',
      title: 'Veterans Parking Benefits',
      body: 'Veterans qualify for a reduced fee on residential parking permits.',
      metadata: { source_url: 'https://phila.gov/parking/veterans' },
    })

    await createPrompt(pool, indexId, 'navigator', promptContent)
  })

  it('returns answer, citations, retrieved, model, usage, prompt name', async () => {
    const llm = createTestLlmAdapter({ withCitations: [1, 2] })
    const result = await runRag(pool, indexId, embedAdapter, llm, {
      promptName: 'navigator',
      promptContent,
      question: 'How do I apply for parking?',
    })

    expect(result.answer).toContain('[1]')
    expect(result.answer).toContain('[2]')
    expect(result.citations.length).toBe(2)
    expect(result.citations[0].marker).toBe(1)
    expect(result.citations[1].marker).toBe(2)
    expect(result.retrieved.length).toBeGreaterThan(0)
    expect(result.prompt).toBe('navigator')
    expect(result.model).toBe('test-llm')
    expect(result.usage.output_tokens).toBeGreaterThan(0)
    expect(result.history_sig).toBeNull()
  })

  it('marks cited chunks as used=true and uncited as used=false', async () => {
    const llm = createTestLlmAdapter({ withCitations: [1] })
    const result = await runRag(pool, indexId, embedAdapter, llm, {
      promptName: 'navigator',
      promptContent,
      question: 'parking',
    })
    const usedCount = result.retrieved.filter(r => r.used).length
    const unusedCount = result.retrieved.filter(r => !r.used).length
    expect(usedCount).toBe(1)
    expect(unusedCount).toBeGreaterThanOrEqual(0)
  })

  it('drops citation markers pointing to nonexistent source numbers', async () => {
    const llm = createTestLlmAdapter({ withCitations: [99] })
    const result = await runRag(pool, indexId, embedAdapter, llm, {
      promptName: 'navigator',
      promptContent,
      question: 'parking',
    })
    expect(result.citations).toEqual([])
  })

  it('passes caller messages through to LLM (multi-turn)', async () => {
    let captured: any
    const llm = {
      model: 'test',
      async complete(input: any) {
        captured = input
        return { text: 'ok', usage: { input_tokens: 0, output_tokens: 0 }, model: 'test' }
      },
    }
    await runRag(pool, indexId, embedAdapter, llm as any, {
      promptName: 'navigator',
      promptContent,
      question: 'follow-up',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
      ],
    })
    // first two messages are history, third is the final user turn with context + question
    expect(captured.messages.length).toBe(3)
    expect(captured.messages[0]).toEqual({ role: 'user', content: 'first' })
    expect(captured.messages[1]).toEqual({ role: 'assistant', content: 'reply' })
    expect(captured.messages[2].role).toBe('user')
    expect(captured.messages[2].content).toContain('Source [1]:')
    expect(captured.messages[2].content).toContain('Question: follow-up')
  })

  it('uses prompt.system in the system field', async () => {
    let captured: any
    const llm = {
      model: 'test',
      async complete(input: any) {
        captured = input
        return { text: 'ok', usage: { input_tokens: 0, output_tokens: 0 }, model: 'test' }
      },
    }
    await runRag(pool, indexId, embedAdapter, llm as any, {
      promptName: 'navigator',
      promptContent,
      question: 'q',
    })
    expect(captured.system).toBe(promptContent.system)
  })
})
```

- [ ] **Step 4: Run to verify failure**

Run: `pnpm --filter api test rag`
Expected: FAIL — `runRag` does not exist.

- [ ] **Step 5: Implement `apps/api/services/rag.ts`**

```typescript
// ABOUTME: RAG pipeline orchestration — retrieve, render context, call LLM, parse citations.
// ABOUTME: Pure orchestration. No HTTP. No direct DB queries beyond delegating to hybridSearch.

import type { Pool } from 'pg'
import type { EmbeddingAdapter } from '@phila/search-embeddings'
import type { LlmAdapter } from '@phila/llm'
import { hybridSearch } from './search'
import type { PromptContent, RagResponse, Citation, RetrievedRef } from '../types'

export interface RunRagInput {
  promptName: string
  promptContent: PromptContent
  question: string
  messages?: { role: 'user' | 'assistant'; content: string }[]
}

export async function runRag(
  pool: Pool,
  indexId: number,
  embedAdapter: EmbeddingAdapter,
  llmAdapter: LlmAdapter,
  input: RunRagInput,
): Promise<RagResponse> {
  const { promptName, promptContent, question } = input
  const messages = input.messages ?? []

  const searchResponse = await hybridSearch(pool, indexId, embedAdapter, question, {
    mode: promptContent.retrieval.mode,
    limit: promptContent.retrieval.limit,
    maxChunksPerDoc: promptContent.retrieval.max_chunks_per_doc,
    minBm25Score: promptContent.retrieval.min_bm25_score,
    minVectorScore: promptContent.retrieval.min_vector_score,
  })

  const chunks = searchResponse.results

  const contextBlock = chunks
    .map((c, i) => `Source [${i + 1}]: ${c.title}\n${c.snippet}`)
    .join('\n\n')

  const finalUserContent =
    `${contextBlock}\n\n${promptContent.response_format}\n\nQuestion: ${question}`

  const llmMessages = [
    ...messages,
    { role: 'user' as const, content: finalUserContent },
  ]

  const completion = await llmAdapter.complete({
    system: promptContent.system,
    messages: llmMessages,
    max_tokens: promptContent.max_tokens,
    temperature: promptContent.temperature,
  })

  // Parse [N] markers from answer; keep only unique, in-range, sorted
  const markerRegex = /\[(\d+)\]/g
  const markerSet = new Set<number>()
  let m
  while ((m = markerRegex.exec(completion.text)) !== null) {
    const n = parseInt(m[1], 10)
    if (n >= 1 && n <= chunks.length) markerSet.add(n)
  }
  const markers = Array.from(markerSet).sort((a, b) => a - b)

  const citations: Citation[] = markers.map(marker => {
    const chunk = chunks[marker - 1]
    return {
      marker,
      external_id: chunk.external_id,
      title: chunk.title,
      url: typeof chunk.metadata?.source_url === 'string' ? chunk.metadata.source_url : '',
      snippet: chunk.snippet,
    }
  })

  const usedExternalIds = new Set(citations.map(c => c.external_id))
  const retrieved: RetrievedRef[] = chunks.map(c => ({
    external_id: c.external_id,
    score: c.score,
    used: usedExternalIds.has(c.external_id),
  }))

  return {
    answer: completion.text,
    citations,
    retrieved,
    model: completion.model,
    prompt: promptName,
    usage: completion.usage,
    history_sig: null,
  }
}
```

Note: `apps/api/package.json` needs `@phila/llm` and `@phila/bedrock-client` added to `dependencies`:

```json
"@phila/llm": "workspace:*",
"@phila/bedrock-client": "workspace:*",
```

(`@phila/bedrock-client` is only a transitive runtime dependency, but listing it explicitly avoids surprises in the Lambda bundle.)

Run: `pnpm install`

- [ ] **Step 6: Run tests to verify pass**

Run: `pnpm --filter api test rag`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/services/rag.ts apps/api/services/llm-adapter.ts apps/api/test/rag.test.ts apps/api/test/llm-adapter.test.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat: RAG service orchestration with citation parsing"
```

---

## Task 12: RAG route + CORS + mount

Wire the HTTP layer.

**Files:**
- Create: `apps/api/routes/rag.ts`
- Modify: `apps/api/index.ts`
- Modify: `apps/api/test/routes.test.ts`

- [ ] **Step 1: Write failing wiring test**

(Same paste-context note as Task 7 Step 1 — merge imports cleanly with the existing `routes.test.ts` rather than duplicating.) Add to `apps/api/test/routes.test.ts`:

```typescript
import { ragRoutes } from '../routes/rag'

const ragApp = new Hono()
ragApp.route('/', ragRoutes)

describe('rag route wiring', () => {
  it('mounts POST /public/rag/:name behind ragAuth (missing key → 401)', async () => {
    const res = await ragApp.request('/public/rag/any-index?prompt=any', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'q' }),
    })
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('UNAUTHORIZED')
  })

  it('does not expose /rag/:name outside /public/*', async () => {
    const res = await ragApp.request('/rag/any-index?prompt=any', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'q' }),
    })
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter api test routes`
Expected: FAIL — `routes/rag` does not exist.

- [ ] **Step 3: Create `apps/api/routes/rag.ts`**

```typescript
// ABOUTME: RAG synthesis route — POST /public/rag/:name?prompt=<name>
// ABOUTME: Gated by x-rag-key (separate credential from search/index keys).

import { Hono } from 'hono'
import { ragAuth } from '../middleware/auth'
import { apiError } from '../middleware/error'
import { getPool } from '../db/pool'
import { getAdapter } from '../services/adapter'
import { getLlmAdapter } from '../services/llm-adapter'
import { getPrompt } from '../services/prompts'
import { runRag } from '../services/rag'
import type { AppEnv } from '../types'

export const ragRoutes = new Hono<AppEnv>()
ragRoutes.use('/public/rag/:name', ragAuth)

ragRoutes.post('/public/rag/:name', async (c) => {
  const promptName = c.req.query('prompt')
  if (!promptName) {
    return apiError(c, 'VALIDATION_ERROR', 'Missing required query parameter: prompt')
  }

  let body: any
  try {
    body = await c.req.json()
  } catch {
    return apiError(c, 'VALIDATION_ERROR', 'Request body must be valid JSON')
  }

  if (!body.question || typeof body.question !== 'string' || body.question.trim() === '') {
    return apiError(c, 'VALIDATION_ERROR', 'Missing required field: question (string)')
  }
  if (body.messages !== undefined && !Array.isArray(body.messages)) {
    return apiError(c, 'VALIDATION_ERROR', 'messages must be an array')
  }

  const index = c.get('index')
  const pool = await getPool()

  const prompt = await getPrompt(pool, index.index_id, promptName)
  if (!prompt) {
    return apiError(c, 'NOT_FOUND', `Prompt '${promptName}' not found`)
  }

  const embedAdapter = getAdapter(index.config)
  const llmAdapter = getLlmAdapter(prompt.content)

  const result = await runRag(pool, index.index_id, embedAdapter, llmAdapter, {
    promptName,
    promptContent: prompt.content,
    question: body.question.trim(),
    messages: body.messages,
  })

  return c.json(result, 200)
})
```

- [ ] **Step 4: Mount in `apps/api/index.ts`**

Imports:

```typescript
import { ragRoutes } from './routes/rag'
```

Mount (after `promptsRoutes`):

```typescript
app.route('/', ragRoutes)
```

CORS — extend `allowHeaders`:

```typescript
allowHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-index-key', 'x-search-key', 'x-rag-key'],
```

- [ ] **Step 5: Run tests to verify**

Run: `pnpm --filter api test routes`
Expected: PASS.

Run: `pnpm --filter api test`
Expected: full suite PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/routes/rag.ts apps/api/index.ts apps/api/test/routes.test.ts
git commit -m "feat: RAG synthesis route and CORS allow x-rag-key"
```

---

## Task 13: Demo HTML

Sibling to `apps/api/dev/search.html`. localStorage for config, conversation pane, citation rendering, collapsed retrieved list.

**Files:**
- Create: `apps/api/dev/rag.html`

- [ ] **Step 1: Create `apps/api/dev/rag.html`**

```html
<!-- ABOUTME: Static dev tool for manually exercising the pgsearch RAG endpoint. -->
<!-- ABOUTME: Open via file:// in a browser; never served in production. -->
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>pgsearch rag dev</title>
<style>
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 820px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.2rem; margin-bottom: 1rem; }
  .config { background: #f4f4f4; padding: 1rem; border-radius: 6px; margin-bottom: 1.5rem; }
  .config label { display: block; margin-bottom: 0.5rem; font-size: 12px; color: #555; }
  .config input { width: 100%; padding: 0.4rem; box-sizing: border-box; font-family: inherit; font-size: 13px; }
  form.ask { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
  form.ask input[type=text] { flex: 1; padding: 0.6rem; font-size: 14px; }
  form.ask button { padding: 0.6rem 1rem; font-size: 14px; cursor: pointer; }
  button.reset { background: #fff; border: 1px solid #ccc; }
  .turn { padding: 0.8rem 0; border-top: 1px solid #e4e4e4; }
  .turn.user { color: #333; }
  .turn.assistant .answer { color: #111; }
  .turn .role { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 0.3rem; }
  sup.cite a { color: #0a5fb1; text-decoration: none; padding: 0 2px; }
  sup.cite a:hover { text-decoration: underline; }
  .citations { margin-top: 0.6rem; font-size: 12px; color: #555; }
  .citations ol { padding-left: 1.2rem; margin: 0.3rem 0; }
  .citations a { color: #0a5fb1; }
  details.retrieved { margin-top: 0.4rem; font-size: 12px; color: #777; }
  details.retrieved summary { cursor: pointer; }
  .usage { font-size: 11px; color: #999; margin-top: 0.4rem; }
  .error { color: #b00020; padding: 0.6rem; background: #fff4f4; border-radius: 4px; }
</style>
</head>
<body>

<h1>pgsearch rag dev</h1>

<div class="config">
  <label>API base URL <input id="api-base" value="https://3qkikancml.execute-api.us-east-1.amazonaws.com/dev"></label>
  <label>Index name <input id="index-name" value="phila-services-programs"></label>
  <label>RAG key <input id="rag-key" type="password" placeholder="rag_..."></label>
  <label>Prompt name <input id="prompt-name" value="navigator"></label>
</div>

<form class="ask" onsubmit="event.preventDefault(); ask();">
  <input type="text" id="q" placeholder="Ask…" autofocus>
  <button type="submit">Ask</button>
  <button type="button" class="reset" onclick="resetConversation()">Reset</button>
</form>

<div id="conversation"></div>

<script>
  const $apiBase = document.getElementById('api-base');
  const $indexName = document.getElementById('index-name');
  const $ragKey = document.getElementById('rag-key');
  const $promptName = document.getElementById('prompt-name');
  const $q = document.getElementById('q');
  const $conversation = document.getElementById('conversation');

  let messages = JSON.parse(localStorage.getItem('pgsearch-rag:messages') || '[]');

  for (const [el, key] of [[$apiBase, 'apiBase'], [$indexName, 'indexName'], [$ragKey, 'ragKey'], [$promptName, 'promptName']]) {
    const saved = localStorage.getItem('pgsearch-rag:' + key);
    if (saved) el.value = saved;
    el.addEventListener('input', () => localStorage.setItem('pgsearch-rag:' + key, el.value));
  }

  renderConversation();

  function resetConversation() {
    messages = [];
    localStorage.setItem('pgsearch-rag:messages', '[]');
    renderConversation();
  }

  async function ask() {
    const question = $q.value.trim();
    if (!question) return;
    const base = $apiBase.value.replace(/\/$/, '');
    const index = $indexName.value;
    const key = $ragKey.value;
    const promptName = $promptName.value;

    $q.value = '';
    appendUserTurn(question);

    try {
      const res = await fetch(`${base}/public/rag/${encodeURIComponent(index)}?prompt=${encodeURIComponent(promptName)}`, {
        method: 'POST',
        headers: { 'x-rag-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ question, messages }),
      });
      if (!res.ok) {
        const body = await res.text();
        appendError(`${res.status} ${res.statusText}\n${body}`);
        return;
      }
      const data = await res.json();
      messages = [
        ...messages,
        { role: 'user', content: question },
        { role: 'assistant', content: data.answer },
      ];
      localStorage.setItem('pgsearch-rag:messages', JSON.stringify(messages));
      appendAssistantTurn(data);
    } catch (err) {
      appendError(err.message);
    }
  }

  function renderConversation() {
    $conversation.innerHTML = '';
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'user') appendUserTurn(m.content);
      else appendAssistantTurnText(m.content);
    }
  }

  function appendUserTurn(text) {
    const div = document.createElement('div');
    div.className = 'turn user';
    div.innerHTML = `<div class="role">you</div><div>${escape(text)}</div>`;
    $conversation.appendChild(div);
  }

  function appendAssistantTurnText(text) {
    const div = document.createElement('div');
    div.className = 'turn assistant';
    div.innerHTML = `<div class="role">assistant</div><div class="answer">${escape(text)}</div>`;
    $conversation.appendChild(div);
  }

  function appendAssistantTurn(data) {
    const div = document.createElement('div');
    div.className = 'turn assistant';

    const markerToCitation = new Map(data.citations.map(c => [c.marker, c]));
    const answerHtml = escape(data.answer).replace(/\[(\d+)\]/g, (_, n) => {
      const c = markerToCitation.get(Number(n));
      if (!c) return `[${n}]`;
      return `<sup class="cite"><a href="${escape(c.url || '#')}" target="_blank" rel="noopener">[${n}]</a></sup>`;
    });

    const citationsHtml = data.citations.length === 0 ? '' : `
      <div class="citations">
        Sources:
        <ol>${data.citations.map(c => `
          <li>${escape(c.title)} ${c.url ? `<a href="${escape(c.url)}" target="_blank" rel="noopener">↗</a>` : ''}</li>
        `).join('')}</ol>
      </div>`;

    const retrievedHtml = `
      <details class="retrieved">
        <summary>retrieved (${data.retrieved.length})</summary>
        <ul>${data.retrieved.map(r => `
          <li>${escape(r.external_id)} — score ${r.score.toFixed(3)}${r.used ? ' ✓' : ''}</li>
        `).join('')}</ul>
      </details>`;

    div.innerHTML = `
      <div class="role">assistant · ${escape(data.model)} · prompt: ${escape(data.prompt)}</div>
      <div class="answer">${answerHtml}</div>
      ${citationsHtml}
      ${retrievedHtml}
      <div class="usage">tokens in: ${data.usage.input_tokens} · out: ${data.usage.output_tokens}</div>
    `;
    $conversation.appendChild(div);
  }

  function appendError(text) {
    const div = document.createElement('div');
    div.className = 'turn assistant';
    div.innerHTML = `<div class="role">error</div><div class="error">${escape(text)}</div>`;
    $conversation.appendChild(div);
  }

  function escape(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
</script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/dev/rag.html
git commit -m "feat: rag.html dev tool with citations and conversation pane"
```

---

## Task 14: Documentation

User-facing RAG guide + architecture mention + README link.

**Files:**
- Create: `docs/rag.md`
- Modify: `docs/architecture.md`
- Modify: `README.md`

- [ ] **Step 1: Create `docs/rag.md`**

```markdown
<!-- ABOUTME: Guide to using the RAG endpoint — prompts, keys, request shape, response shape. -->
<!-- ABOUTME: Layered atop the hybrid search pipeline. -->

# RAG

Retrieval-augmented generation (RAG) layered atop hybrid search. The RAG endpoint retrieves the top chunks for a question from an index, sends them to an LLM with a stored prompt, and returns a synthesized answer with inline citations to source documents.

## Key concepts

- **Prompt** — a per-index entity (`rag_prompts` table). Carries the system prompt, response format hint, model ID, generation params, and retrieval params. Callers reference prompts by name via query string.
- **RAG key** — `x-rag-key`, minted lazily by admin per index. Separate from `x-search-key` and `x-index-key`. Lets you grant and revoke LLM-spend access independently of read access.
- **Inline citations** — the LLM is instructed to cite sources as `[N]` matching the 1-indexed `Source [N]:` blocks it received. The response parses these markers into a `citations` array.

## Enable RAG for an index

```bash
# Mint a RAG key (lazy — only indexes that need RAG get one)
curl -X POST https://<api-url>/private/key/admin/indexes/my-index/rag-key \
  -H "x-api-key: $ADMIN_KEY"
# → {"rag_key":"rag_..."}
```

Save the returned key; the plaintext is only shown once.

## Create a prompt

```bash
curl -X POST https://<api-url>/public/index/my-index/prompts \
  -H "x-index-key: $INDEX_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "navigator",
    "content": {
      "system": "You are the City of Philadelphia digital navigator. Answer concisely using only the provided sources. If the answer is not in the sources, say so.",
      "response_format": "Cite sources inline as [N] matching the Source [N] numbers above.",
      "model": "anthropic.claude-haiku-4-5",
      "max_tokens": 1024,
      "temperature": 0.2,
      "retrieval": {
        "mode": "hybrid",
        "limit": 8,
        "max_chunks_per_doc": 3,
        "min_bm25_score": 0,
        "min_vector_score": 0
      }
    }
  }'
```

## Ask a question

```bash
curl -X POST "https://<api-url>/public/rag/my-index?prompt=navigator" \
  -H "x-rag-key: $RAG_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "question": "How do I apply for a parking permit?" }'
```

Response:

```json
{
  "answer": "You can apply online or in person at the Streets Department [1]. Veterans qualify for a reduced fee [2].",
  "citations": [
    { "marker": 1, "external_id": "parking-apply", "title": "...", "url": "...", "snippet": "..." },
    { "marker": 2, "external_id": "parking-veterans", "title": "...", "url": "...", "snippet": "..." }
  ],
  "retrieved": [
    { "external_id": "parking-apply", "score": 0.83, "used": true },
    { "external_id": "parking-veterans", "score": 0.71, "used": true }
  ],
  "model": "anthropic.claude-haiku-4-5",
  "prompt": "navigator",
  "usage": { "input_tokens": 2341, "output_tokens": 187 },
  "history_sig": null
}
```

## Multi-turn

The endpoint is stateless. To carry conversation history, pass prior turns in `messages`:

```json
{
  "question": "What about for veterans?",
  "messages": [
    { "role": "user", "content": "How do I apply for a parking permit?" },
    { "role": "assistant", "content": "You can apply online..." }
  ]
}
```

Retrieval still runs against the latest `question` only — searching the full history is noisy. The LLM sees the full conversation plus the freshly retrieved context.

## Prompt management

```bash
# List
curl https://<api-url>/public/index/my-index/prompts -H "x-index-key: $INDEX_KEY"

# Read
curl https://<api-url>/public/index/my-index/prompts/navigator -H "x-index-key: $INDEX_KEY"

# Update (replace content)
curl -X PATCH https://<api-url>/public/index/my-index/prompts/navigator \
  -H "x-index-key: $INDEX_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content": {...}}'

# Delete
curl -X DELETE https://<api-url>/public/index/my-index/prompts/navigator \
  -H "x-index-key: $INDEX_KEY"
```

## Revoke RAG access

```bash
curl -X DELETE https://<api-url>/private/key/admin/indexes/my-index/rag-key \
  -H "x-api-key: $ADMIN_KEY"
```

Nulls the stored hash. The endpoint will return 401 with "RAG is not enabled for this index" until a new key is minted.

## What's opinionated

- **Per-index prompts.** Prompts can't be shared across indexes in v1. If you need the same prompt against `services-en` and `services-es`, duplicate it.
- **Prompt is the only tunable surface.** Model, temperature, retrieval params all live on the prompt. To experiment with a different model, create another prompt.
- **Inline `[N]` markers.** Citations are parsed from `[N]` in the answer text. Other formats (footnotes, brackets with text) are ignored.
- **Synchronous response.** No streaming yet. Expect ~3–10s for typical Claude Haiku responses.
- **Caller-owned history.** Pass `messages`; the server never stores them.

## Things to be aware of

- **Cost.** LLM calls are 100–1000× the cost of an embedding call. The separate `x-rag-key` makes RAG traffic auditable; budget accordingly.
- **Trusted callers.** The `messages` array is not validated for role alternation or signed. A misbehaving caller can fabricate prior turns. Acceptable for internal tools.
- **No quotas in v1.** Revoke the key if something runs away.
- **Per-doc cap matters.** With `max_chunks_per_doc: 3`, a single large document (e.g., a chunked PDF) can contribute at most 3 segments to context, preserving diversity.
```

- [ ] **Step 2: Update `docs/architecture.md`**

After the "Embedding Strategy" section, add a new section:

```markdown
---

## RAG Pipeline

RAG layers atop hybrid search. `/public/rag/:name` retrieves the top chunks for the latest question, renders them as numbered `Source [N]:` blocks, and sends them to an LLM along with a stored system prompt. The LLM is instructed to cite using `[N]` markers; the response parses these into a structured `citations` array.

Prompts are first-class per-index entities stored in `rag_prompts` as JSONB. A prompt carries the system text, model ID, generation params, and retrieval params (mode, limit, max_chunks_per_doc, score floors). The API exposes prompt CRUD under `x-index-key`. The RAG endpoint itself is gated by a separate `x-rag-key`, minted lazily via admin — indexes that don't use RAG never carry an unused credential.

The `hybridSearch` function gained a `maxChunksPerDoc` option (default 1, preserving original search behavior) so RAG can pull multiple segments from the same document while still capping any single source's share of the context window.

LLM access goes through the `LlmAdapter` interface in `packages/llm`, mirroring `EmbeddingAdapter`. The Bedrock adapter calls Claude via the Anthropic Messages API. Both adapters share `packages/bedrock-client` for lazy, region-memoized SDK client construction.

See `docs/rag.md` for the user-facing guide.
```

- [ ] **Step 3: Update `README.md`**

Add to the Key Concepts list (after the "Hybrid search" bullet):

```markdown
- **RAG** — `/public/rag/:name?prompt=<name>` retrieves the top chunks for a question and asks an LLM to synthesize an answer with inline citations. Prompts are per-index DB entities; RAG access is gated by a separate `x-rag-key`.
```

Add to the Documentation table:

```markdown
| [RAG](docs/rag.md) | Synthesize answers with citations using stored prompts and the hybrid retrieval pipeline. |
```

- [ ] **Step 4: Commit**

```bash
git add docs/rag.md docs/architecture.md README.md
git commit -m "docs: RAG user guide, architecture note, README link"
```

---

## Task 15: Final verification

- [ ] **Step 1: Full test suite**

Run: `pnpm test -- --run`
Expected: all tests pass across all workspaces.

- [ ] **Step 2: Type check**

Run: `pnpm --filter api exec tsc --noEmit`
Run: `pnpm --filter @phila/llm exec tsc --noEmit`
Run: `pnpm --filter @phila/bedrock-client exec tsc --noEmit`
Run: `pnpm --filter @phila/search-embeddings exec tsc --noEmit`
Expected: zero errors in each.

- [ ] **Step 3: Lambda bundle**

Run: `pnpm --filter api build`
Expected: `apps/api/dist/index.js` produced without errors. `@aws-sdk/*` is externalized via the esbuild config — fine, since Bedrock SDK is available at Lambda runtime.

- [ ] **Step 4: Local dev smoke**

Optional but recommended:

```bash
# In one terminal — postgres
docker compose -f docker-compose.test.yml up -d
# In another — API
pnpm --filter api dev
```

Then open `apps/api/dev/rag.html` via `file://` and verify the UI loads. Actual LLM calls require a real RAG key and Bedrock credentials — not feasible in this verification step. The wiring tests in Task 12 cover that the endpoint is reachable and gated correctly.

- [ ] **Step 5: Grep for expected references**

```bash
grep -rn "x-rag-key" apps/api/ --include='*.ts'
```
Expected: matches in `middleware/auth.ts` (handler), `index.ts` (CORS), and possibly route comments.

```bash
grep -rn "bestByDoc" apps/api/ --include='*.ts'
```
Expected: no matches (Task 8 replaced this with `byDoc` per-doc cap logic).

- [ ] **Step 6: Confirm branch state**

```bash
git log --oneline main..HEAD
```
Expected: roughly 15 commits, one per task plus the spec commits already on the branch.

- [ ] **Step 7: If anything failed, fix forward (new commit, never amend)**

Per project rules: NEVER amend. Fix, stage, commit with a descriptive message, re-run verification.
