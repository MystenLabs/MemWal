import { z } from "zod";
import { tool } from "ai";
import { searchAndRank } from "../retrieve";

export function searchSourceContentTool({ userId }: { userId: string }) {
  return tool({
    description:
      "Search for specific content across processed source documents using hybrid search (vector + keyword) with relevance scoring. Returns ranked results with previews. Set includeContent=true to get full chunk text.",
    inputSchema: z.object({
      query: z
        .string()
        .describe("What to search for in source documents"),
      sourceId: z
        .string()
        .optional()
        .describe("Scope search to a specific source ID"),
      limit: z
        .number()
        .min(1)
        .max(20)
        .default(5)
        .describe("Maximum number of results (default 5, max 20)"),
      includeContent: z
        .boolean()
        .default(false)
        .describe("Include full chunk content (default false — returns previews only)"),
    }),
    execute: async ({ query, sourceId, limit, includeContent }) => {
      console.log(`[tool:searchSourceContent] query="${query}", sourceId=${sourceId ?? "all"}, limit=${limit}, includeContent=${includeContent}`);
      try {
        const results = await searchAndRank({
          query,
          userId,
          sourceId,
          limit,
        });

        if (results.length === 0) {
          return {
            results: [],
            message:
              "No matching content found. Source chunks may have expired (7-day TTL) — user can re-upload the source to refresh.",
          };
        }

        console.log(`[tool:searchSourceContent] Returning ${results.length} results`);
        return {
          results: results.map((r) => ({
            chunkId: r.chunkId,
            section: r.section,
            sourceId: r.sourceId,
            sourceTitle: r.sourceTitle,
            relevanceScore: Math.round(r.score * 100) / 100,
            preview: r.content.slice(0, 200),
            chunkIndex: r.chunkIndex,
            tokenCount: r.tokenCount,
            ...(includeContent ? { content: r.content } : {}),
          })),
          total: results.length,
        };
      } catch (error) {
        console.error("[searchSourceContent] Error:", error);
        return {
          results: [],
          message: `Search failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        };
      }
    },
  });
}
