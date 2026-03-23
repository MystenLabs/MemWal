/**
 * Lifecycle hooks — the invisible memory layer.
 *
 * before_prompt_build: search MemWal for relevant memories, inject into prompt
 * agent_end: extract conversation text, send to MemWal for fact extraction
 *
 * Each agent gets its own namespace derived from ctx.sessionKey.
 * Same key, same account — isolation via server-side namespace scoping.
 */

import type { MemWal } from "@cmdoss/memwal";
import { resolveAgent } from "./config.js";
import { shouldCapture, looksLikeInjection } from "./capture.js";
import {
  formatMemoriesForPrompt,
  extractMessageTexts,
  withRetry,
} from "./format.js";
import type { PluginConfig } from "./types.js";

const MIN_PROMPT_LENGTH = 10;

export function registerHooks(api: any, client: MemWal, config: PluginConfig): void {
  // Auto-recall: inject relevant memories before each agent turn
  if (config.autoRecall) {
    api.on("before_prompt_build", async (event: any, ctx: any) => {
      if (!event.prompt || event.prompt.length < MIN_PROMPT_LENGTH) return;

      const { namespace, agentName } = resolveAgent(config.defaultNamespace, ctx?.sessionKey);

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

  // Auto-capture: extract and store facts after each agent turn
  if (config.autoCapture) {
    api.on("agent_end", async (event: any, ctx: any) => {
      if (!event.success || !event.messages?.length) return;

      const { namespace, agentName } = resolveAgent(config.defaultNamespace, ctx?.sessionKey);

      try {
        // Extract clean message texts (without role prefixes)
        const texts = extractMessageTexts(
          event.messages,
          config.captureMaxMessages,
        );

        if (!texts.length) return;

        // Filter individual messages — skip if none are worth capturing
        const capturable = texts.filter((t) => shouldCapture(t));
        if (!capturable.length) {
          api.logger.debug?.(
            `memory-memwal: auto-capture skipped — no capturable content ` +
            `(agent: ${agentName}, ${texts.length} messages checked)`,
          );
          return;
        }

        // Join capturable messages for analyze
        const conversation = capturable
          .map((t, i) => `${i + 1}. ${t}`)
          .join("\n\n");

        const result = await withRetry(() => client.analyze(conversation, namespace));

        if (result.facts?.length) {
          api.logger.info(
            `memory-memwal: auto-captured ${result.facts.length} facts ` +
            `(agent: ${agentName}, namespace: ${namespace})`,
          );
        }
      } catch (err) {
        api.logger.warn(
          `memory-memwal: auto-capture failed: ${String(err)}`,
        );
      }
    });
  }
}
