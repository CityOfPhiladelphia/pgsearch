// ABOUTME: Deterministic test embedding adapter for integration testing.
// ABOUTME: Produces consistent, unique vectors from text input without a real model.

import crypto from 'crypto'
import type { EmbeddingAdapter } from './adapter'

export function createTestAdapter(dimensions: number): EmbeddingAdapter {
  return {
    model: 'test-deterministic',
    dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(text => {
        const hash = crypto.createHash('sha256').update(text).digest()
        const vector: number[] = []
        for (let i = 0; i < dimensions; i++) {
          // Deterministic pseudo-random float from hash bytes
          vector.push((hash[i % hash.length] / 255) * 2 - 1)
        }
        // Normalize to unit vector
        const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
        return vector.map(v => v / magnitude)
      })
    },
  }
}
