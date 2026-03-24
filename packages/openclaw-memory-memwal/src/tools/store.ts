/**
 * memory_store tool — explicit save.
 *
 * Uses analyze() instead of remember() so the server LLM extracts
 * individual facts from the text, producing cleaner, more searchable
 * memories (same approach as Mem0's memory_store).
 */

import type { MemWal } from "@cmdoss/memwal";
import { Type } from "@sinclair/typebox";
import { looksLikeInjection } from "../capture.js";
import { toolError } from "../format.js";
import type { PluginConfig } from "../types.js";

/** Register the memory_store agent tool. */
export function registerStoreTool(api: any, client: MemWal, config: PluginConfig): void {
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

        // Defence in depth: reject injection on write, not just on read.
        // The recall hook filters on retrieval, but polluted data could
        // surface through other read paths (memory_search, future tools).
        if (looksLikeInjection(text)) {
          return {
            content: [
              {
                type: "text",
                text: "Cannot store text containing disallowed patterns.",
              },
            ],
            details: { error: "injection_rejected" },
          };
        }

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
          const result = await client.analyze(text.trim(), ns);

          const factCount = result.facts?.length ?? 0;
          // Show first 3 extracted facts as confirmation, or raw text truncation as fallback
          const preview = result.facts
            ?.map((f: any) => f.text)
            .slice(0, 3)
            .join("; ") ?? text.slice(0, 100);

          return {
            content: [
              {
                type: "text",
                text: factCount > 0
                  ? `Stored ${factCount} fact${factCount === 1 ? "" : "s"}: ${preview}`
                  : `No memorable facts extracted from the input.`,
              },
            ],
            details: {
              action: "created",
              namespace: ns,
              factCount,
              facts: result.facts,
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
