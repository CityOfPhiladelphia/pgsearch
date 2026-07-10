// ABOUTME: Reciprocal Rank Fusion scoring for combining lexical and vector retriever ranks.
// ABOUTME: Each retriever contributes weight/(k + rank); absent ranks contribute nothing.

export interface RRFParams {
  bm25Rank?: number
  vectorRank?: number
  k: number
  weights: { bm25: number; vector: number }
}

export function computeRRF(params: RRFParams): number {
  const { bm25Rank, vectorRank, k, weights } = params
  let score = 0
  if (bm25Rank != null) {
    score += weights.bm25 / (k + bm25Rank)
  }
  if (vectorRank != null) {
    score += weights.vector / (k + vectorRank)
  }
  return score
}
