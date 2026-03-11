/**
 * MEMWAL V2 CLIENT — Server-side MemWal SDK wrapper
 * Uses Ed25519 delegate key auth — no wallet/zkLogin needed.
 * Server handles: embed → encrypt → Walrus upload → store
 *
 * Key can be set from env var OR at runtime via setMemWalKey().
 */

import { MemWal } from "@cmdoss/memwal-v2";

let _memwal: MemWal | null = null;
let _runtimeKey: string | null = null;

/**
 * Set the MemWal key at runtime (from user input in profile panel).
 * Clears the existing client so it gets re-created with the new key.
 */
export const setMemWalKey = (key: string | null) => {
  _runtimeKey = key;
  _memwal = null; // Force re-create on next call
};

/**
 * Get a shared MemWal v2 client instance (server-side only).
 * Priority: runtime key > MEMWAL_KEY env var.
 */
export const getMemWalClient = (): MemWal => {
  if (_memwal) return _memwal;

  const key = _runtimeKey || process.env.MEMWAL_KEY;
  if (!key) {
    throw new Error("[MemWal] No key configured — set MEMWAL_KEY in Profile or .env");
  }

  _memwal = MemWal.create({
    key,
    serverUrl: process.env.MEMWAL_SERVER_URL || "http://localhost:3001",
  });

  return _memwal;
};

/**
 * Extract memories from text using MemWal v2 analyze endpoint.
 * Server uses LLM to extract facts, then stores each one.
 */
export const extractMemories = async (
  _userId: string,
  text: string
): Promise<string[]> => {
  try {
    const memwal = getMemWalClient();
    const result = await memwal.analyze(text);
    const facts = (result.facts ?? []).map((f) => f.text);
    return facts;
  } catch (error) {
    console.error("[extractMemories] Error:", error);
    return [];
  }
};

/**
 * Remember a single text — server handles embed + encrypt + store.
 */
export const rememberText = async (text: string) => {
  const memwal = getMemWalClient();
  return memwal.remember(text);
};

/**
 * Recall memories similar to a query — server handles search + decrypt.
 */
export const recallMemories = async (query: string, limit = 10) => {
  const memwal = getMemWalClient();
  return memwal.recall(query, limit);
};
