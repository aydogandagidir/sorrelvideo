import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import {
  db,
  passwordResetsTable,
  sessionsTable,
  usersTable,
} from "@workspace/db";
import app from "../app";
import {
  createSession,
  generateToken,
  hashPassword,
  hashToken,
} from "../lib/auth";
import { truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

/**
 * End-to-end integration coverage for the security-critical email/password auth
 * flows, driven through the real Express app against the testcontainer Postgres.
 * Complements:
 *   - routes/auth.test.ts            (DB-less validation / shape unit tests)
 *   - lib/oauthAndSessions.integration.test.ts
 *       (findOrCreateOAuthUser branches + deleteSessionsForUser at the service
 *        level, incl. the unverified-provider-email takeover guard)
 *
 * Rate-limit budget note: the in-memory limiters live on the imported `app`
 * module. Under vitest's per-file isolation this file starts with a clean
 * limiter, but requests WITHIN this file still share it. The signup limiter is
 * 3/IP/hour (IP-keyed, email-agnostic), so we only ever hit POST /auth/signup
 * for signup-specific assertions and otherwise seed users via direct inserts.
 * The login limiter is 5/(IP+email)/15min, so each login test uses a distinct
 * email and the rate-limit test deliberately exhausts a dedicated one.
 */

/** Pull the `sid` cookie value out of a response's Set-Cookie header(s). */
function sidCookieFrom(res: request.Response): string | undefined {
  const raw = res.headers["set-cookie"];
  if (!raw) return undefined;
  const cookies = Array.isArray(raw) ? raw : [raw];
  for (const c of cookies) {
    const m = /^sid=([^;]+)/.exec(c);
    if (m) return decodeURIComponent(m[1]);
  }
  return undefined;
}

beforeEach(async () => {
  await truncateAll();
});

describe.runIf(INTEGRATION_AVAILABLE)("POST /api/auth/signup", () => {
  it("creates a user (Argon2 hash, never plaintext), a session row, and sets the sid cookie", async () => {
    const email = `signup-${Date.now()}@test.local`;
    const password = "correct horse battery staple";

    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email, password, firstName: "Ada", lastName: "Lovelace" });

    expect(res.status).toBe(201);
    // Response envelope echoes the new user (never the password hash).
    expect(res.body.user.email).toBe(email);
    expect(res.body.user.firstName).toBe("Ada");
    expect(JSON.stringify(res.body)).not.toContain(password);

    // A users row exists with an Argon2id hash — NOT the plaintext password.
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email));
    expect(user).toBeTruthy();
    expect(user.passwordHash).toBeTruthy();
    expect(user.passwordHash).not.toBe(password);
    expect(user.passwordHash).not.toContain(password);
    expect(user.passwordHash?.startsWith("$argon2id$")).toBe(true);

    // The cookie carries a session id, and that exact session is persisted and
    // bound to the new user.
    const sid = sidCookieFrom(res);
    expect(sid).toBeTruthy();
    const [session] = await db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.sid, sid as string));
    expect(session).toBeTruthy();
    expect((session.sess as { userId: string }).userId).toBe(user.id);
  });

  it("rejects a duplicate email with 409 and does not create a second user", async () => {
    const email = `dupe-${Date.now()}@test.local`;
    // Seed the first account directly (keeps the IP-keyed signup limiter budget
    // for the one real signup POST below).
    await db
      .insert(usersTable)
      .values({ email, passwordHash: await hashPassword("firstpassword1") });

    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email, password: "secondpassword2" });

    expect(res.status).toBe(409);
    const rows = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email));
    expect(rows).toHaveLength(1);
  });

  it("normalizes the email to lower-case before matching, so a case variant is still a duplicate", async () => {
    const lower = `mixed-${Date.now()}@test.local`;
    await db
      .insert(usersTable)
      .values({ email: lower, passwordHash: await hashPassword("password123") });

    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: lower.toUpperCase(), password: "password123" });

    expect(res.status).toBe(409);
  });
});

