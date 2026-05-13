import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemWalSession } from "../auth.js";

import { registerRememberTool } from "./remember.js";
import { registerRecallTool } from "./recall.js";
import { registerAnalyzeTool } from "./analyze.js";
import { registerRestoreTool } from "./restore.js";

/**
 * Register every non-manual MemWal tool on the given server. Manual-mode
 * methods (rememberManual, recallManual) are intentionally excluded per the
 * MCP-server scope: agents authenticate with a delegate key and rely on the
 * relayer for SEAL encrypt/decrypt + Walrus storage.
 */
export function registerTools(server: McpServer, session: MemWalSession): void {
    registerRememberTool(server, session);
    registerRecallTool(server, session);
    registerAnalyzeTool(server, session);
    registerRestoreTool(server, session);
}

export {
    registerRememberTool,
    registerRecallTool,
    registerAnalyzeTool,
    registerRestoreTool,
};
