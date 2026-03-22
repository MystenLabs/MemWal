/**
 * Lifecycle hooks — the invisible memory layer.
 *
 * before_prompt_build: search MemWal for relevant memories, inject into prompt
 * agent_end: extract conversation text, send to MemWal for fact extraction
 */

import { createClient } from "./client.js";
import { resolveKey, resolveAgentName, keyPreview } from "./config.js";
import { formatMemoriesForPrompt, stripMemoryTags } from "./format.js";
import type { PluginConfig } from "./types.js";

const MIN_PROMPT_LENGTH = 10;

export function registerHooks(api: any, config: PluginConfig): void {
  // Auto-recall: inject relevant memories before each agent turn
  if (config.autoRecall) {
    api.on("before_prompt_build", async (event: any, ctx: any) => {
      if (!event.prompt || event.prompt.length < MIN_PROMPT_LENGTH) return;

      const resolved = resolveKey(config, ctx?.sessionKey);
      const agent = resolveAgentName(ctx?.sessionKey);

      try {
        const client = await createClient(resolved.key, resolved.accountId, config);
        const result = await client.recall(
          event.prompt,
          config.maxRecallResults,
        );

        if (!result.results?.length) return;

        const relevant = result.results.filter(
          (r) => (1 - r.distance) >= config.minRelevance,
        );
        if (!relevant.length) return;

        api.logger.info(
          `memory-memwal: auto-recall injected ${relevant.length} memories ` +
          `(agent: ${agent}, key: ${keyPreview(resolved.key)})`,
        );

        return {
          prependContext: formatMemoriesForPrompt(
            relevant.map((r) => ({ text: r.text })),
          ),
        };
      } catch (err) {
        api.logger.warn(
          `memory-memwal: auto-recall failed: ${String(err)}`,
        );
      }
    });
  }

  // Auto-capture: extract and store facts after each agent turn
  if (config.autoCapture) {
    api.on("agent_end", async (event: any, ctx: any) => {
      if (!event.success || !event.messages?.length) return;

      const resolved = resolveKey(config, ctx?.sessionKey);
      const agent = resolveAgentName(ctx?.sessionKey);

      try {
        const texts: string[] = [];
        const recent = event.messages.slice(-config.captureMaxMessages);

        for (const msg of recent) {
          if (!msg || typeof msg !== "object") continue;
          if (msg.role !== "user" && msg.role !== "assistant") continue;

          let text = "";
          if (typeof msg.content === "string") {
            text = msg.content;
          } else if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (
                block?.type === "text" &&
                typeof block.text === "string"
              ) {
                text += block.text + "\n";
              }
            }
          }

          text = stripMemoryTags(text).trim();
          if (text.length > 10) {
            texts.push(`[${msg.role}]: ${text}`);
          }
        }

        if (!texts.length) return;

        const client = await createClient(resolved.key, resolved.accountId, config);
        const result = await client.analyze(texts.join("\n\n"));

        if (result.facts?.length) {
          api.logger.info(
            `memory-memwal: auto-captured ${result.facts.length} facts ` +
            `(agent: ${agent}, key: ${keyPreview(resolved.key)})`,
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
