import { defineWorkspace } from "vitest/config";

// Each project owns its own test environment and setup files.
// New testable packages should be added here.
export default defineWorkspace([
  "./artifacts/api-server/vitest.config.ts",
  "./artifacts/sorrel/vitest.config.ts",
  "./lib/auth-web/vitest.config.ts",
]);
