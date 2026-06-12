import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemWalSession } from "../auth.js";
import { wrapTool } from "./util.js";

/**
 * memwal_health — lightweight connectivity check. Calls the relayer's public
 * `GET /health` (no request signing, no embed / Walrus / SEAL round-trip), so
 * it returns fast. This is the correct way to confirm the server is reachable
 * — do NOT use `memwal_recall` for that (recall is a full, slow retrieval).
 */
export function registerHealthTool(
    server: McpServer,
    session: MemWalSession
): void {
    server.tool(
        "memwal_health",
        "Quick connectivity check for Walrus Memory. Calls the relayer's lightweight health endpoint (no search, no decryption) and returns its status and version. Use this to confirm the server is reachable — do NOT use memwal_recall for health checks, which is a full and slow retrieval.",
        {},
        wrapTool<Record<string, never>>(async () => {
            const result = await session.memwal.health();
            return {
                content: [
                    {
                        type: "text",
                        text: `Walrus Memory is reachable. status=${result.status} version=${result.version}`,
                    },
                ],
            };
        })
    );
}
