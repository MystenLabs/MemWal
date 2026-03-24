/**
 * memory_search tool — semantic recall.
 *
 * Requires tools.allow config to be visible to the LLM.
 * Accepts an optional namespace parameter; the before_prompt_build hook
 * injects the current agent's namespace into the system prompt, guiding
 * the LLM to pass the correct value.
 */

import type { MemWal } from "@cmdoss/memwal";
import { Type } from "@sinclair/typebox";
import { looksLikeInjection } from "../capture.js";
import { escapeForPrompt, toolError } from "../format.js";
import type { PluginConfig } from "../types.js";

/** Register the memory_search agent tool. */
export function registerSearchTool(api: any, client: MemWal, config: PluginConfig): void {
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
        // LLM may omit namespace (e.g. tools.allow set but hooks disabled) — fall back safely
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

          // Filter out injection attempts and escape text before returning
          // to the LLM — same protection as the recall hook path
          const safe = result.results.filter(
            (r: any) => !looksLikeInjection(r.text),
          );

          if (!safe.length) {
            return {
              content: [
                { type: "text", text: "No relevant memories found." },
              ],
              details: { count: 0, namespace: ns },
            };
          }

          // MemWal returns L2 distance — convert to similarity % for readability
          const formatted = safe
            .map((r: any, i: number) => {
              const relevance = Math.round((1 - r.distance) * 100);
              return `${i + 1}. ${escapeForPrompt(r.text)} (${relevance}% relevance)`;
            })
            .join("\n");

          return {
            content: [
              {
                type: "text",
                text: `Found ${safe.length} memories:\n\n${formatted}`,
              },
            ],
            details: {
              count: safe.length,
              namespace: ns,
              memories: safe.map((r: any) => ({
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
}
