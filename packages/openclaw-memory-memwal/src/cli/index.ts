/**
 * CLI commands — openclaw memwal <command>
 *
 * Agent scoping via --agent flag → namespace.
 */

import type { MemWal } from "@mysten/memwal";
import { registerSearchCommand } from "./search.js";
import { registerStatsCommand } from "./stats.js";
import type { PluginConfig } from "../types.js";

/** Register `openclaw memwal` CLI commands. */
export function registerCli(api: any, client: MemWal, config: PluginConfig): void {
  api.registerCli(
    ({ program }: any) => {
      const cmd = program
        .command("memwal")
        .description("MemWal memory plugin commands");

      registerSearchCommand(cmd, client, config);
      registerStatsCommand(cmd, client, config);
    },
    { commands: ["memwal"] },
  );
}
