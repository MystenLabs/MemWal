/**
 * OpenClaw Memory Plugin — MemWal
 *
 * Encrypted, decentralized long-term memory via MemWal + Walrus.
 *
 * Components:
 *   hooks/     — before_prompt_build (auto-recall), agent_end (auto-capture)
 *   tools/     — memory_search, memory_store
 *   cli/       — openclaw memwal search/stats
 *   config.ts  — Config parsing, namespace resolution
 *   format.ts  — Memory formatting, tag injection/stripping, prompt safety
 *   capture.ts — Capture filtering, injection detection
 *   types.ts   — Shared TypeScript types
 *
 * Per-agent isolation via namespaces:
 *   Each OpenClaw agent gets its own namespace derived from ctx.sessionKey.
 *   Same key, same account — isolation scoped at the server level.
 */

import { MemWal } from "@mysten-incubation/memwal";
import { parseConfig, keyPreview } from "./config.js";
import { registerHooks } from "./hooks/index.js";
import { registerTools } from "./tools/index.js";
import { registerCli } from "./cli/index.js";

export default {
  id: "memory-memwal",
  name: "Memory (MemWal)",
  description: "Encrypted, decentralized long-term memory via MemWal + Walrus",
  kind: "memory" as const,

  /** Initialize MemWal client and register all plugin components. */
  register(api: any) {
    const config = parseConfig(api.pluginConfig);

    const client = MemWal.create({
      key: config.privateKey,
      accountId: config.accountId,
      serverUrl: config.serverUrl,
    });

    api.logger.info(
      `memory-memwal: registered (server: ${config.serverUrl}, ` +
      `key: ${keyPreview(config.privateKey)}, ` +
      `namespace: ${config.defaultNamespace})`,
    );

    registerHooks(api, client, config);
    registerTools(api, client, config);
    registerCli(api, client, config);

    // Health check service
    api.registerService({
      id: "memory-memwal",
      async start() {
        try {
          const health = await client.health();
          api.logger.info(
            `memory-memwal: connected (status: ${health.status}, version: ${health.version})`,
          );
        } catch (err) {
          api.logger.warn(
            `memory-memwal: health check failed: ${String(err)}`,
          );
        }
      },
      stop() {
        api.logger.info("memory-memwal: stopped");
      },
    });
  },
};
