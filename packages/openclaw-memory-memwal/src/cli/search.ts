/**
 * CLI command — openclaw memwal search <query>
 *
 * Semantic search with JSON output, scoped by --agent flag.
 */

import type { MemWal } from "@mysten/memwal";
import { resolveAgent } from "../config.js";
import type { PluginConfig } from "../types.js";

/** Register the `openclaw memwal search` command. */
export function registerSearchCommand(cmd: any, client: MemWal, config: PluginConfig): void {
  cmd
    .command("search")
    .description("Search memories")
    .argument("<query>", "Search query")
    .option("--limit <n>", "Max results", "5")
    .option("--agent <name>", "Search a specific agent's memory (namespace)")
    .action(async (query: string, opts: any) => {
      const { namespace } = resolveAgent(config.defaultNamespace, opts.agent ? `agent:${opts.agent}:cli` : undefined);
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
}
