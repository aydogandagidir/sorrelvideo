import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";

// Mock the provider so we can deterministically force a failure (502 path) or a
// success (200 path) without calling a real LLM. Everything else in @workspace/ai
// (the Zod schemas the route parses input with) is preserved.
const suggest = vi.fn();
vi.mock("@workspace/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/ai")>();
  return {
    ...actual,
    getProvider: () => ({ name: "anthropic" as const, suggest }),
  };
});

// Imported after vi.mock so the route picks up the mocked getProvider.
const { default: app } = await import("../app");
const request = (await import("supertest")).default;
const { createSession } = await import("../lib/auth");
const { createFreeUser, truncateAll } = await import("../test/integration");
const { INTEGRATION_AVAILABLE } = await import("../test/setup");

async function authHeaderFor(userId: string): Promise<string> {
  const sid = await createSession({ userId });
  return `Bearer ${sid}`;
}

async function aiCountOf(userId: string): Promise<number> {
  const [row] = await db
    .select({ aiCount: usersTable.aiCount })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  return row.aiCount;
}

beforeEach(async () => {
  await truncateAll();
  suggest.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.runIf(INTEGRATION_AVAILABLE)(
  "POST /api/ai/suggest — quota is charged only on success",
  () => {
    it("does NOT consume a quota unit when the provider fails (502)", async () => {
      const userId = await createFreeUser();
      const auth = await authHeaderFor(userId);
      suggest.mockRejectedValue(new Error("provider exploded"));

      const res = await request(app)
        .post("/api/ai/suggest")
        .set("Authorization", auth)
        .send({ prompt: "launch our new product" });

      expect(res.status).toBe(502);
      // The Free user got nothing, so their monthly unit must be untouched.
      expect(await aiCountOf(userId)).toBe(0);
    });

    it("consumes exactly one quota unit on a successful suggestion (200)", async () => {
      const userId = await createFreeUser();
      const auth = await authHeaderFor(userId);
      suggest.mockResolvedValue({
        headline: "Ship faster",
        bodyText: "Branded video in minutes.",
        ctaText: "Start now",
      });

      const res = await request(app)
        .post("/api/ai/suggest")
        .set("Authorization", auth)
        .send({ prompt: "launch our new product" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        headline: "Ship faster",
        bodyText: "Branded video in minutes.",
        ctaText: "Start now",
      });
      expect(await aiCountOf(userId)).toBe(1);
    });
  },
);
