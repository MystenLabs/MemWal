import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemWalSession } from "../auth.js";
import { wrapTool } from "./util.js";

const RESTORE_INPUT = {
    namespace: z
        .string()
        .min(1)
        .describe("Namespace bucket to restore. Server re-indexes every blob in this namespace."),
    limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe("Max number of memories to re-index (1-500)."),
} as const;

/**
 * memwal_restore — re-index a namespace by re-downloading every blob from
 * Walrus, SEAL-decrypting, and re-embedding into the relayer's vector store.
 *
 * Use when: the user's local search index is empty / corrupted, or when
 * switching servers. After restore, `memwal_recall` returns fresh results.
 * The tool returns counts only (restored / skipped / total); it does NOT
 * stream back the decrypted memory texts.
 */
export function registerRestoreTool(
    server: McpServer,
    session: MemWalSession
): void {
    server.tool(
        "memwal_restore",
        "Re-index a namespace from Walrus blobs back into the relayer's search index. Returns counts only (restored / skipped / total) — does not return memory texts. Call `memwal_recall` afterwards to query the rebuilt index.",
        RESTORE_INPUT,
        wrapTool<{ namespace: string; limit: number }>(async ({ namespace, limit }) => {
            const result = await session.memwal.restore(namespace, limit);
            return {
                content: [
                    {
                        type: "text",
                        text:
                            `Restore complete for namespace "${result.namespace}":\n` +
                            `  total=${result.total}  restored=${result.restored}  skipped=${result.skipped}`,
                    },
                ],
            };
        })
    );
}
