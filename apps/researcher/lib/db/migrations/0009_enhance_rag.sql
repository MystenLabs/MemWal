ALTER TABLE "SourceChunk" ADD COLUMN "chunkIndex" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "SourceChunk" ADD COLUMN "tokenCount" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "SourceChunk" ADD COLUMN "searchVector" tsvector;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_source_chunk_search" ON "SourceChunk" USING GIN ("searchVector");--> statement-breakpoint

-- Backfill chunkIndex: assign sequential indices within each source
UPDATE "SourceChunk" sc SET "chunkIndex" = sub.rn - 1
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "sourceId" ORDER BY "createdAt") AS rn
  FROM "SourceChunk"
) sub
WHERE sc.id = sub.id;--> statement-breakpoint

-- Backfill tokenCount: estimate ~4 chars per token
UPDATE "SourceChunk" SET "tokenCount" = CEIL(LENGTH(content) * 0.25);--> statement-breakpoint

-- Backfill searchVector: generate tsvector from content
UPDATE "SourceChunk" SET "searchVector" = to_tsvector('english', content);
