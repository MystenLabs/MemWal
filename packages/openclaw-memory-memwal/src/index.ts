/**
 * OpenClaw Memory Plugin — MemWal
 *
 * Encrypted, decentralized long-term memory via MemWal + Walrus.
 * Supports mock mode for demo/testing without a real server.
 *
 * Components:
 *   hooks.ts   — before_prompt_build (auto-recall), agent_end (auto-capture)
 *   tools.ts   — memory_search, memory_store
 *   cli.ts     — openclaw memwal search/stats/keys/list
 *   client.ts  — MemWal SDK client factory (mock or real)
 *   config.ts  — Config parsing, validation, per-agent key resolution
 *   format.ts  — Memory formatting, tag injection/stripping, prompt safety
 *   mock.ts    — In-memory mock client for demo/testing
 *   types.ts   — Shared TypeScript types
 *
 * Per-agent isolation:
 *   Each agent can have its own Ed25519 key via agentKeys config.
 *   Keys from different MemWalAccounts = cryptographic memory isolation.
 *   Default privateKey used for agents without a specific key.
 */

import { parseConfig } from "./config.js";
import { createClient } from "./client.js";
import { registerHooks } from "./hooks.js";
import { registerTools } from "./tools.js";
import { registerCli } from "./cli.js";
import type { PluginConfig } from "./types.js";

export default {
  id: "memory-memwal",
  name: "Memory (MemWal)",
  description: "Encrypted, decentralized long-term memory via MemWal + Walrus",
  kind: "memory" as const,

  register(api: any) {
    const config = parseConfig(api.pluginConfig);
    const mode = config.mock ? "MOCK" : "live";
    const agentList = Object.keys(config.agentKeys);

    api.logger.info(
      `memory-memwal: registered (${mode}, server: ${config.serverUrl}, ` +
      `agents: [${agentList.join(", ") || "default only"}])`,
    );

    if (config.mock) {
      api.logger.warn(
        "memory-memwal: MOCK MODE — memories stored in-memory, will be lost on restart. " +
        "Set mock: false and configure a real server for production.",
      );
    }

    // Register all components
    registerHooks(api, config);
    registerTools(api, config);
    registerCli(api, config);

    // Health check service
    api.registerService({
      id: "memory-memwal",
      async start() {
        try {
          const client = await createClient(config.privateKey, config.accountId, config);
          const health = await client.health();
          api.logger.info(
            `memory-memwal: connected (${mode}, status: ${health.status}, version: ${health.version})`,
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
