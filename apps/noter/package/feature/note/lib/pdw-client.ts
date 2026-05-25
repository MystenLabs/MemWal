/**
 * Walrus Memory CLIENT — Server-side SDK wrapper
 *
 * Creates per-request Walrus Memory clients using the authenticated user's
 * delegate key (from tRPC context). Falls back to env vars for backward
 * compatibility.
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
 * Get a Walrus Memory client using provided credentials or env var fallback.
 * Throws if no key is available.
 */
export function getMemWalClient(
  key?: string | null,
  accountId?: string | null,
): MemWal {
  const resolvedKey = key || process.env.MEMWAL_PRIVATE_KEY;
  const resolvedAccountId = accountId || process.env.MEMWAL_ACCOUNT_ID;

  if (!resolvedKey) {
    throw new Error("[Walrus Memory] No key configured — sign in with Enoki or set MEMWAL_PRIVATE_KEY in .env");
  }
  if (!resolvedAccountId) {
    throw new Error("[Walrus Memory] No accountId configured — sign in with Enoki or set MEMWAL_ACCOUNT_ID in .env");
  }

  return createMemWalClient(resolvedKey, resolvedAccountId);
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