describe.runIf(INTEGRATION_AVAILABLE)("POST /api/auth/login", () => {
  it("rejects a wrong password with 401 and issues no session", async () => {
    const email = `wrongpw-${Date.now()}@test.local`;
    await db
      .insert(usersTable)
      .values({ email, passwordHash: await hashPassword("the-real-password") });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "not-the-password" });

    expect(res.status).toBe(401);
    expect(sidCookieFrom(res)).toBeUndefined();
    const sessions = await db.select().from(sessionsTable);
    expect(sessions).toHaveLength(0);
  });

  it("returns 401 for an unknown email without leaking that the account is missing", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: `ghost-${Date.now()}@test.local`, password: "whatever12" });
    expect(res.status).toBe(401);
    // Same generic copy as the wrong-password case — no user-enumeration signal.
    expect(res.body.error).toBe("Email or password is incorrect");
  });

  it("accepts the correct password and issues a session resolvable by a follow-up authed GET /auth/user", async () => {
    const email = `goodlogin-${Date.now()}@test.local`;
    const password = "a-strong-password-99";
    const [user] = await db
      .insert(usersTable)
      .values({ email, passwordHash: await hashPassword(password) })
      .returning();

    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email, password });
    expect(loginRes.status).toBe(200);

    const sid = sidCookieFrom(loginRes);
    expect(sid).toBeTruthy();

    // Replay the cookie on a protected read — the session must resolve to the
    // same user (proves the issued session is real end-to-end, not just a 200).
    const meRes = await request(app)
      .get("/api/auth/user")
      .set("Cookie", `sid=${sid}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.user).not.toBeNull();
    expect(meRes.body.user.id).toBe(user.id);
    expect(meRes.body.user.email).toBe(email);

    // The Bearer-token form of the same sid resolves identically.
    const bearerRes = await request(app)
      .get("/api/auth/user")
      .set("Authorization", `Bearer ${sid}`);
    expect(bearerRes.body.user.id).toBe(user.id);
  });

  it("rate-limits repeated attempts for the same IP+email, returning 429 past the cap", async () => {
    // Dedicated email so this test's bucket is independent of the others.
    const email = `ratelimit-${Date.now()}@test.local`;
    await db
      .insert(usersTable)
      .values({ email, passwordHash: await hashPassword("right-password-7") });

    // The limiter is 5 / 15min per IP+email. The first 5 wrong attempts pass the
    // limiter (each 401); the 6th is blocked by the limiter itself (429) BEFORE
    // the credential check runs.
    let last = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "bad" });
    for (let i = 0; i < 4; i++) {
      last = await request(app)
        .post("/api/auth/login")
        .send({ email, password: "bad" });
      expect(last.status).toBe(401);
    }

    const blocked = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "bad" });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/too many/i);
  });
});

describe.runIf(INTEGRATION_AVAILABLE)("POST /api/auth/logout", () => {
  it("deletes the session row for the presented sid", async () => {
    const [user] = await db
      .insert(usersTable)
      .values({ email: `logout-${Date.now()}@test.local` })
      .returning();
    const sid = await createSession({ userId: user.id });

    // Sanity: the session is live before logout.
    expect(
      await db.select().from(sessionsTable).where(eq(sessionsTable.sid, sid)),
    ).toHaveLength(1);

    const res = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", `sid=${sid}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // The session row is gone, and the sid no longer authenticates.
    expect(
      await db.select().from(sessionsTable).where(eq(sessionsTable.sid, sid)),
    ).toHaveLength(0);
    const meRes = await request(app)
      .get("/api/auth/user")
      .set("Authorization", `Bearer ${sid}`);
    expect(meRes.body.user).toBeNull();
  });
});

