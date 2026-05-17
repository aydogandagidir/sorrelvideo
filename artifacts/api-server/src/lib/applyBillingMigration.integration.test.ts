import { describe, expect, it } from "vitest";
import { applyBillingMigration } from "./applyBillingMigration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

describe.runIf(INTEGRATION_AVAILABLE)("applyBillingMigration", () => {
  it("is safe to run twice (idempotent ADD COLUMN IF NOT EXISTS)", async () => {
    // First call: drizzle push already created the columns, this is a no-op.
    await expect(applyBillingMigration()).resolves.toBeUndefined();
    // Second call should also succeed; the IF NOT EXISTS guards keep it cheap.
    await expect(applyBillingMigration()).resolves.toBeUndefined();
  });
});
