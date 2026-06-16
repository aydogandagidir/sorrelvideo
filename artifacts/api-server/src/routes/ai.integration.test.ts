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
        // The provider contract (SuggestResult) always carries usage; the route
        // logs result.usage.* on the success path, so the mock must supply it.
        usage: { inputTokens: 120, outputTokens: 30 },
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

describe.runIf(INTEGRATION_AVAILABLE)(
  "POST /api/ai/edit — revise current copy",
  () => {
    it("400s a malformed body (missing current) without touching provider/quota", async () => {
      const userId = await createFreeUser();
      const auth = await authHeaderFor(userId);

      const res = await request(app)
        .post("/api/ai/edit")
        .set("Authorization", auth)
        .send({ instruction: "make it punchier" });

      expect(res.status).toBe(400);
      expect(suggest).not.toHaveBeenCalled();
      expect(await aiCountOf(userId)).toBe(0);
    });

    it("passes the current copy to the provider and returns the edit (200, +1 quota)", async () => {
      const userId = await createFreeUser();
      const auth = await authHeaderFor(userId);
      suggest.mockResolvedValue({
        headline: "Punchier headline",
        bodyText: "Tighter body.",
        ctaText: "Go",
        usage: { inputTokens: 90, outputTokens: 20 },
      });

      const res = await request(app)
        .post("/api/ai/edit")
        .set("Authorization", auth)
        .send({
          instruction: "make it punchier",
          current: { headline: "Old", bodyText: "Old body", ctaText: "Buy" },
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        headline: "Punchier headline",
        bodyText: "Tighter body.",
        ctaText: "Go",
      });
      // The edit framing actually reached the provider: the parsed input carried
      // the current copy + the instruction as the prompt.
      expect(suggest).toHaveBeenCalledTimes(1);
      const input = suggest.mock.calls[0][0] as {
        prompt: string;
        current?: { headline: string; bodyText: string; ctaText: string };
      };
      expect(input.prompt).toBe("make it punchier");
      expect(input.current).toEqual({
        headline: "Old",
        bodyText: "Old body",
        ctaText: "Buy",
      });
      expect(await aiCountOf(userId)).toBe(1);
    });

    it("does NOT consume a quota unit when the provider fails (502)", async () => {
      const userId = await createFreeUser();
      const auth = await authHeaderFor(userId);
      suggest.mockRejectedValue(new Error("provider exploded"));

      const res = await request(app)
        .post("/api/ai/edit")
        .set("Authorization", auth)
        .send({
          instruction: "make it punchier",
          current: { headline: "Old", bodyText: "Old body", ctaText: "Buy" },
        });

      expect(res.status).toBe(502);
      expect(await aiCountOf(userId)).toBe(0);
    });
  },
);
