/**
 * Agent-callable tools — memory_search and memory_store.
 * Require tools.allow config to be visible to the LLM.
 *
 * Tools accept an optional namespace parameter. The before_prompt_build hook
 * injects the current agent's namespace into the system prompt, guiding the
 * LLM to pass the correct namespace. Falls back to defaultNamespace if omitted.
 */

import type { MemWal } from "@cmdoss/memwal";
import { Type } from "@sinclair/typebox";
import { toolError } from "./format.js";
import type { PluginConfig } from "./types.js";

export function registerTools(api: any, client: MemWal, config: PluginConfig): void {
  // memory_search — semantic recall
  api.registerTool(
    {
      name: "memory_search",
      label: "Memory Search",
      description:
        "Search long-term memory for relevant past information, facts, " +
        "preferences, and decisions. Returns memories ranked by relevance. " +
        "Pass the namespace parameter to scope the search to the current agent's memory.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
        limit: Type.Optional(
          Type.Number({ description: "Max results (default: 5)" }),
        ),
        namespace: Type.Optional(
          Type.String({
            description: "Memory namespace to search (use the namespace from system context)",
          }),
        ),
      }),
      async execute(_id: string, params: any) {
        const { query, limit = 5, namespace } = params;
        const ns = namespace || config.defaultNamespace;

        try {
          const result = await client.recall(query, limit, ns);

          if (!result.results?.length) {
            return {
              content: [
                { type: "text", text: "No relevant memories found." },
              ],
              details: { count: 0, namespace: ns },
            };
          }

          const formatted = result.results
            .map((r: any, i: number) => {
              const relevance = Math.round((1 - r.distance) * 100);
              return `${i + 1}. ${r.text} (${relevance}% relevance)`;
            })
            .join("\n");

          return {
            content: [
              {
                type: "text",
                text: `Found ${result.results.length} memories:\n\n${formatted}`,
              },
            ],
            details: {
              count: result.results.length,
              namespace: ns,
              memories: result.results.map((r: any) => ({
                text: r.text,
                blob_id: r.blob_id,
                relevance: Math.round((1 - r.distance) * 100) / 100,
              })),
            },
          };
        } catch (err) {
          return toolError("Memory search failed", err);
        }
      },
    },
    { name: "memory_search" },
  );

  // memory_store — explicit save
  api.registerTool(
    {
      name: "memory_store",
      label: "Memory Store",
      description:
        "Save important information to encrypted long-term memory. " +
        "Use when the user asks to remember something or when you " +
        "identify important facts worth preserving. " +
        "Pass the namespace parameter to store in the current agent's memory.",
      parameters: Type.Object({
        text: Type.String({
          description: "Information to store in memory",
        }),
        namespace: Type.Optional(
          Type.String({
            description: "Memory namespace to store in (use the namespace from system context)",
          }),
        ),
      }),
      async execute(_id: string, params: any) {
        const { text, namespace } = params;
        const ns = namespace || config.defaultNamespace;

        if (!text || text.trim().length < 3) {
          return {
            content: [
              {
                type: "text",
                text: "Cannot store empty or very short text.",
              },
            ],
            details: { error: "text_too_short" },
          };
        }

        try {
          const result = await client.remember(text.trim(), ns);

          return {
            content: [
              {
                type: "text",
                text: `Stored in memory: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`,
              },
            ],
            details: {
              action: "created",
              namespace: ns,
              id: result.id,
              blob_id: result.blob_id,
            },
          };
        } catch (err) {
          return toolError("Failed to store memory", err);
        }
      },
    },
    { name: "memory_store" },
  );
}
