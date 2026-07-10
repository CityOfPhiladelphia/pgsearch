// ABOUTME: Ranking-comparison metrics for search eval captures.
// ABOUTME: overlap@k measures shared membership; Spearman rho measures ordering agreement on shared items.

// Fraction of the top-k members shared between two ranked lists.
// Normalized by the longer list's comparable depth so missing results read as divergence.
export function overlapAtK(a: string[], b: string[], k: number): number | null {
  const topA = a.slice(0, k)
  const topB = b.slice(0, k)
  const denominator = Math.min(k, Math.max(topA.length, topB.length))
  if (denominator === 0) return null
  const setB = new Set(topB)
  const shared = topA.filter(id => setB.has(id)).length
  return shared / denominator
}

// Spearman rank correlation over the intersection of two ranked lists.
// Shared items are re-ranked 1..n by order of appearance in each list, so the
// classic 1 - 6*sum(d^2)/(n(n^2-1)) form applies. Null with fewer than two shared items.
export function spearmanShared(a: string[], b: string[]): number | null {
  const setB = new Set(b)
  const shared = a.filter(id => setB.has(id))
  const n = shared.length
  if (n < 2) return null

  const sharedSet = new Set(shared)
  const rankIn = (list: string[]): Map<string, number> => {
    const ranks = new Map<string, number>()
    let rank = 1
    for (const id of list) {
      if (sharedSet.has(id)) ranks.set(id, rank++)
    }
    return ranks
  }

  const ranksA = rankIn(a)
  const ranksB = rankIn(b)
  let sumD2 = 0
  for (const id of shared) {
    const d = ranksA.get(id)! - ranksB.get(id)!
    sumD2 += d * d
  }
  return 1 - (6 * sumD2) / (n * (n * n - 1))
}
