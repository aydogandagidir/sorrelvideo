import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import {
  getProvider,
  ChatInputSchema,
  ChatMessageSchema,
} from "@workspace/ai";
import { getUserPlan } from "../services/billingService";
import { getDefaultBrandKit } from "../services/brandKitService";
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
import {
  isTtsConfigured,
  TTS_VOICES,
  TtsError,
  TtsNotConfiguredError,
} from "../services/ttsService";
import {
  isTranscriptionConfigured,
  TranscriptionError,
  TranscriptionNotConfiguredError,
} from "../services/transcriptionService";
import { createTalkingHostVideo } from "../services/talkingHostService";

const router: IRouter = Router();

const SessionTokenBody = z.object({
  pushToTalk: z.boolean().optional(),
});

const ChatBody = z.object({
  messages: z.array(ChatMessageSchema).min(1).max(40),
});

const AvatarVideoBody = z.object({
  script: z.string().trim().min(10).max(1200),
  voice: z.enum(TTS_VOICES).optional(),
  brandKitId: z.number().int().positive().optional(),
});

/** Resolve the caller's plan (avatar features are Pro). */
async function getRequestPlan(userId: string): Promise<"free" | "pro"> {
  const [u] = await db
    .select({ stripeCustomerId: usersTable.stripeCustomerId })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return getUserPlan(u?.stripeCustomerId ?? null);
}

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
    const plan = await getRequestPlan(req.user.id);
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

/**
 * GET /api/avatar/usage — this month's avatar-session usage + the cap, so the UI
 * can show the Pro allotment transparently (only meaningful in live mode; sandbox
 * is free + uncapped). Auth-only; no Pro gate so the page can render the state.
 */
router.get(
  "/avatar/usage",
  async (req: Request, res: Response): Promise<void> => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const usage = await getAvatarSessionUsage(req.user.id);
    res.status(200).json({
      used: usage.used,
      limit: usage.limit,
      sandbox: isLiveAvatarSandbox(),
    });
  },
);

/**
 * POST /api/avatar/chat — the LLM turn for the FREE browser-native avatar. The
 * browser does speech-to-text + text-to-speech for free; this returns the
 * brand-voiced plain-text reply it speaks. Pro-gated + rate-limited; reuses the
 * configured AI provider (ANTHROPIC/OPENAI) + the user's default Brand DNA for
 * personality. No SaaS, no credits — this is the zero-cost path.
 */
router.post(
  "/avatar/chat",
  aiSuggestLimiter,
  async (req: Request, res: Response): Promise<void> => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const parsed = ChatBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }

    // Avatar is a Pro feature (consistent with the live path). Pro AI is
    // unlimited, so no monthly-unit charge here — abuse is bounded by the limiter.
    const plan = await getRequestPlan(req.user.id);
    if (plan !== "pro") {
      res.status(403).json({
        error: "The avatar requires the Pro plan",
        reason: "upgrade_required",
      });
      return;
    }

    const brand = await getDefaultBrandKit(req.user.id);
    const provider = getProvider();

    try {
      const input = ChatInputSchema.parse({
        messages: parsed.data.messages,
        brand: {
          companyName: brand?.companyName ?? null,
          tagline: brand?.tagline ?? null,
          description: brand?.description ?? null,
          valueProposition: brand?.valueProposition ?? null,
          targetAudience: brand?.targetAudience ?? null,
          industry: brand?.industry ?? null,
          keywords: brand?.keywords ?? null,
          personality: brand?.personality ?? null,
          voice: brand?.brandVoice ?? null,
          voiceDescription: brand?.voiceDescription ?? null,
        },
      });
      const result = await provider.chat(input);
      req.log.info(
        {
          provider: provider.name,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        },
        "Avatar chat reply generated",
      );
      res.status(200).json({ reply: result.reply });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const status =
        typeof (err as { status?: unknown }).status === "number"
          ? (err as { status: number }).status
          : undefined;
      req.log.error(
        { err, provider: provider.name, status },
        `Avatar chat provider call failed: ${detail}`,
      );
      const notConfigured =
        /API_KEY is not set|not configured/i.test(detail) || status === 401;
      res.status(notConfigured ? 503 : 502).json({
        error: notConfigured
          ? "AI isn't configured on the server yet. An admin needs to set ANTHROPIC_API_KEY (or OPENAI_API_KEY)."
          : "The avatar could not reply right now",
      });
    }
  },
);

/**
 * POST /api/avatar/video — script → branded talking-host MP4 (Track F+, the
 * avatar's render-pipeline value). TTS the script, word-time it with Whisper,
 * create a `talking-host` project, and auto-start its render.
 *
 * Deliberately NOT Pro-gated (unlike the neighboring /avatar/chat): a Free
 * user spends ONE AI quota unit per creation (charged inside the service,
 * AFTER the providers succeed) and the auto-render consumes the regular render
 * quota — when that is exhausted the project still lands as a draft and the
 * response says so. Config-gated on both TTS and ASR keys; rate-limited via
 * the shared AI limiter.
 */
router.post(
  "/avatar/video",
  aiSuggestLimiter,
  async (req: Request, res: Response): Promise<void> => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const parsed = AvatarVideoBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }

    if (!isTtsConfigured() || !isTranscriptionConfigured()) {
      res.status(503).json({ error: "Text-to-speech is not configured" });
      return;
    }

    try {
      const result = await createTalkingHostVideo(req.user.id, parsed.data);
      req.log.info(
        {
          userId: req.user.id,
          projectId: result.project.id,
          renderStarted: result.renderStarted,
        },
        "Talking-host video created",
      );
      res.status(201).json({
        project: JSON.parse(JSON.stringify(result.project)),
        renderStarted: result.renderStarted,
        renderMessage: result.renderMessage,
      });
    } catch (err) {
      if (
        err instanceof TtsNotConfiguredError ||
        err instanceof TranscriptionNotConfiguredError
      ) {
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
      if (err instanceof TtsError || err instanceof TranscriptionError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      req.log.error({ err }, "Talking-host video creation failed");
      res.status(500).json({ error: "Could not create the video" });
    }
  },
);

export default router;
