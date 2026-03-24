/**
 * Auto-recall hook — before_prompt_build.
 *
 * Searches MemWal for memories relevant to the user's prompt and injects
 * them into the LLM context. Also injects a namespace instruction so
 * tools scope to the correct agent's memory.
 */

import type { MemWal } from "@cmdoss/memwal";
import { resolveAgent } from "../config.js";
import { looksLikeInjection } from "../capture.js";
import { formatMemoriesForPrompt } from "../format.js";
import type { PluginConfig } from "../types.js";

const MIN_PROMPT_LENGTH = 10;

/** Register the before_prompt_build hook for auto-recall. */
export function registerRecallHook(api: any, client: MemWal, config: PluginConfig): void {
  api.on("before_prompt_build", async (event: any, ctx: any) => {
    // Skip trivial prompts ("ok", "y") — not worth a server round-trip
    if (!event.prompt || event.prompt.length < MIN_PROMPT_LENGTH) return;

    const { namespace, agentName } = resolveAgent(config.defaultNamespace, ctx?.sessionKey);

    // The LLM doesn't know which agent it is. This instruction guides
    // memory_search/memory_store tool calls to the correct namespace.
    // Returned via appendSystemContext in ALL code paths (including errors)
    // so tools still scope correctly even when recall itself fails.
    const namespaceInstruction =
      `When using memory_search or memory_store tools, ` +
      `pass namespace="${namespace}" to scope operations to the current agent's memory.`;

    try {
      const result = await client.recall(
        event.prompt,
        config.maxRecallResults,
        namespace,
      );

      if (!result.results?.length) {
        return { appendSystemContext: namespaceInstruction };
      }

      // Two filters: relevance threshold (drop noise) and injection
      // detection (drop memories containing prompt manipulation attempts)
      const relevant = result.results.filter(
        (r: any) =>
          (1 - r.distance) >= config.minRelevance &&
          !looksLikeInjection(r.text),
      );

      if (!relevant.length) {
        return { appendSystemContext: namespaceInstruction };
      }

      api.logger.info(
        `memory-memwal: auto-recall injected ${relevant.length} memories ` +
        `(agent: ${agentName}, namespace: ${namespace})`,
      );

      return {
        prependContext: formatMemoriesForPrompt(
          relevant.map((r: any) => ({ text: r.text })),
        ),
        appendSystemContext: namespaceInstruction,
      };
    } catch (err) {
      api.logger.warn(
        `memory-memwal: auto-recall failed: ${String(err)}`,
      );
      return { appendSystemContext: namespaceInstruction };
    }
  });
}
