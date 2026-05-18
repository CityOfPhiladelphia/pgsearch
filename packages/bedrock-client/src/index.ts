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
