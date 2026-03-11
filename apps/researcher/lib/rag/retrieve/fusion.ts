export type SearchResult = {
  chunkId: string;
  section: string;
  content: string;
  sourceId: string;
  sourceTitle: string | null;
  chunkIndex: number;
  tokenCount: number;
  score: number;
};

/**
 * Reciprocal Rank Fusion (RRF) — combines vector and keyword search results.
 *
 * RRF formula: score = 1/(k + rank_vector) + 1/(k + rank_keyword)
 * Chunks absent from one result set get penalty rank (list length + 1).
 * Final scores normalized to 0-1.
 */
export function reciprocalRankFusion(
  vectorResults: SearchResult[],
  keywordResults: SearchResult[],
  k = 60,
): SearchResult[] {
  // Build rank maps (1-based ranks)
  const vectorRanks = new Map<string, number>();
  vectorResults.forEach((r, i) => vectorRanks.set(r.chunkId, i + 1));

  const keywordRanks = new Map<string, number>();
  keywordResults.forEach((r, i) => keywordRanks.set(r.chunkId, i + 1));

  // Collect all unique chunks
  const chunkMap = new Map<string, SearchResult>();
  for (const r of vectorResults) chunkMap.set(r.chunkId, r);
  for (const r of keywordResults) {
    if (!chunkMap.has(r.chunkId)) chunkMap.set(r.chunkId, r);
  }

  // Penalty rank for missing results
  const vectorPenalty = vectorResults.length + 1;
  const keywordPenalty = keywordResults.length + 1;

  // Calculate RRF scores
  const scored: { result: SearchResult; rrfScore: number }[] = [];

  for (const [chunkId, result] of chunkMap) {
    const vRank = vectorRanks.get(chunkId) ?? vectorPenalty;
    const kRank = keywordRanks.get(chunkId) ?? keywordPenalty;
    const rrfScore = 1 / (k + vRank) + 1 / (k + kRank);
    scored.push({ result, rrfScore });
  }

  // Find max score for normalization
  const maxScore = Math.max(...scored.map((s) => s.rrfScore));
  if (maxScore === 0) return [];

  // Normalize and sort
  return scored
    .map(({ result, rrfScore }) => ({
      ...result,
      score: rrfScore / maxScore,
    }))
    .sort((a, b) => b.score - a.score);
}
