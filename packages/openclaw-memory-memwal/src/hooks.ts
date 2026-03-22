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
import { resolveNamespace, resolveAgentName } from "./config.js";
import { shouldCapture } from "./capture.js";
import { formatMemoriesForPrompt, stripMemoryTags, withRetry } from "./format.js";
import type { PluginConfig } from "./types.js";

const MIN_PROMPT_LENGTH = 10;

export function registerHooks(api: any, client: MemWal, config: PluginConfig): void {
  // Auto-recall: inject relevant memories before each agent turn
  if (config.autoRecall) {
    api.on("before_prompt_build", async (event: any, ctx: any) => {
      if (!event.prompt || event.prompt.length < MIN_PROMPT_LENGTH) return;

      const namespace = resolveNamespace(config.defaultNamespace, ctx?.sessionKey);
      const agent = resolveAgentName(ctx?.sessionKey);

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
          (r: any) => (1 - r.distance) >= config.minRelevance,
        );

        if (!relevant.length) {
          return { appendSystemContext: namespaceInstruction };
        }

        api.logger.info(
          `memory-memwal: auto-recall injected ${relevant.length} memories ` +
          `(agent: ${agent}, namespace: ${namespace})`,
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
        // Still inject namespace instruction even if recall fails
        return { appendSystemContext: namespaceInstruction };
      }
    });
  }

  // Auto-capture: extract and store facts after each agent turn
  if (config.autoCapture) {
    api.on("agent_end", async (event: any, ctx: any) => {
      if (!event.success || !event.messages?.length) return;

      const namespace = resolveNamespace(config.defaultNamespace, ctx?.sessionKey);
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

        const conversation = texts.join("\n\n");

        // Skip trivial conversations (filler, emoji, short messages)
        if (!shouldCapture(conversation)) return;

        const result = await withRetry(() => client.analyze(conversation, namespace));

        if (result.facts?.length) {
          api.logger.info(
            `memory-memwal: auto-captured ${result.facts.length} facts ` +
            `(agent: ${agent}, namespace: ${namespace})`,
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
