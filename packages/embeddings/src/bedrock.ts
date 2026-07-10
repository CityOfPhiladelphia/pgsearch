// ABOUTME: AWS Bedrock embedding adapter for production vector generation.
// ABOUTME: Calls Bedrock InvokeModel API for text embedding.

import { getBedrockClient } from '@phila/bedrock-client'
import type { EmbeddingAdapter } from './adapter'

export interface BedrockAdapterConfig {
  model: string
  dimensions: number
}

export function createBedrockAdapter(config: BedrockAdapterConfig): EmbeddingAdapter {
  return {
    model: config.model,
    dimensions: config.dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      const { client, InvokeModelCommand } = await getBedrockClient()
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
