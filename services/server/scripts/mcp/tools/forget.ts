import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemWalSession } from "../auth.js";
import { wrapTool } from "./util.js";

const FORGET_INPUT = {
    id: z
        .string()
        .min(1)
        .describe("The memory id to forget (from a memwal_list entry)."),
} as const;

/**
 * memwal_forget — soft-delete a SINGLE memory by its id (from memwal_list). The
 * memory stops surfacing in recall; an identical-text memory stored separately
 * is unaffected (deletion is per-memory, not per-content).
 *
 * Like memwal_clear_namespace, this clears retrievability — the underlying
 * Walrus blob is user-owned and persists. Owner-scoped: forgetting an id that
 * isn't the caller's is a no-op (forgotten=0).
 */
export function registerForgetTool(
    server: McpServer,
    session: MemWalSession
): void {
    server.tool(
        "memwal_forget",
        "Soft-delete a single memory by its id (obtained from memwal_list) so it stops surfacing in memwal_recall. Deletion is per-memory, not per-content — an identical-text memory stored separately is unaffected. Owner-scoped. forgotten=0 is a safe no-op (id never existed, isn't yours, or already gone), not a failure — don't treat it as an error. Clears retrievability, not the underlying Walrus blob.",
        FORGET_INPUT,
        wrapTool<{ id: string }>(async ({ id }) => {
            const result = await session.memwal.forget(id);
            const text =
                result.forgotten === 1
                    ? `Forgot memory id=${result.id} (now un-recallable).`
                    : `No memory forgotten for id=${result.id} (not found, not yours, or already forgotten).`;
            return {
                content: [{ type: "text", text }],
            };
        })
    );
}
