import "server-only";

import { getMessagesByChatId, getChunksByIds } from "@/lib/db/queries";
import type { ManifestEntry } from "./types";

/**
 * Extract the tool name from a part's type field.
 * AI SDK stores tool parts as `type: "tool-<toolName>"`.
 */
function extractToolName(type: string): string | null {
  if (type.startsWith("tool-")) {
    return type.slice(5); // "tool-searchSourceContent" → "searchSourceContent"
  }
  return null;
}

/**
 * Build a manifest of all chunks referenced during a chat session.
 *
 * Scans assistant message parts for tool invocations (getChunkContent, searchSourceContent)
 * and extracts the chunk IDs that were accessed. Returns enriched metadata for each chunk.
 *
 * Supports both AI SDK part formats:
 * - v4+: { type: "tool-<name>", state: "output-available", input, output }
 * - v3:  { type: "tool-invocation", toolName, state: "result", args, result }
 */
export async function buildChunkManifest({
  chatId,
  userId,
}: {
  chatId: string;
  userId: string;
}): Promise<ManifestEntry[]> {
  const messages = await getMessagesByChatId({ id: chatId });

  const chunkIdSet = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;

    const parts = msg.parts as unknown[];
    if (!Array.isArray(parts)) continue;

    for (const part of parts) {
      const p = part as Record<string, unknown>;

      // Determine tool name from either format
      let toolName: string | null = null;
      if (typeof p.type === "string") {
        toolName = extractToolName(p.type);
      }
      // Fallback: v3 format with explicit toolName field
      if (!toolName && p.type === "tool-invocation" && typeof p.toolName === "string") {
        toolName = p.toolName;
      }

      if (!toolName) continue;

      // Only process completed tool calls
      const state = p.state as string;
      if (state !== "output-available" && state !== "result") continue;

      // Get the output/result object (v4 uses "output", v3 uses "result")
      const output = (p.output ?? p.result) as Record<string, unknown> | undefined;
      // Get the input/args object (v4 uses "input", v3 uses "args")
      const input = (p.input ?? p.args) as Record<string, unknown> | undefined;

      if (toolName === "getChunkContent") {
        const ids = input?.chunkIds;
        if (Array.isArray(ids)) {
          for (const id of ids) {
            if (typeof id === "string") chunkIdSet.add(id);
          }
        }
      } else if (toolName === "searchSourceContent") {
        const results = (output as { results?: { chunkId?: string }[] })?.results;
        if (Array.isArray(results)) {
          for (const r of results) {
            if (typeof r.chunkId === "string") chunkIdSet.add(r.chunkId);
          }
        }
      }
    }
  }

  if (chunkIdSet.size === 0) return [];

  console.log(
    `[sprint:manifest] Found ${chunkIdSet.size} unique chunk IDs from tool calls`
  );

  const chunks = await getChunksByIds({
    chunkIds: Array.from(chunkIdSet),
    userId,
  });

  console.log(
    `[sprint:manifest] Resolved ${chunks.length} chunks (${chunkIdSet.size - chunks.length} expired/missing)`
  );

  return chunks.map((c) => ({
    chunkId: c.id,
    sourceId: c.sourceId,
    sourceTitle: c.sourceTitle,
    sourceUrl: c.sourceUrl ?? null,
    section: c.section,
    chunkIndex: c.chunkIndex,
    preview: c.content.slice(0, 200),
  }));
}
