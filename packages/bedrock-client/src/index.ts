// ABOUTME: Lazy-loaded AWS Bedrock runtime client for us-east-1.
// ABOUTME: Shared by embedding and LLM adapters to avoid duplicate SDK clients per call.

let handlePromise: Promise<BedrockClientHandle> | null = null

export interface BedrockClientHandle {
  client: any
  InvokeModelCommand: any
}

export async function getBedrockClient(): Promise<BedrockClientHandle> {
  if (!handlePromise) {
    handlePromise = (async () => {
      // @ts-ignore — SDK is available at runtime in Lambda, not at build time
      const sdk = await import('@aws-sdk/client-bedrock-runtime')
      return {
        client: new sdk.BedrockRuntimeClient({ region: 'us-east-1' }),
        InvokeModelCommand: sdk.InvokeModelCommand,
      }
    })()
  }
  return handlePromise
}
