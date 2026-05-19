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
