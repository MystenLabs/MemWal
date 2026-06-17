import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemWalSession } from "../auth.js";
import { wrapTool } from "./util.js";

const CLEAR_NAMESPACE_INPUT = {
    namespace: z
        .string()
        .min(1)
        .describe("Namespace bucket to clear. Every memory in it stops surfacing in recall."),
} as const;

/**
 * memwal_clear_namespace — soft-delete every memory in a namespace so it stops
 * being recalled. Use to reset an agent's memory between iterations (replaces
 * the namespace-rotation workaround).
 *
 * Soft-delete clears *retrievability*: the memories no longer come back from
 * recall, but the underlying Walrus blobs are user-owned and persist until
 * deleted on-chain or their storage epoch expires — "cleared" means
 * "un-recallable", not "cryptographically erased". Owner-scoped.
 */
export function registerClearNamespaceTool(
    server: McpServer,
    session: MemWalSession
): void {
    server.tool(
        "memwal_clear_namespace",
        "Soft-delete every memory in a namespace so it stops surfacing in memwal_recall — use to reset a namespace between iterations instead of abandoning it. Owner-scoped (only the caller's own memories). Note: this clears retrievability, not the underlying Walrus blob (which is user-owned and persists until on-chain deletion / storage-epoch expiry) — \"cleared\" means \"un-recallable\", not \"erased\". cleared=0 is a safe no-op (already empty/cleared), not a failure. Clears what exists at call time — a memory still being saved when you clear may survive, so clear after writes have settled. Returns the count of memories cleared.",
        CLEAR_NAMESPACE_INPUT,
        wrapTool<{ namespace: string }>(async ({ namespace }) => {
            const result = await session.memwal.clearNamespace(namespace);
            return {
                content: [
                    {
                        type: "text",
                        text: `Cleared namespace "${result.namespace}": cleared=${result.cleared} (now un-recallable).`,
                    },
                ],
            };
        })
    );
}
