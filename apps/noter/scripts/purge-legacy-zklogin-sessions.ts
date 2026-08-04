import "dotenv/config";
import postgres from "postgres";

// Optional one-time deploy step: clear leftover legacy custom-zkLogin sessions.
//
// The custom OAuth->JWT->prover zkLogin login path has been removed, and the app
// no longer reads or trusts the zklogin_sessions table for authentication, so a
// leftover row can no longer authenticate a request. This script just clears the
// stale rows for data hygiene; it is not required for the security cutoff.
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
  try {
    console.log("Purging legacy zkLogin sessions (zklogin_sessions)...");
    const deleted = await sql`DELETE FROM zklogin_sessions`;
    console.log(`Removed ${deleted.count} legacy zkLogin session row(s).`);
  } finally {
    // Always close the connection, even if the DELETE throws, so the script
    // never hangs with an open client.
    await sql.end();
  }
}

purge().catch((error) => {
  console.error("Failed to purge legacy zkLogin sessions:", error);
  process.exit(1);
});
