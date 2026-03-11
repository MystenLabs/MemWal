import "server-only";

import { and, eq, gt, asc } from "drizzle-orm";
import { cosineDistance } from "drizzle-orm/sql/functions/vector";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/drizzle";
import { source, sourceChunk } from "@/lib/db/schema";

export type VectorSearchResult = {
  chunkId: string;
  section: string;
  content: string;
  sourceId: string;
  sourceTitle: string | null;
  chunkIndex: number;
  tokenCount: number;
  score: number;
};

export async function vectorSearch({
  queryEmbedding,
  userId,
  sourceId,
  limit = 20,
}: {
  queryEmbedding: number[];
  userId: string;
  sourceId?: string;
  limit?: number;
}): Promise<VectorSearchResult[]> {
  const distance = cosineDistance(sourceChunk.embedding, queryEmbedding);

  const conditions = [
    eq(source.userId, userId),
    gt(sourceChunk.expiresAt, new Date()),
  ];

  if (sourceId) {
    conditions.push(eq(sourceChunk.sourceId, sourceId));
  }

  const results = await db
    .select({
      chunkId: sourceChunk.id,
      section: sourceChunk.section,
      content: sourceChunk.content,
      sourceId: sourceChunk.sourceId,
      sourceTitle: source.title,
      chunkIndex: sourceChunk.chunkIndex,
      tokenCount: sourceChunk.tokenCount,
      distance: sql<number>`${distance}`,
    })
    .from(sourceChunk)
    .innerJoin(source, eq(sourceChunk.sourceId, source.id))
    .where(and(...conditions))
    .orderBy(asc(distance))
    .limit(limit);

  return results.map((r) => ({
    chunkId: r.chunkId,
    section: r.section,
    content: r.content,
    sourceId: r.sourceId,
    sourceTitle: r.sourceTitle,
    chunkIndex: r.chunkIndex,
    tokenCount: r.tokenCount,
    score: 1 - r.distance, // Convert distance to similarity (0-1)
  }));
}
