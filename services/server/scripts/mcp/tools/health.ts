import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MemWalSession } from "../auth.js";
import { TOOL_METADATA } from "./annotations.js";
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
    server.registerTool(
        "memwal_health",
        {
            ...TOOL_METADATA.memwal_health,
            description:
                "Quick connectivity check for Walrus Memory. Calls the relayer's lightweight health endpoint (no search, no decryption) and returns its status and version, plus the relayer origin when the deployment publishes one (use it to confirm which network — prod / staging / dev / local — this client is bound to). Use this to confirm the server is reachable — do NOT use memwal_recall for health checks, which is a full and slow retrieval.",
            inputSchema: {},
        },
        wrapTool<Record<string, never>>(session, "memwal_health", async () => {
            const result = await session.memwal.health();
            const extra = result as {
                write_ready?: boolean;
                writes?: string;
            };
            const readyNote =
                extra.write_ready === false
                    ? " write_ready=false (writes unavailable)"
                    : extra.write_ready === true
                      ? " write_ready=true"
                      : "";
            // Only a deployment-supplied public origin, never `relayerUrl`
            // — that one is the address this process dials, which is loopback
            // unless overridden. Printing loopback as the network is how a
            // client bound to the wrong relayer reads as correctly configured.
            const relayerNote = session.publicRelayerUrl
                ? ` relayer=${session.publicRelayerUrl}`
                : "";
            const pausedNote = extra.writes === "paused" ? " writes=paused" : "";
            const writeNote = `${readyNote}${pausedNote}`;
            return {
                content: [
                    {
                        type: "text",
                        text: `Walrus Memory is reachable. status=${result.status} version=${result.version}${relayerNote}${writeNote}`,
                    },
                ],
            };
        })
    );
}
