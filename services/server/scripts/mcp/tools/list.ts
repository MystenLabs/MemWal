import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemWalSession } from "../auth.js";
import { wrapTool } from "./util.js";

const LIST_INPUT = {
    namespace: z
        .string()
        .min(1)
        .describe("Namespace bucket to enumerate."),
    limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe("Max memories per page (1-500)."),
    cursor: z
        .string()
        .optional()
        .describe(
            "Pagination cursor from a previous result's next_cursor. Omit for the first page."
        ),
} as const;

/**
 * memwal_list — enumerate the memories stored in a namespace, newest first.
 *
 * Returns METADATA only (id + creation time), not the memory text — listing is
 * decrypt-free, so it's cheap to call for auditing what's stored. Each entry's
 * `id` is the handle to pass to memwal_forget to delete that specific memory.
 * Use memwal_recall to read content. Owner-scoped; cleared/forgotten memories
 * are omitted.
 *
 * Paginated: one page per call. When the result says more remain, call again
 * with the reported cursor to continue.
 */
export function registerListTool(
    server: McpServer,
    session: MemWalSession
): void {
    server.tool(
        "memwal_list",
        "Enumerate the memories stored in a namespace (metadata only: id + created-at, newest first) to audit what's stored — does NOT return memory text (use memwal_recall for content). Each entry's id is the handle for memwal_forget to delete that specific memory. Paginated: returns one page; if more remain, call again passing the reported cursor. Owner-scoped; already-cleared memories are omitted.",
        LIST_INPUT,
        wrapTool<{ namespace: string; limit: number; cursor?: string }>(
            async ({ namespace, limit, cursor }) => {
                const result = await session.memwal.list(namespace, { limit, cursor });
                if (result.memories.length === 0) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Namespace "${result.namespace}" has no stored memories.`,
                            },
                        ],
                    };
                }
                const lines = result.memories.map(
                    (m, i) => `${i + 1}. id=${m.id}  created=${m.created_at}`
                );
                const more = result.has_more
                    ? `\n\nMore memories remain — call memwal_list again with cursor="${result.next_cursor}".`
                    : "";
                return {
                    content: [
                        {
                            type: "text",
                            text:
                                `${result.returned} memory(ies) in "${result.namespace}" this page ` +
                                `(metadata only — use the id with memwal_forget):\n` +
                                lines.join("\n") +
                                more,
                        },
                    ],
                };
            }
        )
    );
}
