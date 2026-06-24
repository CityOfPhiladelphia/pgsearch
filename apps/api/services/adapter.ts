// ABOUTME: Shared embedding adapter factory for ingest and search routes.
// ABOUTME: Throws on unknown providers instead of silently falling back to the test adapter.

import assert from 'assert'
import type { EmbeddingAdapter } from '@phila/search-embeddings'
import { createBedrockAdapter } from '@phila/search-embeddings'
import type { IndexConfig } from '../types'

export function getAdapter(config: IndexConfig): EmbeddingAdapter {
  const { provider } = config.embedding
  assert(
    provider === 'bedrock',
    `embedding provider '${provider}' is not supported in this deployment. ` +
      `Only 'bedrock' is available. Update the index config and re-ingest.`,
  )
  return createBedrockAdapter(config.embedding)
}
