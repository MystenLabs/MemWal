/**
 * MEMORY ROUTER — tRPC routes for memory operations (v2 SDK)
 *
 * Uses MemWal SDK: recall for search, remember for save.
 */

import { router, protectedProcedure } from "@/shared/lib/trpc/init";
import { z } from "zod";
import { recallMemories, rememberText } from "@/feature/note/lib/pdw-client";

export const memoryRouter = router({
  /**
   * Search user memories using MemWal recall.
   * Server handles: embed query → vector search → Walrus download → decrypt.
   */
  search: protectedProcedure
    .input(
      z.object({
        query: z.string().min(1, "Query cannot be empty"),
        limit: z.number().min(1).max(50).optional().default(10),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const result = await recallMemories(input.query, input.limit);

        const memories = result.results.map((r) => ({
          text: r.text,
          distance: r.distance,
          similarity: 1 - r.distance,
        }));
        return {
          query: input.query,
          memories,
          count: memories.length,
        };
      } catch (error) {
        console.error("[memory.search] Error:", error);
        return {
          query: input.query,
          memories: [],
          count: 0,
          error: "Memory search unavailable",
        };
      }
    }),

  /**
   * Save a single memory via MemWal remember.
   * Server handles: embed → encrypt → Walrus upload → store.
   */
  save: protectedProcedure
    .input(
      z.object({
        text: z.string().min(1, "Text cannot be empty"),
      })
    )
    .mutation(async ({ input }) => {
      const result = await rememberText(input.text);      return result;
    }),
});
