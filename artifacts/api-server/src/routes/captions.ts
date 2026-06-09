import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { getUserPlan } from "../services/billingService";
import { aiSuggestLimiter } from "../middlewares/rateLimit";
import {
  transcribeObject,
  isTranscriptionConfigured,
  TranscriptionNotConfiguredError,
  TranscriptionError,
} from "../services/transcriptionService";

const router: IRouter = Router();

const GenerateCaptionsBody = z.object({
  audioObjectPath: z.string().min(1).max(512),
});

/**
 * POST /api/captions/generate
 *
 * Word-timed captions from an uploaded audio object via Whisper (Track E2).
 * Returns `{ words: [{ text, start, end }] }`, which the client stores on
 * `RenderSettings.captions`; the render path burns them in as a root-timeline
 * overlay (see renderService.buildCaptionOverlay).
 *
 * Config-gated (503 when no ASR key is set), Pro-gated (403 upgrade_required),
 * and rate-limited via the shared AI limiter. Ownership of the audio object is
 * re-checked inside transcribeObject.
 */
router.post(
  "/captions/generate",
  aiSuggestLimiter,
  async (req: Request, res: Response): Promise<void> => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!isTranscriptionConfigured()) {
      res.status(503).json({ error: "Transcription is not configured" });
      return;
    }

    const parsed = GenerateCaptionsBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
      return;
    }

    // Pro gate — auto-captions are a Pro feature (mirrors the premium gates).
    const [u] = await db
      .select({ stripeCustomerId: usersTable.stripeCustomerId })
      .from(usersTable)
      .where(eq(usersTable.id, req.user.id))
      .limit(1);
    const plan = await getUserPlan(u?.stripeCustomerId ?? null);
    if (plan !== "pro") {
      res.status(403).json({
        error: "Auto-captions require the Pro plan",
        reason: "upgrade_required",
      });
      return;
    }

    try {
      const words = await transcribeObject(
        req.user.id,
        parsed.data.audioObjectPath,
      );
      res.status(200).json({ words });
    } catch (err) {
      if (err instanceof TranscriptionNotConfiguredError) {
        res.status(503).json({ error: err.message });
        return;
      }
      if (err instanceof TranscriptionError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      req.log.error({ err }, "Caption transcription failed");
      res.status(500).json({ error: "Could not generate captions" });
    }
  },
);

export default router;
