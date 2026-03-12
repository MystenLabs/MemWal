ALTER TABLE "ResearchBlob" ADD COLUMN "chatId" uuid REFERENCES "Chat"("id");--> statement-breakpoint
ALTER TABLE "ResearchBlob" ADD COLUMN "reportContent" text;--> statement-breakpoint
ALTER TABLE "ResearchBlob" ADD COLUMN "citations" json;--> statement-breakpoint
ALTER TABLE "ResearchBlob" ADD COLUMN "sources" json;--> statement-breakpoint
ALTER TABLE "ResearchBlob" ADD COLUMN "memoryCount" integer DEFAULT 0;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_research_blob_chat_sprint" ON "ResearchBlob" ("chatId") WHERE "type" = 'sprint';
