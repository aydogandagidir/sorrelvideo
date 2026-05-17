import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "ai",
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"],
  },
});
