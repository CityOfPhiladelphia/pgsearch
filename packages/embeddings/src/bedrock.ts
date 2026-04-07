// ABOUTME: AWS Bedrock embedding adapter for production vector generation.
// ABOUTME: Calls Bedrock InvokeModel API for text embedding.

import type { EmbeddingAdapter } from './adapter'

export interface BedrockAdapterConfig {
  model: string
  dimensions: number
  region?: string
}

export function createBedrockAdapter(config: BedrockAdapterConfig): EmbeddingAdapter {
  let client: any = null

  async function getClient() {
    if (!client) {
      // @ts-ignore — SDK is available at runtime in Lambda, not at build time
      const { BedrockRuntimeClient, InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime')
      client = { Client: new BedrockRuntimeClient({ region: config.region || 'us-east-1' }), InvokeModelCommand }
    }
    return client
  }

  return {
    model: config.model,
    dimensions: config.dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      const { Client, InvokeModelCommand } = await getClient()
      const results: number[][] = []
      for (const text of texts) {
        const response = await Client.send(new InvokeModelCommand({
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
