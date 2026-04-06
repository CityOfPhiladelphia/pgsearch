// ABOUTME: BM25F scoring functions for field-weighted keyword relevance.
// ABOUTME: Computes IDF, field-weighted term frequency, and min-max score normalization.

export interface TermFreq {
  term: string
  titleTf: number
  bodyTf: number
  df: number
}

export interface BM25FParams {
  termFreqs: TermFreq[]
  titleLength: number
  bodyLength: number
  k1: number
  b: number
  fieldWeights: { title: number; body: number }
  avgTitleLength: number
  avgBodyLength: number
  totalDocuments: number
}

export function computeIDF(totalDocuments: number, documentFrequency: number): number {
  return Math.log((totalDocuments - documentFrequency + 0.5) / (documentFrequency + 0.5) + 1)
}

export function computeBM25F(params: BM25FParams): number {
  const { termFreqs, titleLength, bodyLength, k1, b, fieldWeights, avgTitleLength, avgBodyLength, totalDocuments } = params
  const wTitle = fieldWeights.title
  const wBody = fieldWeights.body

  const dlCombined = wTitle * titleLength + wBody * bodyLength
  const avgdlCombined = wTitle * avgTitleLength + wBody * avgBodyLength

  let score = 0
  for (const { titleTf, bodyTf, df } of termFreqs) {
    const idf = computeIDF(totalDocuments, df)
    const tfCombined = wTitle * titleTf + wBody * bodyTf
    const weightedTf = (tfCombined * (k1 + 1)) / (tfCombined + k1 * (1 - b + b * dlCombined / avgdlCombined))
    score += idf * weightedTf
  }

  return score
}

export function normalizeScores(scores: number[]): number[] {
  if (scores.length === 0) return []
  const min = Math.min(...scores)
  const max = Math.max(...scores)
  if (min === max) return scores.map(() => 1)
  return scores.map(s => (s - min) / (max - min))
}
