import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemWalSession } from "../auth.js";
import { wrapTool, explorerFooter } from "./util.js";

const REMEMBER_BULK_INPUT = {
    facts: z
        .array(z.string().min(1))
        .min(1)
        .max(20)
        .describe(
            "Array of complete, detailed fact statements to save (1-20). Each entry is one full fact — do not summarize or merge them."
        ),
    namespace: z
        .string()
        .optional()
        .describe(
            "Optional namespace bucket applied to every fact. Defaults to the session's namespace when omitted."
        ),
} as const;

/**
 * memwal_remember_bulk — persist several durable facts in one batched request
 * and return only once every job reaches a terminal state. Wraps the SDK's
 * `rememberBulkAndWait` (embed + SEAL-encrypt all items concurrently, upload
 * N blobs in parallel). Prefer this over N separate `memwal_remember` calls
 * when you learned multiple distinct facts at once.
 */
export function registerRememberBulkTool(
    server: McpServer,
    session: MemWalSession
): void {
    server.tool(
        "memwal_remember_bulk",
        "Save multiple durable facts in one call. Use when you learned several distinct facts at once (onboarding details, a list of preferences, decisions from a discussion). Pass an array of complete fact statements (max 20) — do not summarize. Prefer this over repeated memwal_remember calls.",
        REMEMBER_BULK_INPUT,
        wrapTool<{ facts: string[]; namespace?: string }>(async ({ facts, namespace }) => {
            const items = facts.map((text) => ({ text, namespace }));
            const result = await session.memwal.rememberBulkAndWait(items, {
                timeoutMs: 120_000,
            });
            const lines = result.results.map((r, i) => {
                // Label each result with its source fact by index. The SDK
                // returns results in input order, but guard against a length /
                // ordering mismatch so we never print "— undefined".
                const text = facts[i] ?? "";
                const blob = r.blob_id ? ` blob_id=${r.blob_id}` : "";
                const err = r.error ? ` error=${r.error}` : "";
                return `${i + 1}. [${r.status}]${blob}${err}${text ? ` — ${text}` : ""}`;
            });
            const summary = `Saved ${result.succeeded}/${result.total} fact(s) to Walrus Memory (failed=${result.failed}).`;
            const footer = result.succeeded > 0 ? `\n\n${explorerFooter()}` : "";
            return {
                content: [
                    {
                        type: "text",
                        text:
                            lines.length > 0
                                ? `${summary}\n\n${lines.join("\n")}${footer}`
                                : `${summary}${footer}`,
                    },
                ],
            };
        })
    );
}
