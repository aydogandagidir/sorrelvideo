import { describe, expect, it } from "vitest";
import { getUserPlan } from "./billingService";

describe("billingService.getUserPlan", () => {
  it("returns 'free' when the user has no Stripe customer id", async () => {
    // Short-circuits before any DB call, so this exercise needs no fixtures.
    const plan = await getUserPlan(null);
    expect(plan).toBe("free");
  });
});
