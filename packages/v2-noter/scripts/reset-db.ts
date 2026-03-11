import "dotenv/config";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(url);

async function reset() {
  console.log("Dropping public schema...");
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await sql`GRANT ALL ON SCHEMA public TO public`;
  console.log("Database reset complete.");
  await sql.end();
}

reset().catch((err) => {
  console.error(err);
  process.exit(1);
});
