import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemWalSession } from "../auth.js";
import { wrapTool } from "./util.js";

const ANALYZE_INPUT = {
    text: z
        .string()
        .min(1)
        .describe(
            "Conversation transcript, note, or arbitrary text from which to extract memorable facts."
        ),
    namespace: z
        .string()
        .optional()
        .describe(
            "Optional namespace bucket for the extracted facts. Defaults to the session's namespace."
        ),
} as const;

/**
 * memwal_analyze — let MemWal's LLM extract distinct facts from a piece of
 * text and persist each as its own memory. Resolves only after all extracted
 * facts have been written end-to-end (or the call times out).
 */
export function registerAnalyzeTool(
    server: McpServer,
    session: MemWalSession
): void {
    server.tool(
        "memwal_analyze",
        "Extract memorable facts from a passage of text (preferences, habits, biographical info, constraints) and save each as a separate MemWal memory.",
        ANALYZE_INPUT,
        wrapTool<{ text: string; namespace?: string }>(async ({ text, namespace }) => {
            const result = await session.memwal.analyzeAndWait(text, namespace, {
                timeoutMs: 180_000,
            });
            const lines = result.results.map(
                (r, i) =>
                    `${i + 1}. [${r.status}] ${
                        result.facts[i]?.text ?? "(unknown fact)"
                    }`
            );
            const summary = `Extracted ${result.facts.length} fact(s) — succeeded=${result.succeeded} failed=${result.failed}`;
            return {
                content: [
                    {
                        type: "text",
                        text:
                            lines.length > 0
                                ? `${summary}\n\n${lines.join("\n")}`
                                : summary,
                    },
                ],
            };
        })
    );
}
