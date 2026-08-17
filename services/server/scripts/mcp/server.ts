import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemWalSession } from "./auth.js";
import { registerProactiveMemoryPrompt } from "./prompts/proactive-memory.js";
import { registerTools } from "./tools/index.js";

/**
 * Build a fully-configured Walrus Memory MCP server for a single authenticated
 * session. The transport is NOT attached here — `index.ts` is responsible
 * for choosing SSE (default) or future transports.
 *
 * One McpServer per session — same pattern as Mailgate. Tools share the
 * session-scoped Walrus Memory SDK client so each call signs with the caller's
 * delegate key, not a shared server key.
 */
export function shouldRegisterProactiveMemoryPrompt(
    oauthScope: string | undefined
): boolean {
    if (oauthScope === undefined) return true;
    const granted = new Set(oauthScope.split(/\s+/).filter(Boolean));
    return granted.has("memwal:read") && granted.has("memwal:write");
}

export function createMcpServer(session: MemWalSession): McpServer {
    const server = new McpServer({
        name: "memwal",
        version: "0.0.1",
    });

    registerTools(server, session);
    if (shouldRegisterProactiveMemoryPrompt(session.oauthScope)) {
        registerProactiveMemoryPrompt(server);
    }

    return server;
}
