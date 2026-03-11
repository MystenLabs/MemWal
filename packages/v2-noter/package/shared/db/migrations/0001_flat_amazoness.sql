CREATE TYPE "public"."auth_method" AS ENUM('zklogin', 'wallet');--> statement-breakpoint
CREATE TYPE "public"."memory_status" AS ENUM('preparing', 'pending', 'signing', 'uploading', 'indexing', 'saved', 'rejected', 'error');--> statement-breakpoint
CREATE TABLE "note_memory_highlights" (
	"id" uuid PRIMARY KEY NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"noteId" uuid NOT NULL,
	"userId" uuid NOT NULL,
	"highlightedText" text NOT NULL,
	"highlightedHtml" text,
	"startOffset" integer,
	"endOffset" integer,
	"extractedText" text,
	"memoryTitle" text,
	"memoryContent" text,
	"entities" jsonb,
	"relationships" jsonb,
	"status" "memory_status" DEFAULT 'preparing' NOT NULL,
	"blobId" text,
	"graphObjectId" text,
	"transactionId" text,
	"approvedAt" timestamp,
	"savedAt" timestamp,
	"errorMessage" text
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"userId" uuid NOT NULL,
	"title" text,
	"content" jsonb NOT NULL,
	"plainText" text NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"userId" uuid,
	"walletAddress" text NOT NULL,
	"walletType" text NOT NULL,
	"signedMessage" text NOT NULL,
	"signature" text NOT NULL,
	"signedAt" timestamp NOT NULL,
	"expiresAt" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chats" ALTER COLUMN "userId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "provider" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "providerSub" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "authMethod" "auth_method" NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "walletType" text;--> statement-breakpoint
ALTER TABLE "note_memory_highlights" ADD CONSTRAINT "note_memory_highlights_noteId_notes_id_fk" FOREIGN KEY ("noteId") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note_memory_highlights" ADD CONSTRAINT "note_memory_highlights_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_sessions" ADD CONSTRAINT "wallet_sessions_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_memory_highlights_noteId_index" ON "note_memory_highlights" USING btree ("noteId");--> statement-breakpoint
CREATE INDEX "note_memory_highlights_userId_index" ON "note_memory_highlights" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "note_memory_highlights_status_index" ON "note_memory_highlights" USING btree ("status");--> statement-breakpoint
CREATE INDEX "note_memory_highlights_userId_createdAt_index" ON "note_memory_highlights" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "notes_userId_index" ON "notes" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "notes_userId_updatedAt_index" ON "notes" USING btree ("userId","updatedAt");--> statement-breakpoint
CREATE INDEX "wallet_sessions_userId_index" ON "wallet_sessions" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "wallet_sessions_expiresAt_index" ON "wallet_sessions" USING btree ("expiresAt");--> statement-breakpoint
CREATE INDEX "wallet_sessions_walletAddress_index" ON "wallet_sessions" USING btree ("walletAddress");--> statement-breakpoint
CREATE INDEX "users_authMethod_index" ON "users" USING btree ("authMethod");--> statement-breakpoint
CREATE INDEX "users_suiAddress_index" ON "users" USING btree ("suiAddress");