/** Memory Health API — checks the authenticated user's Memory connection. */

import { resolveMemoryCredentials } from "@/feature/note/api/memory-request";
import { createMemWalClient } from "@/feature/note/lib/pdw-client";

export async function GET(request: Request) {
  try {
    const { key, accountId } = await resolveMemoryCredentials(request);
    const health = await createMemWalClient(key, accountId).health();
    return Response.json({ ...health, status: "ok" });
  } catch (error) {
    return Response.json(
      {
        status: "not_configured",
        message:
          error instanceof Error
            ? error.message
            : "Walrus Memory credentials unavailable",
      },
      { status: 503 }
    );
  }
}
