-- Add "enoki" to auth_method enum
ALTER TYPE "auth_method" ADD VALUE IF NOT EXISTS 'enoki';

-- Add Enoki delegate key credentials to users table
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "delegatePrivateKey" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "delegateAccountId" text;
