import "server-only";

import { generateObject } from "ai";
import { z } from "zod";
import { getLanguageModel } from "./providers";

export type Chunk = { section: string; content: string };

const CHUNK_MODEL = "google/gemini-2.5-flash";
const TOKENS_PER_CHAR = 0.25; // ~4 chars per token for English
const SMALL_DOC_THRESHOLD = 2000; // tokens
const WINDOW_SIZE = 50_000; // tokens per LLM window
const WINDOW_OVERLAP = 2_000; // overlap tokens between windows

function estimateTokens(text: string): number {
  return Math.ceil(text.length * TOKENS_PER_CHAR);
}

function charIndexForTokens(tokens: number): number {
  return Math.floor(tokens / TOKENS_PER_CHAR);
}

const chunkSchema = z.object({
  chunks: z.array(
    z.object({
      section: z.string().describe("Short heading for this chunk's topic"),
      content: z.string().describe("The original text for this chunk — do NOT summarize"),
    })
  ),
});

async function chunkWithLLM(
  text: string,
  title: string,
): Promise<Chunk[]> {
  const { object } = await generateObject({
    model: getLanguageModel(CHUNK_MODEL),
    schema: chunkSchema,
    prompt: `Split the following document into coherent topic chunks.
Each chunk should be 500-1000 tokens and cover one coherent topic or section.
Preserve the original text exactly — do NOT summarize, just split at topic boundaries.
Give each chunk a short descriptive section heading.

Document title: ${title}

---
${text}
---`,
  });

  return object.chunks;
}

/**
 * Chunk a document into semantically coherent pieces using LLM.
 *
 * - Short docs (< 2K tokens): stored as single chunk
 * - Normal docs: one LLM call
 * - Very long docs (> 100K tokens): processed in 50K windows with 2K overlap, then merged
 */
export async function chunkDocument(
  text: string,
  title: string,
): Promise<Chunk[]> {
  const tokenCount = estimateTokens(text);

  // Short document — single chunk, no LLM needed
  if (tokenCount < SMALL_DOC_THRESHOLD) {
    return [{ section: title || "Full Document", content: text }];
  }

  // Normal document — single LLM call
  if (tokenCount <= WINDOW_SIZE * 2) {
    return chunkWithLLM(text, title);
  }

  // Very long document — sliding window approach
  const allChunks: Chunk[] = [];
  let offset = 0;

  while (offset < text.length) {
    const windowEnd = offset + charIndexForTokens(WINDOW_SIZE);
    const windowText = text.slice(offset, windowEnd);
    const windowChunks = await chunkWithLLM(windowText, title);
    allChunks.push(...windowChunks);

    // Advance by window minus overlap
    offset += charIndexForTokens(WINDOW_SIZE - WINDOW_OVERLAP);
  }

  // Deduplicate overlap chunks (simple: drop chunks with >80% content overlap)
  return deduplicateChunks(allChunks);
}

function deduplicateChunks(chunks: Chunk[]): Chunk[] {
  const result: Chunk[] = [];
  for (const chunk of chunks) {
    const isDuplicate = result.some(
      (existing) => overlapRatio(existing.content, chunk.content) > 0.8
    );
    if (!isDuplicate) {
      result.push(chunk);
    }
  }
  return result;
}

function overlapRatio(a: string, b: string): number {
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  if (shorter.length === 0) return 0;
  return longer.includes(shorter) ? 1 : 0;
}
