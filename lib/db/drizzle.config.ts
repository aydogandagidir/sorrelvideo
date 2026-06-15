import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  // Relative to this config file. Avoid path.join(__dirname, ...) — on Windows
  // it emits backslashes that drizzle-kit's glob matcher fails to resolve.
  schema: "./src/schema/index.ts",
  // Versioned, forward-only SQL migrations live here (committed). `generate`
  // writes them; `migrate` applies them in order against DATABASE_URL. `push`
  // (dev) and `push-force` (testcontainers) IGNORE this dir — they diff the live
  // DB against the schema directly, so tests + the dev loop are unaffected. Use
  // forward slashes only (the Windows-glob note above applies here too).
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
