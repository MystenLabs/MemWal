CREATE TYPE "public"."ai_message_status" AS ENUM('streaming', 'awaiting-approval', 'in-progress', 'completed', 'error');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TABLE "chats" (
	"id" uuid PRIMARY KEY NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"userId" uuid,
	"title" text,
	"model" text DEFAULT 'anthropic/claude-sonnet-4',
	"systemPrompt" text,
	"temperature" real
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"chatId" uuid NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text,
	"parts" jsonb,
	"model" text,
	"status" "ai_message_status",
	"promptTokens" integer,
	"completionTokens" integer,
	"agentRunId" uuid,
	"turnIndex" integer
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"suiAddress" text NOT NULL,
	"provider" text NOT NULL,
	"providerSub" text NOT NULL,
	"name" text,
	"email" text,
	"avatar" text,
	"lastSeenAt" timestamp,
	CONSTRAINT "users_suiAddress_unique" UNIQUE("suiAddress")
);
--> statement-breakpoint
CREATE TABLE "zklogin_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"userId" uuid,
	"ephemeralPrivateKey" text NOT NULL,
	"ephemeralPublicKey" text NOT NULL,
	"maxEpoch" integer NOT NULL,
	"randomness" text NOT NULL,
	"nonce" text NOT NULL,
	"zkProof" jsonb,
	"expiresAt" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_chatId_chats_id_fk" FOREIGN KEY ("chatId") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zklogin_sessions" ADD CONSTRAINT "zklogin_sessions_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chats_userId_index" ON "chats" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "chats_userId_createdAt_index" ON "chats" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "messages_chatId_index" ON "messages" USING btree ("chatId");--> statement-breakpoint
CREATE INDEX "messages_chatId_createdAt_index" ON "messages" USING btree ("chatId","createdAt");--> statement-breakpoint
CREATE INDEX "messages_agentRunId_index" ON "messages" USING btree ("agentRunId");--> statement-breakpoint
CREATE INDEX "users_provider_providerSub_index" ON "users" USING btree ("provider","providerSub");--> statement-breakpoint
CREATE INDEX "zklogin_sessions_userId_index" ON "zklogin_sessions" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "zklogin_sessions_expiresAt_index" ON "zklogin_sessions" USING btree ("expiresAt");