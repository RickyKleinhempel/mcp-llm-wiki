/**
 * Reciprocal Rank Fusion.
 *
 * RRF combines rankings without needing the underlying scores to be
 * comparable - BM25 returns negative log-odds-ish values, cosine returns
 * distances in [0, 2]. Each list contributes `weight / (k + rank)`.
 */

export interface RankedList {
  weight?: number;
  ids: number[];
}

export interface FusedHit {
  id: number;
  score: number;
  ranks: Record<string, number>;
}

export function reciprocalRankFusion(lists: Record<string, RankedList>, k: number, limit: number): FusedHit[] {
  const scores = new Map<number, { score: number; ranks: Record<string, number> }>();

  for (const [name, list] of Object.entries(lists)) {
    const weight = list.weight ?? 1;
    list.ids.forEach((id, index) => {
      const rank = index + 1;
      const entry = scores.get(id) ?? { score: 0, ranks: {} };
      entry.score += weight / (k + rank);
      entry.ranks[name] = rank;
      scores.set(id, entry);
    });
  }

  return [...scores.entries()]
    .map(([id, entry]) => ({ id, score: entry.score, ranks: entry.ranks }))
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .slice(0, limit);
}
