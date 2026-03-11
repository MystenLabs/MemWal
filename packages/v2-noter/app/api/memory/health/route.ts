/**
 * Memory Health API — checks if MemWal is configured and server is reachable
 */

import { getMemWalClient } from "@/feature/note/lib/pdw-client";

export async function GET() {
    try {
        const memwal = getMemWalClient();
        // Try health check, if MemWal client exists then it's at least configured
        try {
            const health = await memwal.health();
            return Response.json({ ...health, status: "ok" });
        } catch {
            // Client configured but server unreachable
            return Response.json({ status: "ok", server: "unreachable" });
        }
    } catch (error) {
        // No key configured
        return Response.json(
            { status: "not_configured", message: error instanceof Error ? error.message : "MemWal not configured" },
            { status: 503 }
        );
    }
}
