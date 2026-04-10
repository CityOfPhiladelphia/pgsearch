// ABOUTME: Shared embedding adapter factory for ingest and search routes.
// ABOUTME: Throws on unknown providers instead of silently falling back to the test adapter.

import type { EmbeddingAdapter } from '@phila/search-embeddings'
import { createBedrockAdapter } from '@phila/search-embeddings'
import type { IndexConfig } from '../types'

export function getAdapter(config: IndexConfig): EmbeddingAdapter {
  const { provider } = config.embedding
  if (provider === 'bedrock') {
    return createBedrockAdapter(config.embedding)
  }
  throw new Error(
    `embedding provider '${provider}' is not supported in this deployment. ` +
      `Only 'bedrock' is available. Update the index config and re-ingest.`,
  )
}
