/**
 * CLI command — openclaw memwal stats
 *
 * Shows server health, config summary, and active namespace.
 */

import type { MemWal } from "@mysten-incubation/memwal";
import { resolveAgent, keyPreview } from "../config.js";
import type { PluginConfig } from "../types.js";

/** Register the `openclaw memwal stats` command. */
export function registerStatsCommand(cmd: any, client: MemWal, config: PluginConfig): void {
  cmd
    .command("stats")
    .description("Show memory status")
    .option("--agent <name>", "Show stats for a specific agent (namespace)")
    .action(async (opts: any) => {
      const { namespace } = resolveAgent(config.defaultNamespace, opts.agent ? `agent:${opts.agent}:cli` : undefined);

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
}
