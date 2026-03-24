import { z } from "zod";
import { tool } from "ai";
import { getChunksByIds } from "@/lib/db/queries";
import { CHUNK_TTL_MS } from "@/lib/rag/constants";
import { db } from "@/lib/db/drizzle";
import { sourceChunk } from "@/lib/db/schema";
import { inArray } from "drizzle-orm";

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

      // Extend TTL for accessed chunks
      const fetchedIds = chunks.map(c => c.id);
      if (fetchedIds.length > 0) {
        await db.update(sourceChunk)
          .set({ expiresAt: new Date(Date.now() + CHUNK_TTL_MS) })
          .where(inArray(sourceChunk.id, fetchedIds));
      }

      if (chunks.length === 0) {
        return {
          chunks: [],
          message: "No chunks found. They may have expired (30-day TTL).",
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
