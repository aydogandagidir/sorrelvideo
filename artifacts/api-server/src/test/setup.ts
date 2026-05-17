import { inject } from "vitest";

// If globalSetup booted a Postgres testcontainer, use its URL — otherwise fall
// back to a dummy so import-time validations in `@workspace/db` don't trip.
// pg.Pool itself is lazy, so the dummy URL is fine for unit tests that never
// touch the DB. INTEGRATION_AVAILABLE flag lets *.integration.test.ts skip
// themselves when no container could be booted.
let injectedUrl = "";
try {
  injectedUrl = inject("INTEGRATION_DATABASE_URL") ?? "";
} catch {
  injectedUrl = "";
}
if (injectedUrl) {
  process.env.DATABASE_URL = injectedUrl;
  process.env.SORREL_INTEGRATION_AVAILABLE = "true";
}
process.env.DATABASE_URL ??=
  "postgres://postgres:postgres@localhost:5432/sorrel_test";
process.env.SESSION_SECRET ??= "test-secret";
process.env.STRIPE_SECRET_KEY ??= "sk_test_dummy";
process.env.STRIPE_WEBHOOK_SECRET ??= "whsec_dummy";
process.env.PORT ??= "8080";
process.env.NODE_ENV ??= "test";

export const INTEGRATION_AVAILABLE =
  process.env.SORREL_INTEGRATION_AVAILABLE === "true";
