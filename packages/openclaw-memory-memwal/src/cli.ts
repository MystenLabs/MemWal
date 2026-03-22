/**
 * CLI commands — openclaw memwal <command>
 *
 * Memory operations: search, list, stats
 * Key management: keys list, keys add, keys remove
 */

import { createClient } from "./client.js";
import { keyPreview } from "./config.js";
import { getMockMemoryCount, getMockMemories } from "./mock.js";
import type { PluginConfig } from "./types.js";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve key + accountId for CLI --agent flag.
 * Returns the resolved credentials or null (with error printed) if agent not found.
 */
function resolveCliKey(
  config: PluginConfig,
  agentName?: string,
): { key: string; accountId: string; name: string } | null {
  if (!agentName) {
    return { key: config.privateKey, accountId: config.accountId, name: "default" };
  }

  if (!config.agentKeys[agentName]) {
    const available = Object.keys(config.agentKeys).join(", ") || "(none)";
    console.error(
      `No key configured for agent: "${agentName}". Available: ${available}`,
    );
    return null;
  }

  const agentConfig = config.agentKeys[agentName];
  return { key: agentConfig.key, accountId: agentConfig.accountId, name: agentName };
}

/**
 * Read and parse openclaw.json. Returns parsed object or null on error.
 */
async function readConfigFile(): Promise<{ data: any; path: string } | null> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const configPath = path.join(
    process.env.HOME || "~",
    ".openclaw",
    "openclaw.json",
  );

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return { data: JSON.parse(raw), path: configPath };
  } catch (err) {
    console.error(`Failed to read config: ${String(err)}`);
    return null;
  }
}

/**
 * Write openclaw.json back to disk.
 */
async function writeConfigFile(configData: any, configPath: string): Promise<boolean> {
  const fs = await import("node:fs");
  try {
    fs.writeFileSync(configPath, JSON.stringify(configData, null, 2) + "\n");
    return true;
  } catch (err) {
    console.error(`Failed to write config: ${String(err)}`);
    return false;
  }
}

/**
 * Get the agentKeys object from config data, creating the path if needed.
 */
function ensureAgentKeysPath(configData: any): Record<string, string> {
  if (!configData.plugins) configData.plugins = {};
  if (!configData.plugins.entries) configData.plugins.entries = {};
  if (!configData.plugins.entries["memory-memwal"])
    configData.plugins.entries["memory-memwal"] = { enabled: true, config: {} };
  if (!configData.plugins.entries["memory-memwal"].config)
    configData.plugins.entries["memory-memwal"].config = {};
  if (!configData.plugins.entries["memory-memwal"].config.agentKeys)
    configData.plugins.entries["memory-memwal"].config.agentKeys = {};

  return configData.plugins.entries["memory-memwal"].config.agentKeys;
}

// ============================================================================
// Registration
// ============================================================================

