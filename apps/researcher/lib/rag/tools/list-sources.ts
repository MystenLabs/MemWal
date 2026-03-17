import { z } from "zod";
import { tool } from "ai";
import { desc, eq, gt, sql, and, count } from "drizzle-orm";
import { source, sourceChunk } from "@/lib/db/schema";
import { db } from "@/lib/db/drizzle";

export function listSourcesTool({ userId }: { userId: string }) {
  return tool({
    description:
      "List all processed research sources (PDFs, URLs) for the current user, including active chunk counts",
    inputSchema: z.object({}),
    execute: async () => {
      const activeChunkSubquery = db
        .select({
          sourceId: sourceChunk.sourceId,
          activeChunks: count(sourceChunk.id).as("activeChunks"),
        })
        .from(sourceChunk)
        .where(gt(sourceChunk.expiresAt, new Date()))
        .groupBy(sourceChunk.sourceId)
        .as("activeChunks");

      const sources = await db
        .select({
          id: source.id,
          type: source.type,
          title: source.title,
          url: source.url,
          summary: source.summary,
          claims: source.claims,
          chunkCount: source.chunkCount,
          activeChunks: sql<number>`COALESCE(${activeChunkSubquery.activeChunks}, 0)`,
          createdAt: source.createdAt,
        })
        .from(source)
        .leftJoin(activeChunkSubquery, eq(source.id, activeChunkSubquery.sourceId))
        .where(eq(source.userId, userId))
        .orderBy(desc(source.createdAt));

      console.log(`[tool:listSources] Found ${sources.length} sources for user`);

      if (sources.length === 0) {
        return { sources: [] as typeof sources, message: "No sources processed yet." };
      }

      return { sources, total: sources.length };
    },
  });
}
