/** Memory Health API — checks if MemWal is configured and server is reachable. */

import { getMemWalClient } from "@/feature/note/lib/pdw-client";

export async function GET() {
  try {
    // Try with env fallback (no per-user key needed for health check)
    const memwal = getMemWalClient();
    try {
      const health = await memwal.health();
      return Response.json({ ...health, status: "ok" });
    } catch {
      return Response.json({ status: "ok", server: "unreachable" });
    }
  } catch (error) {
    return Response.json(
      { status: "not_configured", message: error instanceof Error ? error.message : "MemWal not configured" },
      { status: 503 },
    );
  }
}
