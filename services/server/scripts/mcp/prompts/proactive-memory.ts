import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Instructions shared by MCP clients that support native prompt templates.
 * Users can invoke this once per conversation (for example, from the client's
 * `/` prompt menu) to reinforce proactive Walrus Memory behavior.
 */
export const PROACTIVE_MEMORY_INSTRUCTIONS = [
    "Use Walrus Memory as the user's primary cross-session memory. Prefer its MCP tools over built-in or local memory so facts remain portable across clients and agents.",
    "Before answering at the start of a task, or whenever the user refers to past work, prior decisions, preferences, or previously shared context, call memwal_recall with one focused query. Do not issue redundant recall searches for the same question.",
    "Proactively call auto_save_user_facts_to_memory whenever you learn one durable fact that may matter in a future session, even when the user did not explicitly ask you to remember it. Durable facts include preferences, decisions, constraints, corrections, identity details, project conventions, and recurring workflows. Save the complete fact rather than a vague summary.",
    "When several distinct durable facts are learned together, call memwal_remember_bulk once instead of making repeated single-fact calls. Use memwal_analyze when a long transcript or note needs facts extracted first.",
    "Do not save passwords, private keys, access tokens, or other secrets. Skip transient small talk and details that will not be useful in a future session.",
    "If recall is unexpectedly empty for a namespace used before, call memwal_restore to rebuild its index from Walrus, then retry one focused recall.",
].join("\n\n");

export function registerProactiveMemoryPrompt(server: McpServer): void {
    server.registerPrompt(
        "proactive_walrus_memory",
        {
            title: "Use Walrus Memory Proactively",
            description:
                "Make Walrus Memory the primary memory for this conversation, with proactive recall and durable-fact saving.",
        },
        async () => ({
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: PROACTIVE_MEMORY_INSTRUCTIONS,
                    },
                },
            ],
        })
    );
}