export function registerCli(api: any, config: PluginConfig): void {
  api.registerCli(
    ({ program }: any) => {
      const cmd = program
        .command("memwal")
        .description("MemWal memory plugin commands");

      // openclaw memwal search <query>
      cmd
        .command("search")
        .description("Search memories")
        .argument("<query>", "Search query")
        .option("--limit <n>", "Max results", "5")
        .option("--agent <name>", "Search a specific agent's memory")
        .action(async (query: string, opts: any) => {
          const resolved = resolveCliKey(config, opts.agent);
          if (!resolved) return;

          try {
            const client = await createClient(resolved.key, resolved.accountId, config);
            const result = await client.recall(query, parseInt(opts.limit, 10));
            const output = result.results.map((r) => ({
              text: r.text,
              blob_id: r.blob_id,
              relevance: Math.round((1 - r.distance) * 100) / 100,
            }));
            console.log(JSON.stringify(output, null, 2));
          } catch (err) {
            console.error(`Search failed: ${String(err)}`);
          }
        });

      // openclaw memwal stats
      cmd
        .command("stats")
        .description("Show memory status")
        .option("--agent <name>", "Show stats for a specific agent")
        .action(async (opts: any) => {
          const resolved = resolveCliKey(config, opts.agent);
          if (!resolved) return;

          try {
            const client = await createClient(resolved.key, resolved.accountId, config);
            const health = await client.health();

            console.log(`Mode:    ${config.mock ? "MOCK" : "live"}`);
            console.log(`Server:  ${config.serverUrl}`);
            console.log(`Status:  ${health.status}`);
            console.log(`Version: ${health.version}`);
            console.log(`Agent:   ${resolved.name}`);
            console.log(`Key:     ${keyPreview(resolved.key)}`);

            if (config.mock) {
              console.log(`Stored:  ${getMockMemoryCount(resolved.key)} memories (in-memory)`);
            }

            console.log(`Auto-recall:  ${config.autoRecall}`);
            console.log(`Auto-capture: ${config.autoCapture}`);
          } catch (err) {
            console.error(`Stats failed: ${String(err)}`);
          }
        });

      // openclaw memwal keys (subcommand group)
      const keysCmd = cmd
        .command("keys")
        .description("Manage per-agent Ed25519 keys");

      // openclaw memwal keys list (default action)
      keysCmd
        .command("list", { isDefault: true })
        .description("List configured keys")
        .action(() => {
          console.log("Configured keys:");
          console.log(`  default: ${keyPreview(config.privateKey)}`);
          for (const [name, key] of Object.entries(config.agentKeys)) {
            console.log(`  ${name}: ${keyPreview(key.key)} (account: ${key.accountId.slice(0, 10)}...)`);
          }
          if (!Object.keys(config.agentKeys).length) {
            console.log("  (no agent-specific keys)");
          }
        });

      // openclaw memwal keys add <agent> <key> <accountId>
      keysCmd
        .command("add")
        .description("Add a per-agent key for memory isolation")
        .argument("<agent>", "Agent name (e.g. researcher, coder)")
        .argument("<key>", "Ed25519 private key (64-char hex string)")
        .argument("<accountId>", "MemWalAccount object ID (0x...)")
        .action(async (agentName: string, newKey: string, newAccountId: string) => {
          if (!/^[0-9a-f]{64}$/i.test(newKey)) {
            console.error(
              "Invalid key format. Expected a 64-character hex string.",
            );
            return;
          }

          if (!newAccountId.startsWith("0x")) {
            console.error(
              "Invalid accountId format. Expected a Sui object ID starting with 0x.",
            );
            return;
          }

          if (agentName === "main" || agentName === "default") {
            console.error(
              `Cannot use "${agentName}" as agent name. ` +
              "Use 'openclaw config set' to change the default key.",
            );
            return;
          }

          const file = await readConfigFile();
          if (!file) return;

          const agentKeys = ensureAgentKeysPath(file.data);
          const existing = agentKeys[agentName];
          agentKeys[agentName] = { key: newKey, accountId: newAccountId };

          if (!(await writeConfigFile(file.data, file.path))) return;

          if (existing) {
            console.log(`Updated key for agent "${agentName}" (${keyPreview(newKey)})`);
          } else {
            console.log(`Added key for agent "${agentName}" (${keyPreview(newKey)}, account: ${newAccountId.slice(0, 10)}...)`);
          }
          console.log("");
          console.log("Restart the gateway to apply: openclaw gateway stop && openclaw gateway");
        });

      // openclaw memwal keys remove <agent>
      keysCmd
        .command("remove")
        .description("Remove a per-agent key")
        .argument("<agent>", "Agent name to remove")
        .action(async (agentName: string) => {
          const file = await readConfigFile();
          if (!file) return;

          const agentKeys =
            file.data.plugins?.entries?.["memory-memwal"]?.config?.agentKeys;

          if (!agentKeys || !agentKeys[agentName]) {
            const available = Object.keys(agentKeys || {}).join(", ") || "(none)";
            console.error(
              `No key configured for agent "${agentName}". Available: ${available}`,
            );
            return;
          }

          delete agentKeys[agentName];

          if (!(await writeConfigFile(file.data, file.path))) return;

          console.log(`Removed key for agent "${agentName}"`);
          console.log("Agent will now use the default key (shared memory space).");
          console.log("");
          console.log("Restart the gateway to apply: openclaw gateway stop && openclaw gateway");
        });

      // openclaw memwal list
      cmd
        .command("list")
        .description("List stored memories")
        .option("--agent <name>", "List a specific agent's memories")
        .action(async (opts: any) => {
          if (!config.mock) {
            console.log(
              "Memory listing requires server support (coming in Phase 2). " +
              "Currently available in mock mode only.",
            );
            return;
          }

          const resolved = resolveCliKey(config, opts.agent);
          if (!resolved) return;

          const memories = getMockMemories(resolved.key);
          if (!memories.length) {
            console.log("No memories stored.");
            return;
          }

          console.log(`${memories.length} memories:\n`);
          for (const m of memories) {
            const age = Math.round((Date.now() - m.createdAt) / 1000);
            console.log(
              `  [${m.id.slice(0, 8)}] ${m.text.slice(0, 80)}${m.text.length > 80 ? "..." : ""} (${age}s ago)`,
            );
          }
        });
    },
    { commands: ["memwal"] },
  );
}
