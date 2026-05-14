import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemWalSession } from "../auth.js";
import { wrapTool } from "./util.js";

const RECALL_INPUT = {
    query: z
        .string()
        .min(1)
        .describe("Natural-language search query to match against stored memories."),
    limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(10)
        .describe("Max number of memories to return (1-100)."),
    namespace: z
        .string()
        .optional()
        .describe(
            "Optional namespace bucket to search within. Defaults to the session's namespace."
        ),
} as const;

/**
 * memwal_recall — semantic search over the user's MemWal memories.
 *
 * Returns top-K most relevant memories (cosine distance over embeddings),
 * with the original plaintext decrypted server-side via SEAL.
 */
export function registerRecallTool(
    server: McpServer,
    session: MemWalSession
): void {
    server.tool(
        "memwal_recall",
        "Search the user's MemWal memory for facts relevant to a query. Returns matching memories ranked by relevance.",
        RECALL_INPUT,
        wrapTool<{ query: string; limit: number; namespace?: string }>(async ({ query, limit, namespace }) => {
            const result = await session.memwal.recall(query, limit, namespace);
            if (result.results.length === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "No matching memories found.",
                        },
                    ],
                };
            }
            const lines = result.results.map(
                (m, i) =>
                    `${i + 1}. [score=${(1 - m.distance).toFixed(3)}] ${m.text}`
            );
            return {
                content: [
                    {
                        type: "text",
                        text: lines.join("\n"),
                    },
                ],
            };
        })
    );
}
