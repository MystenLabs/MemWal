-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Core tables
CREATE TABLE IF NOT EXISTS "User" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "email" varchar(64) NOT NULL,
  "password" varchar(64),
  "publicKey" varchar(128) UNIQUE
);

CREATE TABLE IF NOT EXISTS "Chat" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "createdAt" timestamp NOT NULL,
  "title" text NOT NULL,
  "userId" uuid NOT NULL REFERENCES "User"("id"),
  "visibility" varchar NOT NULL DEFAULT 'private',
  "sprintIds" json,
  "sprintContext" text
);

CREATE TABLE IF NOT EXISTS "Message_v2" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "chatId" uuid NOT NULL REFERENCES "Chat"("id"),
  "role" varchar NOT NULL,
  "parts" json NOT NULL,
  "attachments" json NOT NULL,
  "createdAt" timestamp NOT NULL
);

CREATE TABLE IF NOT EXISTS "Stream" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "chatId" uuid NOT NULL,
  "createdAt" timestamp NOT NULL,
  CONSTRAINT "Stream_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Stream_chatId_Chat_id_fk" FOREIGN KEY ("chatId") REFERENCES "Chat"("id")
);

-- Research tables
CREATE TABLE IF NOT EXISTS "Source" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "chatId" uuid REFERENCES "Chat"("id") ON DELETE SET NULL,
  "userId" uuid NOT NULL REFERENCES "User"("id"),
  "type" varchar NOT NULL,
  "title" text,
  "url" text,
  "summary" text,
  "claims" json,
  "chunkCount" integer DEFAULT 0,
  "createdAt" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "SourceChunk" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "sourceId" uuid NOT NULL REFERENCES "Source"("id") ON DELETE CASCADE,
  "section" text NOT NULL,
  "content" text NOT NULL,
  "embedding" vector(1536),
  "chunkIndex" integer NOT NULL DEFAULT 0,
  "tokenCount" integer NOT NULL DEFAULT 0,
  "searchVector" tsvector,
  "expiresAt" timestamp NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_source_chunk_search" ON "SourceChunk" USING GIN ("searchVector");

CREATE TABLE IF NOT EXISTS "ResearchBlob" (
  "id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "blobId" text UNIQUE NOT NULL,
  "userId" uuid NOT NULL REFERENCES "User"("id"),
  "chatId" uuid REFERENCES "Chat"("id"),
  "type" varchar NOT NULL,
  "title" text NOT NULL,
  "summary" text,
  "reportContent" text,
  "tags" json,
  "citations" json,
  "sources" json,
  "memoryCount" integer DEFAULT 0,
  "createdAt" timestamp NOT NULL DEFAULT now()
);
