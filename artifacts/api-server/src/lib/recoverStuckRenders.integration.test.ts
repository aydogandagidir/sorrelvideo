import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, ne } from "drizzle-orm";
import { db, projectsTable, usersTable } from "@workspace/db";
import { recoverStuckRenders } from "./recoverStuckRenders";
import { truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

async function createUser(): Promise<string> {
  const [u] = await db
    .insert(usersTable)
    .values({ email: `u-${Date.now()}-${Math.random()}@test.local` })
    .returning();
  return u.id;
}

async function createProject(userId: string, status: string): Promise<number> {
  const [p] = await db
    .insert(projectsTable)
    .values({ userId, name: "p", module: "studio", status })
    .returning();
  return p.id;
}

beforeEach(async () => {
  delete process.env.REDIS_URL; // exercise inline-mode recovery (no broker)
  await truncateAll();
});

describe.runIf(INTEGRATION_AVAILABLE)("recoverStuckRenders (inline mode)", () => {
  it("resets orphaned 'rendering' rows to 'failed' and leaves others untouched", async () => {
    const userId = await createUser();
    const stuckId = await createProject(userId, "rendering");
    const readyId = await createProject(userId, "ready");
    const draftId = await createProject(userId, "draft");

    await recoverStuckRenders();

    const rows = await db.select().from(projectsTable);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(stuckId)?.status).toBe("failed");
    expect(byId.get(stuckId)?.renderError).toBe("Render interrupted by a restart");
    expect(byId.get(readyId)?.status).toBe("ready");
    expect(byId.get(draftId)?.status).toBe("draft");
  });

  it("is a no-op when nothing is stuck", async () => {
    const userId = await createUser();
    const draftId = await createProject(userId, "draft");
    await recoverStuckRenders();
    const [row] = await db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.id, draftId));
    expect(row.status).toBe("draft");
  });

  it("refunds the render quota for a recovered orphan (a crash skips the normal refund)", async () => {
    // The render was charged at claim time; an OOM/restart killed the process
    // before executeRender's catch could run decrementRenderCount. Recovery must
    // give that Free render back. renderResetAt is in the FUTURE (startOfNextMonth
    // semantics) so the window is still current and the window-aware refund fires
    // — isNewMonth() is `now >= resetAt`, so a past/now resetAt reads as expired.
    const userId = await createUser();
    await db
      .update(usersTable)
      .set({
        renderCount: 2,
        renderResetAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      })
      .where(eq(usersTable.id, userId));
    const stuckId = await createProject(userId, "rendering");

    await recoverStuckRenders();

    const [proj] = await db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.id, stuckId));
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    expect(proj.status).toBe("failed");
    expect(user.renderCount).toBe(1); // 2 → 1: exactly one orphan refunded
  });

  it("does NOT drive the quota negative when there's nothing to refund (floored at 0)", async () => {
    const userId = await createUser(); // renderCount defaults to 0
    await db
      .update(usersTable)
      .set({ renderResetAt: new Date(Date.now() + 30 * 24 * 3600 * 1000) })
      .where(eq(usersTable.id, userId));
    await createProject(userId, "rendering");

    await recoverStuckRenders();

    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    expect(user.renderCount).toBe(0);
  });
});

describe.runIf(INTEGRATION_AVAILABLE)("atomic render claim", () => {
  it("lets exactly one of N concurrent claims win", async () => {
    const userId = await createUser();
    const id = await createProject(userId, "draft");

    // Same conditional UPDATE the render route uses to claim a project.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        db
          .update(projectsTable)
          .set({ status: "rendering", renderError: null })
          .where(
            and(
              eq(projectsTable.id, id),
              ne(projectsTable.status, "rendering"),
            ),
          )
          .returning(),
      ),
    );

    const winners = results.filter((rows) => rows.length === 1);
    expect(winners).toHaveLength(1);

    const [row] = await db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.id, id));
    expect(row.status).toBe("rendering");
  });
});
