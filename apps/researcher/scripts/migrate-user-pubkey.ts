/**
 * One-time migration script: derives an ed25519 public key from
 * the MEMWAL_KEY env var and assigns it to an existing user record.
 *
 * Usage:
 *   MEMWAL_KEY=<hex-private-key> npx tsx scripts/migrate-user-pubkey.ts [userId]
 *
 * If userId is omitted, lists all users so you can pick the right one.
 */

import "dotenv/config";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { db } from "../lib/db/drizzle";
import { user } from "../lib/db/schema";
import { eq } from "drizzle-orm";

// Set sha512 for noble
if (!ed.etc.sha512Sync) {
  ed.etc.sha512Sync = (...m: Uint8Array[]) => {
    const h = sha512.create();
    for (const msg of m) h.update(msg);
    return h.digest();
  };
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function main() {
  const privKeyHex = process.env.MEMWAL_KEY;
  if (!privKeyHex) {
    console.error("MEMWAL_KEY env var is required");
    process.exit(1);
  }

  const privKeyBytes = hexToBytes(privKeyHex);
  const pubKeyBytes = ed.getPublicKey(privKeyBytes);
  const publicKey = bytesToHex(pubKeyBytes);

  console.log(`Derived public key: ${publicKey}`);

  const userId = process.argv[2];

  if (!userId) {
    const users = await db.select().from(user);
    console.log("\nExisting users:");
    for (const u of users) {
      console.log(`  id=${u.id}  email=${u.email}  publicKey=${u.publicKey ?? "(none)"}`);
    }
    console.log("\nRe-run with a userId argument to assign the public key.");
    process.exit(0);
  }

  const [existing] = await db.select().from(user).where(eq(user.id, userId));
  if (!existing) {
    console.error(`User ${userId} not found`);
    process.exit(1);
  }

  await db.update(user).set({ publicKey }).where(eq(user.id, userId));
  console.log(`Updated user ${userId} with publicKey=${publicKey}`);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
