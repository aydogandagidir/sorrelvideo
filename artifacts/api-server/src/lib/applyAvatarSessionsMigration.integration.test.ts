import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, avatarSessionsTable } from "@workspace/db";
import { applyAvatarSessionsMigration } from "./applyAvatarSessionsMigration";
import { createFreeUser, truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

beforeEach(async () => {
  await truncateAll();
});

describe.runIf(INTEGRATION_AVAILABLE)("applyAvatarSessionsMigration", () => {
  it("is safe to run twice (idempotent CREATE TABLE/INDEX/CONSTRAINT)", async () => {
    // drizzle push already created the table + FK; both calls are no-ops.
    await expect(applyAvatarSessionsMigration()).resolves.toBeUndefined();
    await expect(applyAvatarSessionsMigration()).resolves.toBeUndefined();
  });

  it("recreates a missing avatar_sessions table with an insertable schema", async () => {
    await pool.query("DROP TABLE IF EXISTS avatar_sessions CASCADE");
    await applyAvatarSessionsMigration();

    const userId = await createFreeUser();
    const [row] = await db
      .insert(avatarSessionsTable)
      .values({ userId, sessionId: "sess_1", sandbox: true })
      .returning();
    expect(row.userId).toBe(userId);
    expect(row.sandbox).toBe(true);
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("self-heals the user cascade FK so an orphan session is rejected", async () => {
    await pool.query("DROP TABLE IF EXISTS avatar_sessions CASCADE");
    await applyAvatarSessionsMigration();

    // No such user → the user FK the migration self-heals must reject the insert.
    await expect(
      db.insert(avatarSessionsTable).values({ userId: "no-such-user" }),
    ).rejects.toThrow();
  });

  it("cascade-deletes a user's sessions when the user is deleted", async () => {
    const userId = await createFreeUser();
    await db.insert(avatarSessionsTable).values({ userId, sessionId: "s" });

    await pool.query("DELETE FROM users WHERE id = $1", [userId]);

    const rows = await db
      .select()
      .from(avatarSessionsTable)
      .where(eq(avatarSessionsTable.userId, userId));
    expect(rows).toHaveLength(0);
  });
});
