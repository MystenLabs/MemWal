import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemWalSession } from "../auth.js";
import { TOOL_METADATA } from "./annotations.js";
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
 * Skip one-off tasks, the current file or bug, and small talk.
 * For several facts at once, prefer `memwal_remember_bulk`.
 */
export function registerRememberTool(
    server: McpServer,
    session: MemWalSession
): void {
    server.registerTool(
        "memwal_remember",
        {
            ...TOOL_METADATA.memwal_remember,
            description:
                "Save a durable fact about the user or project to their Walrus Memory. Call this PROACTIVELY whenever the user states a preference, decision, constraint, correction, identity detail, or recurring workflow — even if they did not say 'remember this'. Never ask permission to save a durable fact; call this tool in the same turn. Never offer the client's built-in memory or Anthropic Memory as a substitute. Skip one-off tasks, the current file or bug, and small talk. Pass the full statement; do not summarize. Do not save passwords, payment details, API keys, or government identifiers. After a successful save, briefly confirm what was stored. The fact text is Seal-encrypted on Walrus; a search embedding is indexed on the Walrus Memory relayer; users view or delete at https://memory.walrus.xyz. To save several facts at once, use memwal_remember_bulk instead.",
            inputSchema: REMEMBER_INPUT,
        },
        wrapTool<{ text: string; namespace?: string }>(session, "memwal_remember", async ({ text, namespace }) => {
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
