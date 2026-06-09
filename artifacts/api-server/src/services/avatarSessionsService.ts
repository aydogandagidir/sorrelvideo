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
