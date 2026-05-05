/**
 * MEMORY DETECTOR — AI-powered memory extraction
 * Uses MemWal SDK analyze endpoint for detection.
 * Server handles: LLM extraction → embed → encrypt → Walrus → store.
 */

import { extractMemories } from "./pdw-client";
import { findTextOffset } from "../domain/note";
import type { SerializedEditorState } from "lexical";
import type { MemoryCategory } from "@/shared/db/type";

export type PreparedMemory = {
  extractedText: string;
  startOffset: number;
  endOffset: number;
  category: MemoryCategory;
  importance: number;
};

/**
 * Detect and prepare memories from note content.
 * Uses MemWal analyze (server-side LLM extraction + auto-store).
 */
export async function detectAndPrepareMemories(
  userId: string,
  plainText: string,
  editorContent: SerializedEditorState,
  memwalKey?: string | null,
  memwalAccountId?: string | null,
): Promise<PreparedMemory[]> {
  const memorySnippets = await extractMemories(userId, plainText, memwalKey, memwalAccountId);

  if (memorySnippets.length === 0) {
    return [];
  }

  return memorySnippets.map((snippet) => {
    const { startOffset, endOffset } = findTextOffset(editorContent, snippet);
    return {
      extractedText: snippet,
      startOffset,
      endOffset,
      category: "general" as MemoryCategory,
      importance: 5,
    };
  });
}

/** Check if text contains memorable content. */
export async function shouldSaveAsMemory(
  userId: string,
  text: string,
  memwalKey?: string | null,
  memwalAccountId?: string | null,
): Promise<boolean> {
  const memories = await extractMemories(userId, text, memwalKey, memwalAccountId);
  return memories.length > 0;
}

/** Detect memories from note text for Lexical node insertion. */
export async function detectMemoriesForLexical(
  userId: string,
  plainText: string,
  memwalKey?: string | null,
  memwalAccountId?: string | null,
): Promise<Array<{ text: string; category: MemoryCategory; importance: number }>> {
  const memorySnippets = await extractMemories(userId, plainText, memwalKey, memwalAccountId);

  if (memorySnippets.length === 0) {
    return [];
  }

  return memorySnippets.map((snippet) => ({
    text: snippet,
    category: "general" as MemoryCategory,
    importance: 5,
  }));
}
