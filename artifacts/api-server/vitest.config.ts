import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "api-server",
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test/setup.ts"],
    // Tests touch the same Postgres test DB; serial avoids row-lock contention
    // until we add per-test isolation (testcontainers).
    fileParallelism: false,
  },
});
