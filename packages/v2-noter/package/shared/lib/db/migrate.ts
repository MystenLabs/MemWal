import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL!;

async function main() {
  console.log("⏳ Running migrations...");
  const start = Date.now();

  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client);

  await migrate(db, {
    migrationsFolder: "./package/shared/db/migrations",
  });

  const duration = Date.now() - start;
  console.log(`✅ Migrations completed in ${duration} ms`);

  await client.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
