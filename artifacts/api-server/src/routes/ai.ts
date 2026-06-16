import { Router, type IRouter, type Request, type Response } from "express";
import { getProvider, SuggestInputSchema } from "@workspace/ai";
import { checkAndIncrementAiCount } from "../services/billingService";
import { getDefaultBrandKit } from "../services/brandKitService";
import { aiSuggestLimiter } from "../middlewares/rateLimit";
import { z } from "zod";

const router: IRouter = Router();

const AiSuggestBody = z.object({
  prompt: z.string().min(3).max(500),
});

/** The current Studio copy supplied to /ai/edit (fields may be empty drafts). */
const AiEditBody = z.object({
  instruction: z.string().min(3).max(500),
  current: z.object({
    headline: z.string().max(160),
    bodyText: z.string().max(500),
    ctaText: z.string().max(48),
  }),
});

type CurrentCopy = z.infer<typeof AiEditBody>["current"];

/**
 * Shared core for the two copy endpoints. Both produce a Studio-ready
 * { headline, bodyText, ctaText } triple from the configured LLM provider
 * (AI_PROVIDER env: 'anthropic' | 'openai'), grounded in the user's DEFAULT
 * Brand DNA, and both charge AI quota only AFTER a successful generation.
 *
 * - `/ai/suggest` calls this with no `current` → a from-scratch brief.
 * - `/ai/edit` passes the `current` copy → the provider revises it minimally
 *   per the instruction (same output shape, same gating).
 *
 * Auth + body validation stay in each route (distinct bodies, and so a missing
 * session is 401 before a bad body is 400); `userId` is passed in already
 * narrowed.
 */
async function generateStudioCopy(
  req: Request,
  res: Response,
  userId: string,
  prompt: string,
  current?: CurrentCopy,
): Promise<void> {
  // Ground the copy in the user's DEFAULT Brand DNA (multi-kit: pick the
  // default, not an arbitrary row).
  const brand = await getDefaultBrandKit(userId);

  const provider = getProvider();
  const mode = current ? "edit" : "suggest";

  let result: Awaited<ReturnType<typeof provider.suggest>>;
  try {
    const input = SuggestInputSchema.parse({
      prompt,
      // When present, SuggestInputSchema flips the provider into edit framing
      // (revise the current copy) instead of generate-from-brief.
      current,
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

    result = await provider.suggest(input);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const status =
      typeof (err as { status?: unknown }).status === "number"
        ? (err as { status: number }).status
        : undefined;
    // Put the real cause in the message itself — structured `err` is attached
    // too, but log drains often surface only the message line.
    req.log.error(
      { err, provider: provider.name, status, mode },
      `AI ${mode} provider call failed: ${detail}`,
    );
    // A missing/invalid provider key is an operator config problem, not a
    // transient failure — return a distinct, actionable message + status so
    // the UI shows a real reason instead of a generic "try again".
    const notConfigured =
      /API_KEY is not set|not configured/i.test(detail) || status === 401;
    res.status(notConfigured ? 503 : 502).json({
      error: notConfigured
        ? "AI isn't configured on the server yet. An admin needs to set ANTHROPIC_API_KEY (or OPENAI_API_KEY)."
        : "AI provider could not generate a suggestion",
    });
    return;
  }

  // Surface prompt-cache effectiveness. cacheReadInputTokens > 0 means the
  // stable system/brand prefix was served from cache (~10% of input cost);
  // cacheCreationInputTokens is the one-time write that seeds a breakpoint.
  // Both are undefined for providers/models where caching did not engage.
  req.log.info(
    {
      provider: provider.name,
      mode,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheCreationInputTokens: result.usage.cacheCreationInputTokens,
      cacheReadInputTokens: result.usage.cacheReadInputTokens,
      cacheHit: (result.usage.cacheReadInputTokens ?? 0) > 0,
    },
    `AI ${mode} generated`,
  );

  // Charge quota only AFTER a successful generation — a provider 502 must not
  // burn a Free user's monthly unit for a result they never got (mirrors the
  // render path not consuming quota on failure). Abuse is already bounded by
  // aiSuggestLimiter, so deferring the increment past the LLM call is safe.
  try {
    await checkAndIncrementAiCount(userId);
  } catch (err) {
    const e = err as { reason?: string; message?: string };
    if (e.reason === "upgrade_required") {
      res.status(403).json({
        error: e.message ?? "AI suggestion limit reached",
        reason: "upgrade_required",
      });
      return;
    }
    throw err;
  }

  res.status(200).json({
    headline: result.headline,
    bodyText: result.bodyText,
    ctaText: result.ctaText,
  });
}

/**
 * POST /api/ai/suggest
 *
 * Returns a Studio-ready { headline, bodyText, ctaText } triple generated by
 * the configured LLM provider from a free-text brief. Brand voice from the
 * user's brand_kit row is merged into the system prompt. Quota is enforced via
 * billingService.
 */
router.post(
  "/ai/suggest",
  aiSuggestLimiter,
  async (req: Request, res: Response): Promise<void> => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const parsed = AiSuggestBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues[0]?.message ?? "Invalid prompt",
      });
      return;
    }

    await generateStudioCopy(req, res, req.user.id, parsed.data.prompt);
  },
);

/**
 * POST /api/ai/edit
 *
 * Revises the user's CURRENT Studio copy per a natural-language instruction
 * (the "Edit with AI" flow) — same provider, brand grounding, quota and rate
 * limit as /ai/suggest, but the model edits the supplied copy minimally instead
 * of writing from scratch. Returns the edited { headline, bodyText, ctaText }.
 */
router.post(
  "/ai/edit",
  aiSuggestLimiter,
  async (req: Request, res: Response): Promise<void> => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const parsed = AiEditBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues[0]?.message ?? "Invalid edit request",
      });
      return;
    }

    await generateStudioCopy(
      req,
      res,
      req.user.id,
      parsed.data.instruction,
      parsed.data.current,
    );
  },
);

export default router;
