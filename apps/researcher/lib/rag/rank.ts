import "server-only";

import { generateObject } from "ai";
import { z } from "zod";
import { getLanguageModel } from "@/lib/ai/providers";
import type { SearchResult } from "./retrieve/fusion";

const RERANK_MODEL = "google/gemini-2.5-flash";

const rerankSchema = z.object({
  scores: z.array(
    z.object({
      index: z.number().describe("The 0-based index of the chunk"),
      relevance: z.number().min(0).max(10).describe("Relevance score 0-10"),
    })
  ),
});

/**
 * Re-rank search results using LLM-based relevance scoring.
 * Skips re-ranking if < 3 candidates (returns as-is).
 */
export async function rerank({
  query,
  candidates,
}: {
  query: string;
  candidates: SearchResult[];
}): Promise<SearchResult[]> {
  if (candidates.length < 3) {
    console.log(`[rerank] Skipped — only ${candidates.length} candidates`);
    return candidates;
  }

  console.log(`[rerank] Re-ranking ${candidates.length} candidates for query="${query}"`);

  // Format candidates as numbered list with section + preview
  const candidateList = candidates
    .map((c, i) => {
      const preview = c.content.slice(0, 200);
      return `[${i}] ${c.section}: ${preview}`;
    })
    .join("\n");

  const { object } = await generateObject({
    model: getLanguageModel(RERANK_MODEL),
    schema: rerankSchema,
    prompt: `Rate the relevance of each text chunk to the query. Score each 0-10 where 10 is perfectly relevant and 0 is completely irrelevant.

Query: "${query}"

Chunks:
${candidateList}`,
  });

  // Build score map from LLM response
  const scoreMap = new Map<number, number>();
  for (const { index, relevance } of object.scores) {
    if (index >= 0 && index < candidates.length) {
      scoreMap.set(index, relevance / 10); // Normalize to 0-1
    }
  }

  console.log(`[rerank] LLM scored ${scoreMap.size}/${candidates.length} candidates`);

  // Replace scores and sort descending
  return candidates
    .map((candidate, i) => ({
      ...candidate,
      score: scoreMap.get(i) ?? 0,
    }))
    .sort((a, b) => b.score - a.score);
}
