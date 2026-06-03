import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, oauthAccountsTable, usersTable } from "@workspace/db";
import { findOrCreateOAuthUser } from "./oauth";
import { createSession, deleteSessionsForUser, getSession } from "./auth";
import { truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

beforeEach(async () => {
  await truncateAll();
});

describe.runIf(INTEGRATION_AVAILABLE)(
  "findOrCreateOAuthUser — verified-email auto-link gate",
  () => {
    it("does NOT link to a pre-existing account when the provider email is unverified (takeover guard)", async () => {
      // A real Sorrel user owns victim@example.com.
      const [victim] = await db
        .insert(usersTable)
        .values({ email: "victim@example.com" })
        .returning();

      // An attacker authenticates via GitHub, presenting the victim's email
      // but WITHOUT a verified attestation. This must not hand them the
      // victim's account.
      const result = await findOrCreateOAuthUser("github", {
        providerAccountId: "attacker-gh-id",
        email: "victim@example.com",
        emailVerified: false,
        firstName: "Mal",
        lastName: "Lory",
        profileImageUrl: null,
      });

      // A brand-new, distinct user is created instead of linking to the victim.
      expect(result.id).not.toBe(victim.id);
      // The unverified email is dropped (not stored as the new user's email),
      // so it can't later collide with the victim's unique email either.
      expect(result.email).toBeNull();
      expect(result.emailVerifiedAt).toBeNull();

      // The victim's account is untouched and still un-linked.
      const links = await db
        .select()
        .from(oauthAccountsTable)
        .where(eq(oauthAccountsTable.userId, victim.id));
      expect(links).toHaveLength(0);

      // The new oauth_accounts row still records the raw provider email for
      // reference — it just carries no auth weight.
      const [attackerLink] = await db
        .select()
        .from(oauthAccountsTable)
        .where(
          and(
            eq(oauthAccountsTable.provider, "github"),
            eq(oauthAccountsTable.providerAccountId, "attacker-gh-id"),
          ),
        );
      expect(attackerLink.userId).toBe(result.id);
      expect(attackerLink.providerEmail).toBe("victim@example.com");
    });

    it("DOES link to a pre-existing account when the provider email is verified", async () => {
      const [owner] = await db
        .insert(usersTable)
        .values({ email: "owner@example.com" })
        .returning();

      const result = await findOrCreateOAuthUser("google", {
        providerAccountId: "google-sub-123",
        email: "owner@example.com",
        emailVerified: true,
        firstName: "Owner",
        lastName: "Person",
        profileImageUrl: null,
      });

      // Same user — the verified email legitimately links the identity.
      expect(result.id).toBe(owner.id);

      const [link] = await db
        .select()
        .from(oauthAccountsTable)
        .where(eq(oauthAccountsTable.userId, owner.id));
      expect(link.provider).toBe("google");
      expect(link.providerAccountId).toBe("google-sub-123");

      // Linking a verified provider email also confirms the local account.
      const [refreshed] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, owner.id));
      expect(refreshed.emailVerifiedAt).not.toBeNull();
    });

    it("returns the already-linked user without consulting email at all", async () => {
      const [user] = await db
        .insert(usersTable)
        .values({ email: "linked@example.com" })
        .returning();
      await db.insert(oauthAccountsTable).values({
        userId: user.id,
        provider: "github",
        providerAccountId: "gh-existing",
        providerEmail: "linked@example.com",
      });

      // Even with an unverified email, an existing (provider, id) link wins.
      const result = await findOrCreateOAuthUser("github", {
        providerAccountId: "gh-existing",
        email: "someone-else@example.com",
        emailVerified: false,
        firstName: null,
        lastName: null,
        profileImageUrl: null,
      });

      expect(result.id).toBe(user.id);
    });

    it("creates a verified user with the email when the provider verified it", async () => {
      const result = await findOrCreateOAuthUser("google", {
        providerAccountId: "google-new-sub",
        email: "fresh@example.com",
        emailVerified: true,
        firstName: "Fresh",
        lastName: null,
        profileImageUrl: null,
      });

      expect(result.email).toBe("fresh@example.com");
      expect(result.emailVerifiedAt).not.toBeNull();
    });
  },
);

describe.runIf(INTEGRATION_AVAILABLE)("deleteSessionsForUser", () => {
  it("revokes every session for the target user and leaves others intact", async () => {
    const [target] = await db
      .insert(usersTable)
      .values({ email: "target@example.com" })
      .returning();
    const [other] = await db
      .insert(usersTable)
      .values({ email: "other@example.com" })
      .returning();

    const targetSidA = await createSession({ userId: target.id });
    const targetSidB = await createSession({ userId: target.id });
    const otherSid = await createSession({ userId: other.id });

    const deleted = await deleteSessionsForUser(target.id);
    expect(deleted).toBe(2);

    // Both of the target's sessions are gone (the attacker's foothold dies).
    expect(await getSession(targetSidA)).toBeNull();
    expect(await getSession(targetSidB)).toBeNull();

    // An unrelated user's session is untouched.
    const otherSession = await getSession(otherSid);
    expect(otherSession?.userId).toBe(other.id);
  });

  it("returns 0 when the user has no sessions", async () => {
    const [user] = await db
      .insert(usersTable)
      .values({ email: "sessionless@example.com" })
      .returning();
    expect(await deleteSessionsForUser(user.id)).toBe(0);
  });
});
