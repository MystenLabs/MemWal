/**
 * Auto-recall hook — before_prompt_build.
 */

import type { MemWal } from "@mysten-incubation/memwal";
import { resolveAgent } from "../config.js";
import { looksLikeInjection } from "../capture.js";
import { formatMemoriesForPrompt } from "../format.js";
import type { PluginConfig } from "../types.js";
import { MIN_PROMPT_LENGTH } from "../constants.js";

/** Register the before_prompt_build hook for auto-recall. */
export function registerRecallHook(api: any, client: MemWal, config: PluginConfig): void {
  api.on("before_prompt_build", async (event: any, ctx: any) => {
    if (!event.prompt || event.prompt.length < MIN_PROMPT_LENGTH) return;

    const { namespace, legacyNamespace, agentName } = resolveAgent(config.defaultNamespace, ctx?.sessionKey);
    const namespaceInstruction =
      `When using memory_search or memory_store tools, ` +
      `pass namespace=${JSON.stringify(namespace)} to scope operations to the current agent's memory.`;

    try {
      const recallPromises = [
        client.recall(event.prompt, config.maxRecallResults, namespace),
      ];

      if (legacyNamespace && legacyNamespace !== namespace) {
        recallPromises.push(
          client.recall(event.prompt, config.maxRecallResults, legacyNamespace),
        );
      }

      const resultsList = await Promise.allSettled(recallPromises);
      const primaryResult = resultsList[0];
      if (primaryResult?.status === "rejected") {
        api.logger.warn(
          `memory-memwal: canonical recall failed: ${String(primaryResult.reason)}`,
        );
      }

      const candidates: any[] = [];
      const seen = new Set<string>();

      for (const res of resultsList) {
        if (res.status === "fulfilled" && res.value?.results?.length) {
          for (const item of res.value.results) {
            const key = item.blob_id || item.text;
            if (!seen.has(key)) {
              seen.add(key);
              candidates.push(item);
            }
          }
        }
      }

      if (!candidates.length) {
        return { appendSystemContext: namespaceInstruction };
      }

      const filtered = candidates.filter(
        (r: any) =>
          (1 - r.distance) >= config.minRelevance &&
          !looksLikeInjection(r.text),
      );

      if (!filtered.length) {
        return { appendSystemContext: namespaceInstruction };
      }

      filtered.sort((a: any, b: any) => a.distance - b.distance);
      const relevant = filtered.slice(0, config.maxRecallResults);

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
