/**
 * Agent-callable tools — require tools.allow config to be visible to the LLM.
 *
 * Tools accept an optional namespace parameter. The before_prompt_build hook
 * injects the current agent's namespace into the system prompt, guiding the
 * LLM to pass the correct namespace. Falls back to defaultNamespace if omitted.
 */

import type { MemWal } from "@cmdoss/memwal";
import { registerSearchTool } from "./search.js";
import { registerStoreTool } from "./store.js";
import type { PluginConfig } from "../types.js";

/** Register all agent-callable tools. */
export function registerTools(api: any, client: MemWal, config: PluginConfig): void {
  registerSearchTool(api, client, config);
  registerStoreTool(api, client, config);
}
