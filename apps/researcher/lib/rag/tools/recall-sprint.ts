import { z } from "zod";
import { tool } from "ai";
import { recallFromMemWal } from "@/lib/sprint/memwal";

export function recallSprintTool({ memwalKey, accountId }: { memwalKey: string; accountId?: string }) {
  console.log(`[tool:recallSprint] Tool created with memwalKey=${memwalKey ? memwalKey.slice(0, 8) + "..." : "MISSING"}`);

  return tool({
    description:
      "Search long-term research memory for relevant past findings, facts, and details from previous research sprints. Use this when you need deeper detail than what's in the sprint summaries, or to cross-reference across sprints.",
    inputSchema: z.object({
      query: z
        .string()
        .describe("Search query for research memories"),
      limit: z
        .number()
        .min(1)
        .max(10)
        .default(5)
        .describe("Maximum number of memory results to return"),
    }),
    execute: async ({ query, limit }) => {
      console.log(
        `[tool:recallSprint] >>> CALLED with query="${query}", limit=${limit}, memwalKey=${memwalKey.slice(0, 8)}...`
      );
      try {
        const startTime = Date.now();
        const results = await recallFromMemWal(memwalKey, query, limit, accountId);
        const elapsed = Date.now() - startTime;

        console.log(
          `[tool:recallSprint] <<< MemWal returned ${results.length} results in ${elapsed}ms`
        );

        if (results.length === 0) {
          console.log(`[tool:recallSprint] No matches found`);
          return {
            results: [],
            message: "No matching memories found for this query.",
          };
        }

        // Log each result's relevance and text preview
        for (const [i, r] of results.entries()) {
          console.log(
            `[tool:recallSprint] Result[${i}] relevance=${r.relevance.toFixed(3)} text="${r.text.slice(0, 120)}..."`
          );
        }

        return {
          results: results.map((r) => ({
            text: r.text,
            relevance: Math.round(r.relevance * 100) / 100,
          })),
          total: results.length,
        };
      } catch (error) {
        console.error("[tool:recallSprint] ERROR:", error);
        return {
          results: [],
          message: `Memory recall failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        };
      }
    },
  });
}
