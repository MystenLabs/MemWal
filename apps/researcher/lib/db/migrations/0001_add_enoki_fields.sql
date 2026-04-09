-- Add Enoki zkLogin fields to User table
-- suiAddress: stable Enoki wallet address (same every Google login)
-- delegatePrivateKey: stored to recreate session without new key gen
-- accountId: MemWal account object ID on Sui
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "suiAddress" varchar(128) UNIQUE;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "delegatePrivateKey" varchar(128);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "accountId" varchar(128);
