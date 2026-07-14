// ABOUTME: Reciprocal Rank Fusion scoring for combining lexical and vector retriever ranks.
// ABOUTME: Each retriever contributes weight/(k + rank); absent ranks contribute nothing.

export interface RRFParams {
  lexicalRank?: number
  vectorRank?: number
  k: number
  weights: { lexical: number; vector: number }
}

export function computeRRF(params: RRFParams): number {
  const { lexicalRank, vectorRank, k, weights } = params
  let score = 0
  if (lexicalRank != null) {
    score += weights.lexical / (k + lexicalRank)
  }
  if (vectorRank != null) {
    score += weights.vector / (k + vectorRank)
  }
  return score
}
