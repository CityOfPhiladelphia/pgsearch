// ABOUTME: Embedding adapter interface for pluggable vector generation.
// ABOUTME: Implementations provide batch text-to-vector conversion.

export interface EmbeddingAdapter {
  embed(texts: string[]): Promise<number[][]>
  dimensions: number
  model: string
}
