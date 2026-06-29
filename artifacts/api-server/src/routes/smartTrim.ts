import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { smartTrimLimiter } from "../middlewares/rateLimit";
import {
  isTranscriptionConfigured,
  TranscriptionError,
  TranscriptionNotConfiguredError,
} from "../services/transcriptionService";
import {
  createSmartTrimVideo,
  SmartTrimError,
} from "../services/smartTrimService";

const router: IRouter = Router();

const SmartTrimBody = z.object({
  videoObjectPath: z.string().trim().min(1),
  removeFillers: z.boolean().optional(),
  removeSilences: z.boolean().optional(),
  silenceThresholdMs: z.number().int().min(200).max(5000).optional(),
  captions: z.boolean().optional(),
  brandKitId: z.number().int().positive().optional(),
});

/**
 * POST /api/smart-trim — transcript-driven cleanup of a user-uploaded video.
 * Whisper word-times the audio, an EDL drops filler words + over-long silences,
 * and FFmpeg cuts/concatenates the survivors into a tightened, branded mp4 (the
 * render auto-starts via the executeRender smart-trim branch).
 *
 * Like /avatar/video: NOT Pro-gated (a Free user spends one AI unit, charged in
 * the service AFTER transcription succeeds; the auto-render consumes the render
 * quota and degrades to a draft when exhausted). Config-gated on the ASR key;
 * rate-limited via the dedicated smartTrimLimiter (download + encode is heavy).
 */
router.post(
  "/smart-trim",
  smartTrimLimiter,
  async (req: Request, res: Response): Promise<void> => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const parsed = SmartTrimBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }

    if (!isTranscriptionConfigured()) {
      res.status(503).json({ error: "Transcription is not configured" });
      return;
    }

    try {
      const result = await createSmartTrimVideo(req.user.id, parsed.data);
      req.log.info(
        {
          userId: req.user.id,
          projectId: result.project.id,
          renderStarted: result.renderStarted,
        },
        "Smart Trim video created",
      );
      res.status(201).json({
        project: JSON.parse(JSON.stringify(result.project)),
        renderStarted: result.renderStarted,
        renderMessage: result.renderMessage,
      });
    } catch (err) {
      if (err instanceof TranscriptionNotConfiguredError) {
        res.status(503).json({ error: err.message });
        return;
      }
      const e = err as { reason?: string; message?: string };
      if (e.reason === "upgrade_required") {
        res.status(403).json({
          error: e.message ?? "AI limit reached — upgrade to Pro",
          reason: "upgrade_required",
        });
        return;
      }
      if (err instanceof SmartTrimError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      if (err instanceof TranscriptionError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      req.log.error({ err }, "Smart Trim video creation failed");
      res.status(500).json({ error: "Could not create the video" });
    }
  },
);

export default router;
