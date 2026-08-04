import "dotenv/config";
import postgres from "postgres";

// One-time deploy step: invalidate all legacy custom-zkLogin sessions.
//
// The custom OAuth->JWT->prover zkLogin login path has been removed. Its session
// table (zklogin_sessions) is no longer written to, but rows created before this
// deploy remain accepted by the session lookup until they expire. Any session
// that could have been rebound through the old, unverified flow must be revoked,
// not merely left to age out. Run this once during/after deploy.
//
// Safe to run repeatedly (idempotent) and safe after the table is empty. It does
// NOT touch wallet_sessions (Enoki / wallet / delegate-key sessions).

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(url);

async function purge() {
  console.log("Purging legacy zkLogin sessions (zklogin_sessions)...");
  const deleted = await sql`DELETE FROM zklogin_sessions`;
  console.log(`Removed ${deleted.count} legacy zkLogin session row(s).`);
  await sql.end();
}

purge().catch((error) => {
  console.error("Failed to purge legacy zkLogin sessions:", error);
  process.exit(1);
});
