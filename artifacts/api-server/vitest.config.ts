import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "api-server",
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test/setup.ts"],
    globalSetup: ["./src/test/global-setup.ts"],
    // Tests share a single Postgres testcontainer (booted in globalSetup);
    // serial avoids cross-file race when each suite truncates the same tables.
    fileParallelism: false,
    // Container pull + schema push can take 30-60s on a cold cache.
    hookTimeout: 90_000,
    testTimeout: 30_000,
  },
});