describe.runIf(INTEGRATION_AVAILABLE)("POST /api/auth/forgot-password", () => {
  it("returns 200 and mints a reset token for a known email", async () => {
    const email = `known-${Date.now()}@test.local`;
    const [user] = await db
      .insert(usersTable)
      .values({ email, passwordHash: await hashPassword("password-aaa-1") })
      .returning();

    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const resets = await db
      .select()
      .from(passwordResetsTable)
      .where(eq(passwordResetsTable.userId, user.id));
    expect(resets).toHaveLength(1);
    // Only the HMAC hash is persisted — never a raw, replayable token.
    expect(resets[0].tokenHash).toBeTruthy();
    expect(resets[0].usedAt).toBeNull();
  });

  it("returns the SAME 200 for an unknown email and mints no token (no enumeration)", async () => {
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: `nobody-${Date.now()}@test.local` });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Nothing was created for a non-existent account.
    expect(await db.select().from(passwordResetsTable)).toHaveLength(0);
  });

  it("returns 200 even for a malformed email body (still no enumeration / no 400)", async () => {
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "not-an-email" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe.runIf(INTEGRATION_AVAILABLE)(
  "POST /api/auth/reset-password (Batch-1 session-invalidation fix)",
  () => {
    it("consumes a valid token: invalidates OLD sessions, marks the token used, and the NEW password logs in", async () => {
      const email = `reset-${Date.now()}@test.local`;
      const oldPassword = "old-password-111";
      const newPassword = "brand-new-password-222";
      const [user] = await db
        .insert(usersTable)
        .values({ email, passwordHash: await hashPassword(oldPassword) })
        .returning();

      // A pre-existing (possibly attacker) session that must die on reset.
      const oldSid = await createSession({ userId: user.id });
      // The reset token the user received by email (we store only its hash).
      const token = generateToken();
      await db.insert(passwordResetsTable).values({
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });

      const res = await request(app)
        .post("/api/auth/reset-password")
        .send({ token, password: newPassword });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // (1) Every pre-existing session for the user is revoked — the old sid no
      // longer authenticates. This is the security guard the Batch-1 fix added.
      const survivors = await db
        .select()
        .from(sessionsTable)
        .where(sql`${sessionsTable.sess}->>'userId' = ${user.id}`);
      expect(survivors).toHaveLength(0);
      const meOld = await request(app)
        .get("/api/auth/user")
        .set("Authorization", `Bearer ${oldSid}`);
      expect(meOld.body.user).toBeNull();

      // (2) The token is marked used (single-use; can't be replayed).
      const [resetRow] = await db
        .select()
        .from(passwordResetsTable)
        .where(eq(passwordResetsTable.userId, user.id));
      expect(resetRow.usedAt).not.toBeNull();

      // (3) The OLD password no longer works...
      const oldLogin = await request(app)
        .post("/api/auth/login")
        .send({ email, password: oldPassword });
      expect(oldLogin.status).toBe(401);

      // ...and the NEW password logs in and yields a working session.
      const newLogin = await request(app)
        .post("/api/auth/login")
        .send({ email, password: newPassword });
      expect(newLogin.status).toBe(200);
      const newSid = sidCookieFrom(newLogin);
      expect(newSid).toBeTruthy();
      const meNew = await request(app)
        .get("/api/auth/user")
        .set("Authorization", `Bearer ${newSid}`);
      expect(meNew.body.user?.id).toBe(user.id);
    });

    it("rejects an unknown / already-consumed token with 400 and changes no password", async () => {
      const email = `reset-bad-${Date.now()}@test.local`;
      const original = "keep-this-password-9";
      const [user] = await db
        .insert(usersTable)
        .values({ email, passwordHash: await hashPassword(original) })
        .returning();

      const res = await request(app)
        .post("/api/auth/reset-password")
        .send({ token: "deadbeef".repeat(8), password: "attacker-set-pw" });
      expect(res.status).toBe(400);

      // The stored hash is untouched: the original password still logs in.
      const [after] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, user.id));
      // (different email keeps this login bucket clean of the rate-limit test)
      const login = await request(app)
        .post("/api/auth/login")
        .send({ email, password: original });
      expect(login.status).toBe(200);
      expect(after.passwordHash).toBeTruthy();
    });
  },
);

describe.runIf(INTEGRATION_AVAILABLE)(
  "GET /api/auth/oauth/providers — reflects configured env",
  () => {
    const ENV_KEYS = [
      "GITHUB_OAUTH_CLIENT_ID",
      "GITHUB_OAUTH_CLIENT_SECRET",
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
    ] as const;
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const k of ENV_KEYS) saved[k] = process.env[k];
    });
    afterEach(() => {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    it("lists only the providers whose client id AND secret are both set", async () => {
      // Configure GitHub fully; leave Google's secret missing → only github.
      process.env.GITHUB_OAUTH_CLIENT_ID = "gh-id";
      process.env.GITHUB_OAUTH_CLIENT_SECRET = "gh-secret";
      process.env.GOOGLE_OAUTH_CLIENT_ID = "google-id";
      delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;

      const res = await request(app).get("/api/auth/oauth/providers");
      expect(res.status).toBe(200);
      expect(res.body.providers).toEqual(["github"]);
    });

    it("lists both when both providers are fully configured", async () => {
      process.env.GITHUB_OAUTH_CLIENT_ID = "gh-id";
      process.env.GITHUB_OAUTH_CLIENT_SECRET = "gh-secret";
      process.env.GOOGLE_OAUTH_CLIENT_ID = "google-id";
      process.env.GOOGLE_OAUTH_CLIENT_SECRET = "google-secret";

      const res = await request(app).get("/api/auth/oauth/providers");
      expect(res.body.providers).toEqual(["github", "google"]);
    });

    it("lists none when neither is configured (the SPA then hides the buttons)", async () => {
      for (const k of ENV_KEYS) delete process.env[k];
      const res = await request(app).get("/api/auth/oauth/providers");
      expect(res.body.providers).toEqual([]);
    });
  },
);
