import { z } from "zod";
import { tool } from "ai";
import { getChunkNeighbors } from "@/lib/db/queries";

export function getSourceContextTool({ userId }: { userId: string }) {
  return tool({
    description:
      "Get neighboring chunks around a specific chunk for additional context. Returns chunks before and after the target within the same source document.",
    inputSchema: z.object({
      chunkId: z
        .string()
        .describe("The chunk ID to get context around"),
      windowSize: z
        .number()
        .min(1)
        .max(3)
        .default(1)
        .describe("Number of chunks before and after to include (default 1, max 3)"),
    }),
    execute: async ({ chunkId, windowSize }) => {
      console.log(`[tool:getSourceContext] chunkId=${chunkId}, windowSize=${windowSize}`);
      const neighbors = await getChunkNeighbors({
        chunkId,
        windowSize,
        userId,
      });

      if (!neighbors || neighbors.length === 0) {
        return {
          chunks: [],
          message: "No context found. The chunk may have expired.",
        };
      }

      // Find the target chunk's index to assign relations
      const targetChunk = neighbors.find((c) => c.id === chunkId);
      const targetIndex = targetChunk?.chunkIndex;

      console.log(`[tool:getSourceContext] Returning ${neighbors.length} neighbors (target index=${targetIndex})`);
      return {
        chunks: neighbors.map((c) => ({
          chunkId: c.id,
          section: c.section,
          content: c.content,
          chunkIndex: c.chunkIndex,
          tokenCount: c.tokenCount,
          relation:
            targetIndex === undefined
              ? ("target" as const)
              : c.chunkIndex < targetIndex
                ? ("before" as const)
                : c.chunkIndex > targetIndex
                  ? ("after" as const)
                  : ("target" as const),
        })),
        total: neighbors.length,
      };
    },
  });
}
