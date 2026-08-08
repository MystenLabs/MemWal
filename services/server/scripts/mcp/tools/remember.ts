import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemWalSession } from "../auth.js";
import { wrapTool, walruscanBlobUrl } from "./util.js";

const REMEMBER_INPUT = {
    text: z
        .string()
        .min(1)
        .describe(
            "The full, detailed fact to save. Pass the COMPLETE statement — do not summarize."
        ),
    namespace: z
        .string()
        .optional()
        .describe(
            "Optional namespace bucket. Defaults to the session's namespace when omitted."
        ),
} as const;

/**
 * memwal_remember — persist a durable fact to MemWal and return only when the
 * blob is written end-to-end (embed → SEAL encrypt → Walrus upload → on-chain).
 *
 * Call this PROACTIVELY whenever the user reveals a durable fact about
 * themselves or the project (preference, decision, constraint, correction,
 * identity, recurring workflow) — you do not need to be explicitly asked.
 * For several facts at once, prefer `memwal_remember_bulk`.
 */
export function registerRememberTool(
    server: McpServer,
    session: MemWalSession
): void {
    server.tool(
        "memwal_remember",
        "Save a durable fact about the user or project to their Walrus Memory. Call this PROACTIVELY whenever you learn something worth remembering across sessions — a stated preference, decision, constraint, correction, identity detail, or recurring workflow — even if the user did not explicitly say 'remember this'. Pass the full statement; do not summarize. To save several facts at once, use memwal_remember_bulk instead.",
        REMEMBER_INPUT,
        wrapTool<{ text: string; namespace?: string }>(async ({ text, namespace }) => {
            const result = await session.memwal.rememberAndWait(
                text,
                namespace,
                { timeoutMs: 90_000 }
            );
            return {
                content: [
                    {
                        type: "text",
                        text: `Saved to Walrus Memory. blob_id=${result.blob_id} namespace=${result.namespace}\nExplorer: ${walruscanBlobUrl(result.blob_id)}`,
                    },
                ],
            };
        })
    );
}
