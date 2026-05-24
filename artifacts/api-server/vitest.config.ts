import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "api-server",
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test/setup.ts"],
    globalSetup: ["./src/test/global-setup.ts"],
    // Integration tests share ONE Postgres testcontainer (booted in globalSetup)
    // and each suite truncates the same tables in beforeEach, so they MUST run
    // serially. Otherwise one file's TRUNCATE (AccessExclusiveLock) deadlocks
    // with another file's read (AccessShareLock) — Postgres 40P01 — and files
    // wipe each other's rows mid-test. `fileParallelism: false` alone did NOT
    // serialize under the workspace + forks pool (files still ran in separate
    // processes concurrently); pinning to a single fork guarantees serial.
    fileParallelism: false,
    poolOptions: { forks: { singleFork: true } },
    // Container pull + schema push can take 30-60s on a cold cache.
    hookTimeout: 90_000,
    testTimeout: 30_000,
  },
});
