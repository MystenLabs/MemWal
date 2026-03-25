/**
 * Auto-capture hook — agent_end.
 *
 * After the LLM finishes a turn, extracts conversation text, filters
 * for capturable content, and sends to MemWal's analyze() endpoint
 * for server-side fact extraction.
 */

import type { MemWal } from "@mysten-incubation/memwal";
import { resolveAgent } from "../config.js";
import { shouldCapture } from "../capture.js";
import { extractMessageTexts, withRetry } from "../format.js";
import type { PluginConfig } from "../types.js";

/** Register the agent_end hook for auto-capture. */
export function registerCaptureHook(api: any, client: MemWal, config: PluginConfig): void {
  api.on("agent_end", async (event: any, ctx: any) => {
    if (!event.success || !event.messages?.length) return;

    const { namespace, agentName } = resolveAgent(config.defaultNamespace, ctx?.sessionKey);

    try {
      // Extract both user and assistant messages — the server LLM on analyze()
      // decides what's worth keeping. Assistant messages can contain user
      // commitments, decisions, and summaries that are valuable as memories.
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

      // Numbered list helps the server LLM distinguish separate messages
      // during fact extraction (vs one big wall of text)
      const conversation = capturable
        .map((t, i) => `${i + 1}. ${t}`)
        .join("\n\n");

      // analyze() calls the server LLM for fact extraction — retry once
      // since transient failures are common with remote LLM calls
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
