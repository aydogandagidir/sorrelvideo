import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { getUserPlan } from "../services/billingService";
import { aiSuggestLimiter } from "../middlewares/rateLimit";
import {
  mintSessionToken,
  isLiveAvatarConfigured,
  isLiveAvatarSandbox,
  LiveAvatarNotConfiguredError,
  LiveAvatarError,
} from "../services/liveAvatarService";
import {
  recordAvatarSession,
  getAvatarSessionUsage,
} from "../services/avatarSessionsService";

const router: IRouter = Router();

const SessionTokenBody = z.object({
  pushToTalk: z.boolean().optional(),
});

/**
 * POST /api/avatar/session-token — mint a short-lived LiveAvatar session token
 * (Track F). The server holds LIVEAVATAR_API_KEY; the browser only ever sees the
 * short-lived token, which @heygen/liveavatar-web-sdk's LiveAvatarSession uses to
 * open a real-time conversational avatar stream.
 *
 * Config-gated (503 when no key), Pro-gated (403 upgrade_required), rate-limited
 * via the shared AI limiter. NOTE: per-minute billing is DEFERRED — sandbox mode
 * (the default) consumes no credits; wire metered billing before enabling live
 * (LIVEAVATAR_SANDBOX=false). This product line does NOT touch the render pipeline.
 */
router.post(
  "/avatar/session-token",
  aiSuggestLimiter,
  async (req: Request, res: Response): Promise<void> => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!isLiveAvatarConfigured()) {
      res.status(503).json({ error: "Live avatar is not configured" });
      return;
    }

    const parsed = SessionTokenBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }

    // Pro gate — the live avatar is a Pro feature (metered upstream).
    const [u] = await db
      .select({ stripeCustomerId: usersTable.stripeCustomerId })
      .from(usersTable)
      .where(eq(usersTable.id, req.user.id))
      .limit(1);
    const plan = await getUserPlan(u?.stripeCustomerId ?? null);
    if (plan !== "pro") {
      res.status(403).json({
        error: "The live avatar requires the Pro plan",
        reason: "upgrade_required",
      });
      return;
    }

    // Cost-control cap (LIVE only — sandbox sessions consume no credits). Pro
    // includes a monthly avatar-session allotment; beyond it, 403 avatar_limit
    // until the month resets. (Per-minute metering/charging is a follow-up.)
    if (!isLiveAvatarSandbox()) {
      const usage = await getAvatarSessionUsage(req.user.id);
      if (usage.used >= usage.limit) {
        res.status(403).json({
          error: "You've reached your monthly avatar session limit",
          reason: "avatar_limit",
        });
        return;
      }
    }

    try {
      const token = await mintSessionToken({
        pushToTalk: parsed.data.pushToTalk,
      });
      // Best-effort usage log (Track F billing foundation) — never fail the mint.
      void recordAvatarSession(
        req.user.id,
        token.sessionId,
        token.sandbox,
      ).catch((err) =>
        req.log.warn({ err }, "Could not record avatar session usage"),
      );
      req.log.info(
        { userId: req.user.id, sessionId: token.sessionId },
        "LiveAvatar session token minted",
      );
      res
        .status(200)
        .json({ sessionToken: token.sessionToken, sessionId: token.sessionId });
    } catch (err) {
      if (err instanceof LiveAvatarNotConfiguredError) {
        res.status(503).json({ error: err.message });
        return;
      }
      if (err instanceof LiveAvatarError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      req.log.error({ err }, "LiveAvatar token mint failed");
      res.status(500).json({ error: "Could not start an avatar session" });
    }
  },
);

export default router;
