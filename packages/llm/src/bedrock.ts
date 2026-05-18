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
