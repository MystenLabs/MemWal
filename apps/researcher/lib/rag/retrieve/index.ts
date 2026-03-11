import "server-only";

import { embed } from "ai";
import { getEmbeddingModel } from "@/lib/ai/providers";
import { vectorSearch } from "./vector-search";
import { keywordSearch } from "./keyword-search";
import { reciprocalRankFusion, type SearchResult } from "./fusion";
import { rerank } from "../rank";

export type { SearchResult } from "./fusion";

/**
 * Hybrid search: vector + keyword with RRF fusion.
 */
export async function hybridSearch({
  query,
  userId,
  sourceId,
  limit = 20,
}: {
  query: string;
  userId: string;
  sourceId?: string;
  limit?: number;
}): Promise<SearchResult[]> {
  // Embed the query
  const { embedding: queryEmbedding } = await embed({
    model: getEmbeddingModel(),
    value: query,
  });

  // Run vector and keyword search in parallel
  const [vectorResults, keywordResults] = await Promise.all([
    vectorSearch({ queryEmbedding, userId, sourceId, limit }),
    keywordSearch({ query, userId, sourceId, limit }),
  ]);

  console.log(`[retrieve] Vector: ${vectorResults.length} results, Keyword: ${keywordResults.length} results`);

  // Fuse results using RRF
  const fused = reciprocalRankFusion(vectorResults, keywordResults);
  console.log(`[retrieve] RRF fusion: ${fused.length} unique results`);
  return fused;
}

/**
 * Search + re-rank pipeline: hybrid search with wider net, then LLM re-ranking.
 */
export async function searchAndRank({
  query,
  userId,
  sourceId,
  limit = 5,
  threshold = 0.3,
}: {
  query: string;
  userId: string;
  sourceId?: string;
  limit?: number;
  threshold?: number;
}): Promise<SearchResult[]> {
  console.log(`[retrieve] searchAndRank — query="${query}", sourceId=${sourceId ?? "all"}, limit=${limit}, threshold=${threshold}`);

  // Fetch more candidates than needed for re-ranking
  const candidates = await hybridSearch({
    query,
    userId,
    sourceId,
    limit: Math.max(limit * 3, 15),
  });

  // Re-rank candidates (fall back to hybrid scores if LLM fails)
  let reranked: SearchResult[];
  try {
    reranked = await rerank({ query, candidates });
  } catch (error) {
    console.error("[rerank] Failed, using hybrid scores:", error);
    reranked = candidates;
  }

  // Apply threshold and trim to limit
  const final = reranked.filter((r) => r.score >= threshold).slice(0, limit);
  console.log(`[retrieve] After rerank+threshold: ${final.length} results (from ${candidates.length} candidates)`);
  if (final.length > 0) {
    console.log(`[retrieve] Top scores: ${final.map((r) => `${r.section}=${r.score.toFixed(2)}`).join(", ")}`);
  }
  return final;
}
