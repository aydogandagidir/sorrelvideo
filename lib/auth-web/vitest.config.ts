import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "auth-web",
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
