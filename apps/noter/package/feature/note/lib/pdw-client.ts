/**
 * Walrus Memory CLIENT — Server-side SDK wrapper
 *
 * Creates per-request Walrus Memory clients using credentials bound to the
 * authenticated user. Shared process credentials are never accepted.
 */

import { MemWal } from "@mysten-incubation/memwal";

/**
 * Create a Walrus Memory client for a specific user's delegate key.
 * Called per-request with credentials from tRPC context.
 */
export function createMemWalClient(key: string, accountId: string): MemWal {
  return MemWal.create({
    key,
    accountId,
    serverUrl: process.env.MEMWAL_SERVER_URL || "http://localhost:8000",
  });
}

/**
 * Get a Walrus Memory client using explicit session-bound credentials.
 * Throws if either credential is unavailable.
 */
export function getMemWalClient(
  key?: string | null,
  accountId?: string | null,
): MemWal {
  if (!key) {
    throw new Error("[Walrus Memory] Session has no delegate key");
  }
  if (!accountId) {
    throw new Error("[Walrus Memory] Session has no account ID");
  }

  return createMemWalClient(key, accountId);
}

/** Extract memories from text using Walrus Memory analyze endpoint. */
export async function extractMemories(
  _userId: string,
  text: string,
  key?: string | null,
  accountId?: string | null,
): Promise<string[]> {
  try {
    const memwal = getMemWalClient(key, accountId);
    const result = await memwal.analyze(text);
    return (result.facts ?? []).map((f) => f.text);
  } catch (error) {
    console.error("[extractMemories] Error:", error);
    return [];
  }
}

/** Remember a single text and wait until it is stored. */
export async function rememberText(
  text: string,
  key?: string | null,
  accountId?: string | null,
) {
  const memwal = getMemWalClient(key, accountId);
  return memwal.rememberAndWait(text);
}

/** Recall memories similar to a query — server handles search + decrypt. */
export async function recallMemories(
  query: string,
  limit = 10,
  key?: string | null,
  accountId?: string | null,
) {
  const memwal = getMemWalClient(key, accountId);
  return memwal.recall(query, limit);
}
