import { z } from "zod";
import { tool, embed } from "ai";
import { and, desc, eq, gt } from "drizzle-orm";
import { cosineDistance } from "drizzle-orm/sql/functions/vector";
import { source, sourceChunk } from "@/lib/db/schema";
import { db } from "@/lib/db/drizzle";
import { getEmbeddingModel } from "@/lib/ai/providers";

export function getResearchTools({ userId }: { userId: string }) {
  return {
    listSources: tool({
      description:
        "List all processed research sources (PDFs, URLs) for the current user",
      inputSchema: z.object({}),
      execute: async () => {
        const sources = await db
          .select({
            id: source.id,
            type: source.type,
            title: source.title,
            url: source.url,
            summary: source.summary,
            claims: source.claims,
            chunkCount: source.chunkCount,
            createdAt: source.createdAt,
          })
          .from(source)
          .where(eq(source.userId, userId))
          .orderBy(desc(source.createdAt));

        if (sources.length === 0) {
          return { sources: [] as typeof sources, message: "No sources processed yet." };
        }

        return { sources, total: sources.length };
      },
    }),

    searchSourceContent: tool({
      description:
        "Search for specific content across processed source documents using semantic similarity. Only searches chunks that haven't expired (7-day TTL).",
      inputSchema: z.object({
        query: z
          .string()
          .describe("What to search for in source documents"),
      }),
      execute: async ({ query }) => {
        try {
          // Embed the query
          const { embedding: queryEmbedding } = await embed({
            model: getEmbeddingModel(),
            value: query,
          });

          // pgvector cosine similarity search on non-expired chunks,
          // joined with source to enforce userId authorization
          const results = await db
            .select({
              section: sourceChunk.section,
              content: sourceChunk.content,
              sourceId: sourceChunk.sourceId,
            })
            .from(sourceChunk)
            .innerJoin(source, eq(sourceChunk.sourceId, source.id))
            .where(
              and(
                eq(source.userId, userId),
                gt(sourceChunk.expiresAt, new Date()),
              ),
            )
            .orderBy(cosineDistance(sourceChunk.embedding, queryEmbedding))
            .limit(10);

          if (results.length === 0) {
            return {
              results: [] as typeof results,
              message:
                "No matching content found. Source chunks may have expired (7-day TTL) — user can re-upload the source to refresh.",
            };
          }

          return { results, total: results.length };
        } catch (error) {
          console.error("[searchSourceContent] Error:", error);
          return {
            results: [],
            message: `Search failed: ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      },
    }),
  };
}
