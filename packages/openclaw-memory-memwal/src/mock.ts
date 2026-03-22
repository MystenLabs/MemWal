/**
 * Mock MemWal client — in-memory storage with keyword-based recall.
 *
 * Same interface as the real MemWal SDK. Stores memories in a Map keyed
 * by Ed25519 key, so per-agent isolation works identically to production.
 *
 * When the real server is ready, swap createMockClient() → MemWal.create().
 * The rest of the plugin code stays unchanged.
 */

import { randomUUID } from "node:crypto";
import type {
  MemWalClient,
  RememberResult,
  RecallResult,
  RecallMemory,
  AnalyzeResult,
  AnalyzedFact,
  HealthResult,
} from "./types.js";

// ============================================================================
// In-Memory Store (per key)
// ============================================================================

interface StoredMemory {
  id: string;
  blob_id: string;
  text: string;
  createdAt: number;
}

/** Global store — persists across hook/tool calls within the same gateway process. */
const memoryStore = new Map<string, StoredMemory[]>();

function getStore(key: string): StoredMemory[] {
  if (!memoryStore.has(key)) {
    memoryStore.set(key, []);
  }
  return memoryStore.get(key)!;
}

// ============================================================================
// Keyword Scoring
// ============================================================================

/** Tokenize text into lowercase words, strip punctuation. */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2) // skip tiny words (a, an, is, etc.)
  );
}

/**
 * Score how relevant a memory is to a query.
 * Returns 0-1 based on word overlap ratio.
 */
function relevanceScore(query: string, memoryText: string): number {
  const queryTokens = tokenize(query);
  const memoryTokens = tokenize(memoryText);

  if (queryTokens.size === 0) return 0;

  let matches = 0;
  for (const token of queryTokens) {
    if (memoryTokens.has(token)) {
      matches++;
    }
  }

  return matches / queryTokens.size;
}

// ============================================================================
// Fact Extraction (simple sentence splitting)
// ============================================================================

/**
 * Extract "facts" from conversation text by splitting into meaningful sentences.
 * Real MemWal uses an LLM for this. Mock uses sentence splitting + filtering.
 */
function extractFacts(text: string): string[] {
  // Strip role prefixes ([user]: ..., [assistant]: ...)
  const cleaned = text.replace(/\[(user|assistant)\]:\s*/gi, "");

  // Split by sentence boundaries
  const sentences = cleaned
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15) // skip very short fragments
    .filter((s) => !s.startsWith("*")) // skip markdown bullets
    .filter((s) => !/^(ok|sure|got it|thanks|yes|no|hmm)/i.test(s)); // skip filler

  // Take up to 5 facts per capture
  return sentences.slice(0, 5);
}

// ============================================================================
// Mock Client
// ============================================================================

export function createMockClient(key: string): MemWalClient {
  const keyPreview = key.length > 8
    ? `${key.slice(0, 4)}...${key.slice(-4)}`
    : "mock";

  return {
    async remember(text: string): Promise<RememberResult> {
      const store = getStore(key);
      const entry: StoredMemory = {
        id: randomUUID(),
        blob_id: `mock_blob_${randomUUID().slice(0, 8)}`,
        text: text.trim(),
        createdAt: Date.now(),
      };
      store.push(entry);

      console.log(
        `[mock-memwal] remember (key: ${keyPreview}): "${text.slice(0, 80)}..." → id=${entry.id.slice(0, 8)}`
      );

      return {
        id: entry.id,
        blob_id: entry.blob_id,
        owner: `mock_owner_${key.slice(0, 8)}`,
      };
    },

    async recall(query: string, limit: number = 5): Promise<RecallResult> {
      const store = getStore(key);

      if (store.length === 0) {
        console.log(`[mock-memwal] recall (key: ${keyPreview}): no memories stored`);
        return { results: [], total: 0 };
      }

      // Score all memories by keyword overlap
      const scored = store
        .map((entry) => ({
          blob_id: entry.blob_id,
          text: entry.text,
          score: relevanceScore(query, entry.text),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      // Convert score to distance (MemWal returns distance where lower = more similar)
      const results: RecallMemory[] = scored.map((s) => ({
        blob_id: s.blob_id,
        text: s.text,
        distance: 1 - Math.max(s.score, 0.1), // floor at 0.1 so nothing is exactly 1.0 distance
      }));

      console.log(
        `[mock-memwal] recall (key: ${keyPreview}): query="${query.slice(0, 50)}" → ${results.length} results`
      );

      return { results, total: results.length };
    },

    async analyze(text: string): Promise<AnalyzeResult> {
      const store = getStore(key);
      const facts = extractFacts(text);
      const analyzedFacts: AnalyzedFact[] = [];

      for (const factText of facts) {
        const entry: StoredMemory = {
          id: randomUUID(),
          blob_id: `mock_blob_${randomUUID().slice(0, 8)}`,
          text: factText,
          createdAt: Date.now(),
        };
        store.push(entry);

        analyzedFacts.push({
          text: factText,
          id: entry.id,
          blob_id: entry.blob_id,
        });
      }

      console.log(
        `[mock-memwal] analyze (key: ${keyPreview}): extracted ${analyzedFacts.length} facts`
      );

      return {
        facts: analyzedFacts,
        total: analyzedFacts.length,
        owner: `mock_owner_${key.slice(0, 8)}`,
      };
    },

    async health(): Promise<HealthResult> {
      return { status: "ok", version: "mock-0.1.0" };
    },
  };
}

/**
 * Get the count of stored memories for a key (for CLI stats).
 */
export function getMockMemoryCount(key: string): number {
  return getStore(key).length;
}

/**
 * Get all stored memories for a key (for CLI list).
 */
export function getMockMemories(key: string): Array<{ id: string; text: string; createdAt: number }> {
  return getStore(key).map((m) => ({
    id: m.id,
    text: m.text,
    createdAt: m.createdAt,
  }));
}
