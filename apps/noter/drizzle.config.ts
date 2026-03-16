import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: ["./package/shared/db/schema.ts", "./package/shared/db/relations.ts"],
  out: "./package/shared/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
