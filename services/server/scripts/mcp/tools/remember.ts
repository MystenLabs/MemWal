import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemWalSession } from "../auth.js";
import { wrapTool } from "./util.js";

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
 * memwal_remember — persist a fact to MemWal and return only when the blob
 * is written end-to-end (embed → SEAL encrypt → Walrus upload → on-chain).
 *
 * Use ONLY when the user explicitly asks to save something. Agents should
 * not call this proactively on arbitrary chat content.
 */
export function registerRememberTool(
    server: McpServer,
    session: MemWalSession
): void {
    server.tool(
        "memwal_remember",
        "Save a fact to the user's MemWal personal memory. Call ONLY when the user explicitly asks to remember/save something. Pass the full, detailed text — never summarize.",
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
                        text: `Saved to MemWal. blob_id=${result.blob_id} namespace=${result.namespace}`,
                    },
                ],
            };
        })
    );
}
