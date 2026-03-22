/**
 * CLI commands — openclaw memwal <command>
 *
 * Memory operations: search, stats, list
 * Agent scoping via --agent flag → namespace
 */

import type { MemWal } from "@cmdoss/memwal";
import { keyPreview } from "./config.js";
import type { PluginConfig } from "./types.js";

/**
 * Resolve namespace for CLI --agent flag.
 */
function resolveCliNamespace(config: PluginConfig, agentName?: string): string {
  if (!agentName || agentName === "main") return config.defaultNamespace;
  return agentName;
}

export function registerCli(api: any, client: MemWal, config: PluginConfig): void {
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
        .option("--agent <name>", "Search a specific agent's memory (namespace)")
        .action(async (query: string, opts: any) => {
          const namespace = resolveCliNamespace(config, opts.agent);
          const limit = parseInt(opts.limit, 10);

          try {
            const result = await client.recall(query, limit, namespace);
            const output = result.results.map((r: any) => ({
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
        .option("--agent <name>", "Show stats for a specific agent (namespace)")
        .action(async (opts: any) => {
          const namespace = resolveCliNamespace(config, opts.agent);

          try {
            const health = await client.health();

            console.log(`Server:     ${config.serverUrl}`);
            console.log(`Status:     ${health.status}`);
            console.log(`Version:    ${health.version}`);
            console.log(`Key:        ${keyPreview(config.privateKey)}`);
            console.log(`Account:    ${config.accountId.slice(0, 10)}...`);
            console.log(`Namespace:  ${namespace}`);
            console.log(`Auto-recall:  ${config.autoRecall}`);
            console.log(`Auto-capture: ${config.autoCapture}`);
          } catch (err) {
            console.error(`Stats failed: ${String(err)}`);
          }
        });

      // openclaw memwal list
      cmd
        .command("list")
        .description("List stored memories")
        .option("--agent <name>", "List a specific agent's memories (namespace)")
        .action(async (opts: any) => {
          const namespace = resolveCliNamespace(config, opts.agent);

          console.log(
            "Memory listing requires server support (coming in Phase 2). " +
            "Use 'openclaw memwal search <query>' to find specific memories.",
          );
          console.log(`Namespace: ${namespace}`);
        });
    },
    { commands: ["memwal"] },
  );
}
