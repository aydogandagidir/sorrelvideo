import { Router, type IRouter, type Response } from "express";
import type { Logger } from "pino";
import { getProvider } from "@workspace/ai";
import {
  GetBrandKitResponse,
  UpdateBrandKitBody,
  CreateBrandKitBody,
  UpdateBrandKitByIdBody,
  ExtractBrandBody,
  ExtractBrandResponse,
} from "@workspace/api-zod";
import {
  listBrandKits,
  getBrandKit,
  getDefaultBrandKit,
  createBrandKit,
  updateBrandKit,
  deleteBrandKit,
  ensureDefaultBrandKit,
  transientDefaultBrandKit,
  BrandKitValidationError,
} from "../services/brandKitService";
import {
  extractBrandFromUrl,
  consumeAiUnitIfAvailable,
  isAiConfigured,
} from "../services/brandExtractionService";
import { checkAndIncrementAiCount } from "../services/billingService";
import { brandExtractLimiter, aiSuggestLimiter } from "../middlewares/rateLimit";
import { normalizeWebsiteUrl } from "../lib/websiteUrl";
import { SsrfError } from "../lib/ssrfGuard";
import { WebsiteCaptureError } from "../services/websiteCaptureService";

const router: IRouter = Router();

function serializeDates<T>(data: T): T {
  return JSON.parse(JSON.stringify(data));
}

function parseId(raw: string | string[]): number | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const id = parseInt(v, 10);
  return Number.isNaN(id) ? null : id;
}

// ───────────────────────── Back-compat singleton (/brand) ─────────────────────
// `GET /brand` / `PUT /brand` still operate on the user's DEFAULT kit so older
// callers (studio.tsx's useGetBrandKit, the brand.test fixtures) keep working
// while the new multi-kit collection lives under /brand-kits.

router.get("/brand", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  // Return the default kit, or a NON-persisted default so we don't litter an
  // empty placeholder row (which website→video would then wrongly reuse).
  const kit =
    (await getDefaultBrandKit(req.user.id)) ??
    transientDefaultBrandKit(req.user.id);
  res.json(GetBrandKitResponse.parse(serializeDates(kit)));
});

router.put("/brand", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const parsed = UpdateBrandKitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const kit = await ensureDefaultBrandKit(req.user.id);
    const updated = await updateBrandKit(req.user.id, kit.id, parsed.data);
    res.json(GetBrandKitResponse.parse(serializeDates(updated)));
  } catch (err) {
    if (err instanceof BrandKitValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});

// ─────────────────────────── Multi-kit collection ────────────────────────────

router.get("/brand-kits", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  // No bootstrap: an empty list is meaningful ("the user has no kit yet"), which
  // website→video relies on to decide whether to auto-detect. The Brand page
  // shows a blank "new" draft when the list is empty.
  const kits = await listBrandKits(req.user.id);
  res.json(serializeDates(kits));
});

router.post("/brand-kits", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const parsed = CreateBrandKitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const kit = await createBrandKit(req.user.id, parsed.data);
    res.status(201).json(GetBrandKitResponse.parse(serializeDates(kit)));
  } catch (err) {
    if (err instanceof BrandKitValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});

// Unsafe/invalid URL → 400; site unreachable → 502; else 500.
function handleExtractError(err: unknown, res: Response, log: Logger): void {
  if (err instanceof SsrfError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof WebsiteCaptureError) {
    res.status(502).json({ error: err.message });
    return;
  }
  log.error({ err }, "brand extract failed");
  res.status(500).json({ error: "Could not detect a brand from that URL" });
}

// POST /brand-kits/extract — detect (don't save) a brand from a URL. Registered
// BEFORE /brand-kits/:id so "extract" isn't parsed as an id. Launches headless
// Chrome (+ optional LLM refine within AI quota) — rate-limited.
router.post(
  "/brand-kits/extract",
  brandExtractLimiter,
  async (req, res): Promise<void> => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const parsed = ExtractBrandBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      // Spend one AI unit only if available — otherwise degrade to the
      // deterministic heuristic (still returns a brand).
      const allowAi = await consumeAiUnitIfAvailable(req.user.id);
      const brand = await extractBrandFromUrl(
        normalizeWebsiteUrl(parsed.data.url),
        { allowAi },
      );
      res.status(200).json(ExtractBrandResponse.parse(brand));
    } catch (err) {
      handleExtractError(err, res, req.log);
    }
  },
);

router.get("/brand-kits/:id", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid brand kit id" });
    return;
  }
  const kit = await getBrandKit(req.user.id, id);
  if (!kit) {
    res.status(404).json({ error: "Brand kit not found" });
    return;
  }
  res.json(GetBrandKitResponse.parse(serializeDates(kit)));
});

router.patch("/brand-kits/:id", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid brand kit id" });
    return;
  }
  const parsed = UpdateBrandKitByIdBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const updated = await updateBrandKit(req.user.id, id, parsed.data);
    if (!updated) {
      res.status(404).json({ error: "Brand kit not found" });
      return;
    }
    res.json(GetBrandKitResponse.parse(serializeDates(updated)));
  } catch (err) {
    if (err instanceof BrandKitValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});

router.delete("/brand-kits/:id", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid brand kit id" });
    return;
  }
  const ok = await deleteBrandKit(req.user.id, id);
  if (!ok) {
    res.status(404).json({ error: "Brand kit not found" });
    return;
  }
  res.status(204).end();
});

// POST /brand-kits/:id/video-ideas — Pomelli-style "campaign ideas": turn a saved
// Brand DNA into a few ready-to-render video concepts. Needs AI (no heuristic
// fallback here) and consumes one AI unit on success. Rate-limited via the AI
// limiter (it's an LLM call, no Chrome).
router.post(
  "/brand-kits/:id/video-ideas",
  aiSuggestLimiter,
  async (req, res): Promise<void> => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "Invalid brand kit id" });
      return;
    }
    const kit = await getBrandKit(req.user.id, id);
    if (!kit) {
      res.status(404).json({ error: "Brand kit not found" });
      return;
    }
    if (!isAiConfigured()) {
      res.status(503).json({ error: "AI is not configured for video ideas" });
      return;
    }

    const provider = getProvider();
    let result: Awaited<ReturnType<typeof provider.generateVideoIdeas>>;
    try {
      result = await provider.generateVideoIdeas({
        dna: {
          companyName: kit.companyName,
          tagline: kit.tagline,
          description: kit.description,
          valueProposition: kit.valueProposition,
          targetAudience: kit.targetAudience,
          industry: kit.industry,
          keywords: kit.keywords,
          personality: kit.personality,
          voice: kit.brandVoice,
          voiceDescription: kit.voiceDescription,
        },
        count: 4,
      });
    } catch (err) {
      req.log.error({ err, provider: provider.name }, "video ideas failed");
      res.status(502).json({ error: "AI provider could not generate ideas" });
      return;
    }

    // Charge quota only after a successful generation (mirrors /ai/suggest).
    try {
      await checkAndIncrementAiCount(req.user.id);
    } catch (err) {
      const e = err as { reason?: string; message?: string };
      if (e.reason === "upgrade_required") {
        res.status(403).json({
          error: e.message ?? "AI limit reached",
          reason: "upgrade_required",
        });
        return;
      }
      throw err;
    }

    res.status(200).json({ ideas: result.ideas });
  },
);

export default router;
