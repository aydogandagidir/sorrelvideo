import { defineConfig } from "@playwright/test";

// Dedicated test port so a running local dev server (5173) doesn't clash.
const WEB_PORT = 5180;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
  },
  // Serve the SPA with the real Vite pipeline. The backend is NOT booted here:
  // the smoke exercises the shipped SPA in a real browser and mocks /api at the
  // network layer (the real backend is covered end-to-end by the supertest E2E).
  webServer: {
    command: "pnpm run dev",
    url: `http://localhost:${WEB_PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Point the dev /api proxy at a dead port so any UNmocked call deterministically
    // fails fast (hermetic) instead of reaching a real server a dev left running.
    env: { PORT: String(WEB_PORT), API_PROXY_TARGET: "http://127.0.0.1:9" },
  },
});
