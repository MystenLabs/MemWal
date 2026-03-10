import "server-only";

import { embedMany } from "ai";
import { getEmbeddingModel } from "./providers";

const BATCH_SIZE = 100; // OpenAI embedding API max batch size

/**
 * Embed an array of text strings in batches.
 * Returns embeddings in the same order as input.
 */
export async function batchEmbed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const { embeddings } = await embedMany({
      model: getEmbeddingModel(),
      values: batch,
    });
    allEmbeddings.push(...embeddings);
  }

  return allEmbeddings;
}
