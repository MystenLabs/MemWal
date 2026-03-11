import { z } from "zod";
import { tool } from "ai";
import { getChunksByIds } from "@/lib/db/queries";

export function getChunkContentTool({ userId }: { userId: string }) {
  return tool({
    description:
      "Retrieve the full text content of specific chunks by their IDs. Use this after searchSourceContent to read the actual content of relevant chunks.",
    inputSchema: z.object({
      chunkIds: z
        .array(z.string())
        .min(1)
        .max(10)
        .describe("Array of chunk IDs to retrieve (max 10)"),
    }),
    execute: async ({ chunkIds }) => {
      console.log(`[tool:getChunkContent] Fetching ${chunkIds.length} chunks: ${chunkIds.join(", ")}`);
      const chunks = await getChunksByIds({ chunkIds, userId });

      if (chunks.length === 0) {
        return {
          chunks: [],
          message: "No chunks found. They may have expired (7-day TTL).",
        };
      }

      console.log(`[tool:getChunkContent] Returning ${chunks.length} chunks`);
      return {
        chunks: chunks.map((c) => ({
          chunkId: c.id,
          section: c.section,
          content: c.content,
          sourceId: c.sourceId,
          sourceTitle: c.sourceTitle,
          chunkIndex: c.chunkIndex,
          tokenCount: c.tokenCount,
        })),
        total: chunks.length,
      };
    },
  });
}
