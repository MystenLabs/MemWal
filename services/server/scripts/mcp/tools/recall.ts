import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemWalSession } from "../auth.js";
import { TOOL_METADATA } from "./annotations.js";
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

/** Key deciding whether two results say the same thing: trimmed, internal
 * whitespace collapsed, case-folded. Deliberately exact-after-normalization
 * rather than fuzzy or embedding-based — collapsing two facts that merely
 * resemble each other would silently hide real information. Near-duplicate
 * merging, if ever wanted, belongs behind an explicit opt-in. */
function dedupeKey(text: string): string {
    return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Collapse results carrying identical text, keeping the first occurrence.
 *
 * `recall` returns rows ranked best-first, so the survivor is the highest
 * scoring copy.
 *
 * Storing the same fact twice is legitimate: each write is a distinct event
 * with its own blob and timestamp, and there is no content-level uniqueness
 * constraint by design (the only unique index is request idempotency on
 * `remember_jobs (owner, idempotency_key)`). So this does NOT touch the write
 * path. But returning N identical lines spends the model's entire retrieval
 * budget on one fact and crowds out everything else it asked for, which is a
 * read-side problem worth fixing on the read side.
 */
export function collapseDuplicates<T extends { text: string }>(
    results: T[],
): { unique: T[]; collapsed: number } {
    const seen = new Map<string, T>();
    for (const item of results) {
        const key = dedupeKey(item.text);
        if (!seen.has(key)) seen.set(key, item);
    }
    const unique = [...seen.values()];
    return { unique, collapsed: results.length - unique.length };
}

/**
 * memwal_recall — semantic search over the user's Walrus Memory memories.
 *
 * Returns top-K most relevant memories (cosine distance over embeddings),
 * with the original plaintext decrypted server-side via SEAL.
 *
 * Call this PROACTIVELY at the start of a task, or whenever the user
 * references past work, prior decisions, or their preferences — don't wait
 * to be asked.
 */
export function registerRecallTool(
    server: McpServer,
    session: MemWalSession
): void {
    server.registerTool(
        "memwal_recall",
        {
            ...TOOL_METADATA.memwal_recall,
            description:
                "Search the user's Walrus Memory for relevant facts before responding. Call this PROACTIVELY at the start of a task, or whenever the user references past work, prior decisions, their preferences, or anything you may have stored earlier — don't wait to be asked. A single focused query is usually enough — recall is a real retrieval over encrypted storage, so do NOT fire multiple redundant searches for the same question. Returns matching memories ranked by relevance.",
            inputSchema: RECALL_INPUT,
        },
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
            const { unique, collapsed } = collapseDuplicates(result.results);
            const lines = unique.map(
                (m, i) =>
                    `${i + 1}. [score=${(1 - m.distance).toFixed(3)}] ${m.text}`
            );
            // Say what was folded away rather than quietly returning fewer rows
            // than the caller asked for. It also surfaces that the same fact was
            // stored repeatedly, which is usually worth knowing.
            if (collapsed > 0) {
                lines.push(
                    `\n(${collapsed} duplicate ${collapsed === 1 ? "copy" : "copies"} of the above collapsed; the same fact is stored more than once.)`
                );
            }
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
