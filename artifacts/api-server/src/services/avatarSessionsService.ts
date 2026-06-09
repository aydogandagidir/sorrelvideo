import { and, eq, gte, sql } from "drizzle-orm";
import { db, avatarSessionsTable } from "@workspace/db";

/**
 * Record a LiveAvatar session start (Track F). Called best-effort after a token
 * is minted — the usage base for future per-minute billing. A failure here must
 * never fail the token mint, so callers swallow errors.
 */
export async function recordAvatarSession(
  userId: string,
  sessionId: string,
  sandbox: boolean,
): Promise<void> {
  await db.insert(avatarSessionsTable).values({
    userId,
    sessionId: sessionId || null,
    sandbox,
  });
}

const DEFAULT_MONTHLY_SESSION_LIMIT = 30;

/**
 * The per-user monthly avatar-session cap (env-tunable via
 * AVATAR_MONTHLY_SESSION_LIMIT). A cost-control allotment within the Pro plan,
 * enforced only for LIVE sessions (sandbox is free) — see routes/avatar.ts. True
 * per-minute metering/charging is a deliberate follow-up.
 */
export function resolveAvatarSessionLimit(): number {
  const raw = Number(process.env.AVATAR_MONTHLY_SESSION_LIMIT);
  return Number.isFinite(raw) && raw >= 0
    ? Math.floor(raw)
    : DEFAULT_MONTHLY_SESSION_LIMIT;
}

function startOfUtcMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Avatar sessions this user has started this calendar month (UTC) + the cap. */
export async function getAvatarSessionUsage(
  userId: string,
): Promise<{ used: number; limit: number }> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(avatarSessionsTable)
    .where(
      and(
        eq(avatarSessionsTable.userId, userId),
        gte(avatarSessionsTable.createdAt, startOfUtcMonth()),
      ),
    );
  return { used: row?.count ?? 0, limit: resolveAvatarSessionLimit() };
}
