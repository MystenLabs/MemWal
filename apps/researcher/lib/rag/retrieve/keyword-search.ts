import "server-only";

import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/lib/db/drizzle";
import { source, sourceChunk } from "@/lib/db/schema";

export type KeywordSearchResult = {
  chunkId: string;
  section: string;
  content: string;
  sourceId: string;
  sourceTitle: string | null;
  chunkIndex: number;
  tokenCount: number;
  score: number;
};

export async function keywordSearch({
  query,
  userId,
  sourceId,
  limit = 20,
}: {
  query: string;
  userId: string;
  sourceId?: string;
  limit?: number;
}): Promise<KeywordSearchResult[]> {
  const conditions = [
    eq(source.userId, userId),
    gt(sourceChunk.expiresAt, new Date()),
    sql`"SourceChunk"."searchVector" @@ plainto_tsquery('english', ${query})`,
  ];

  if (sourceId) {
    conditions.push(eq(sourceChunk.sourceId, sourceId));
  }

  const rank = sql<number>`ts_rank("SourceChunk"."searchVector", plainto_tsquery('english', ${query}))`;

  const results = await db
    .select({
      chunkId: sourceChunk.id,
      section: sourceChunk.section,
      content: sourceChunk.content,
      sourceId: sourceChunk.sourceId,
      sourceTitle: source.title,
      chunkIndex: sourceChunk.chunkIndex,
      tokenCount: sourceChunk.tokenCount,
      score: rank,
    })
    .from(sourceChunk)
    .innerJoin(source, eq(sourceChunk.sourceId, source.id))
    .where(and(...conditions))
    .orderBy(sql`${rank} DESC`)
    .limit(limit);

  return results;
}
