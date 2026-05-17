import crypto from "crypto";
import { type Request, type Response } from "express";
import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import { db, sessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export const SESSION_COOKIE = "sid";
export const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;

// OWASP recommended Argon2id parameters (m=19 MiB, t=2, p=1).
const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export interface SessionData {
  userId: string;
}

export async function hashPassword(plain: string): Promise<string> {
  return argon2Hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(
  hash: string,
  plain: string,
): Promise<boolean> {
  try {
    return await argon2Verify(hash, plain);
  } catch {
    return false;
  }
}

export async function createSession(data: SessionData): Promise<string> {
  const sid = crypto.randomBytes(32).toString("hex");
  await db.insert(sessionsTable).values({
    sid,
    sess: data as unknown as Record<string, unknown>,
    expire: new Date(Date.now() + SESSION_TTL),
  });
  return sid;
}

export async function getSession(sid: string): Promise<SessionData | null> {
  const [row] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.sid, sid));

  if (!row || row.expire < new Date()) {
    if (row) await deleteSession(sid);
    return null;
  }

  return row.sess as unknown as SessionData;
}

export async function updateSession(
  sid: string,
  data: SessionData,
): Promise<void> {
  await db
    .update(sessionsTable)
    .set({
      sess: data as unknown as Record<string, unknown>,
      expire: new Date(Date.now() + SESSION_TTL),
    })
    .where(eq(sessionsTable.sid, sid));
}

export async function deleteSession(sid: string): Promise<void> {
  await db.delete(sessionsTable).where(eq(sessionsTable.sid, sid));
}

export async function clearSession(res: Response, sid?: string): Promise<void> {
  if (sid) await deleteSession(sid);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function getSessionId(req: Request): string | undefined {
  const authHeader = req.headers["authorization"];
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  return req.cookies?.[SESSION_COOKIE];
}

export function setSessionCookie(res: Response, sid: string): void {
  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL,
  });
}

/**
 * Issue a URL-safe random token for email verification / password reset.
 * 32 bytes hex = 256 bits of entropy, well above brute-force range.
 */
export function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * HMAC-SHA256 the token with SESSION_SECRET before persisting. We only ever
 * store the hash, so a DB leak does not let an attacker consume tokens.
 * The plaintext token lives only in the URL we email to the user.
 */
export function hashToken(token: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET must be set to hash auth tokens");
  }
  return crypto.createHmac("sha256", secret).update(token).digest("hex");
}
