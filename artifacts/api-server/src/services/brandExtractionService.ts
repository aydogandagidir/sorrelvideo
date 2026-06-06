import fs from "node:fs";
import { getProvider, type ExtractBrandSignals } from "@workspace/ai";
import { logger } from "../lib/logger";
import { isSafeCssColor } from "../lib/compositionVars";
import { isSafeLogoUrl } from "../lib/logoUrl";
import { pickBrandColors, sanitizeFontFamily } from "../lib/brandColors";
import { checkAndIncrementAiCount } from "./billingService";
import {
  captureWebsite,
  type CaptureMediaType,
  type ScrapedBrandSignals,
} from "./websiteCaptureService";
import { createPreviewDir, disposePreview } from "./websitePreviewStore";

/**
 * The minimal capture shape brand refinement needs. A full `WebsiteCapture`
 * satisfies it, and so does the website→video flow's `ResolvedCapture` (preview
 * or fresh) — so a brand kit can be auto-created from either path.
 */
export interface BrandRefineSource {
  url: string;
  title: string;
  themeColor: string | null;
  height: number;
  screenshotPath: string;
  mediaType: CaptureMediaType;
  brand?: ScrapedBrandSignals;
}

/** True when the configured AI provider actually has its API key set. */
export function isAiConfigured(): boolean {
  const provider = (process.env.AI_PROVIDER ?? "anthropic").toLowerCase();
  return provider === "openai"
    ? !!process.env.OPENAI_API_KEY
    : !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Decide whether to use AI refinement for THIS user and, if so, charge one AI
 * unit (mirrors the suggest route's quota model). Returns false — degrading to
 * the deterministic heuristic, never failing — when AI isn't configured, the
 * user is over quota, or billing errors. So a Free user past their cap still
 * gets a (heuristic) brand kit, and we only spend a unit when AI will run.
 */
export async function consumeAiUnitIfAvailable(
  userId: string,
): Promise<boolean> {
  if (!isAiConfigured()) return false;
  try {
    await checkAndIncrementAiCount(userId);
    return true;
  } catch {
    return false;
  }
}

/** A fully-resolved brand kit detected from a website (NOT yet persisted). */
export interface ExtractedBrand {
  companyName: string | null;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string | null;
  fontFamily: string | null;
  logoUrl: string | null;
  sourceUrl: string;
}

// Brand-page extraction captures only a modest slice — enough to read the brand
// (above the fold) and cheap to send to vision. The website→video flow reuses
// its own (tall) capture and refines signals-only (see refineBrandFromCapture).
const EXTRACT_CAPTURE_HEIGHT = 1400;
// Don't ship a tall screenshot to the vision model — token cost scales with it.
const MAX_VISION_HEIGHT = 2000;

/** Strip marketing suffixes from a <title> → a plausible brand name. */
function cleanCompanyName(
  siteName: string | null,
  title: string | null,
  url: string,
): string | null {
  const candidate = (siteName || title || "").trim();
  if (candidate) {
    // "Acme — The best widgets" / "Acme | Home" / "Acme: widgets" → "Acme"
    const head = candidate.split(/\s+[|–—:·-]\s+/)[0]?.trim();
    const name = (head || candidate).slice(0, 80).trim();
    if (name) return name;
  }
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Deterministic, no-AI brand from scraped signals — also the AI fallback. */
function heuristicBrand(
  signals: ScrapedBrandSignals,
  themeColor: string | null,
  title: string,
  url: string,
): ExtractedBrand {
  const { primaryColor, secondaryColor, accentColor } = pickBrandColors(
    signals.colors,
    themeColor,
  );
  return {
    companyName: cleanCompanyName(signals.siteName, title, url),
    primaryColor,
    secondaryColor,
    accentColor,
    fontFamily: sanitizeFontFamily(signals.fontFamilies[0] ?? null),
    logoUrl: signals.logoCandidates[0] ?? null,
    sourceUrl: url,
  };
}

/** Coerce a value to a safe hex, or null. */
function safeColor(value: string | null | undefined): string | null {
  return value && isSafeCssColor(value) ? value : null;
}

/**
 * Turn an already-captured page (with scraped brand signals) into an
 * ExtractedBrand. The heuristic pick always runs; when `allowAi` is set and the
 * provider is configured, an LLM refines color ROLES + the company name (the
 * part a flat heuristic gets wrong), with the heuristic as a hard fallback so a
 * provider outage or a malformed response never breaks extraction.
 */
export async function refineBrandFromCapture(
  capture: BrandRefineSource,
  opts: { allowAi: boolean },
): Promise<ExtractedBrand> {
  const signals: ScrapedBrandSignals = capture.brand ?? {
    siteName: null,
    description: null,
    colors: [],
    fontFamilies: [],
    logoCandidates: [],
  };

  const base = heuristicBrand(
    signals,
    capture.themeColor,
    capture.title,
    capture.url,
  );

  if (!opts.allowAi) return base;

  try {
    const provider = getProvider();
    const aiSignals: ExtractBrandSignals = {
      url: capture.url,
      title: capture.title,
      siteName: signals.siteName,
      description: signals.description,
      themeColor: capture.themeColor,
      colors: signals.colors,
      fontFamilies: signals.fontFamilies,
      logoCandidates: signals.logoCandidates,
    };

    // Attach the screenshot only when it's small enough to be cheap for vision.
    let screenshot: { base64: string; mediaType: "image/png" | "image/jpeg" } | undefined;
    if (capture.height <= MAX_VISION_HEIGHT && fs.existsSync(capture.screenshotPath)) {
      screenshot = {
        base64: fs.readFileSync(capture.screenshotPath).toString("base64"),
        mediaType: capture.mediaType,
      };
    }

    const ai = await provider.extractBrand({ signals: aiSignals, screenshot });

    // Trust AI only where it produced something safe; otherwise keep heuristic.
    return {
      companyName: ai.companyName?.trim().slice(0, 80) || base.companyName,
      primaryColor: safeColor(ai.primaryColor) ?? base.primaryColor,
      secondaryColor: safeColor(ai.secondaryColor) ?? base.secondaryColor,
      accentColor: safeColor(ai.accentColor) ?? base.accentColor,
      fontFamily: sanitizeFontFamily(ai.fontFamily) ?? base.fontFamily,
      logoUrl: base.logoUrl,
      sourceUrl: capture.url,
    };
  } catch (err) {
    logger.warn(
      { err, url: capture.url },
      "AI brand refine failed — using heuristic",
    );
    return base;
  }
}

/**
 * Standalone brand extraction for the Brand Kit page: capture a modest slice of
 * the URL (SSRF-guarded) + scrape signals, then refine. Cleans up its temp dir.
 *
 * Throws SsrfError (unsafe URL) or WebsiteCaptureError (couldn't load the site).
 */
export async function extractBrandFromUrl(
  rawUrl: string,
  opts: { allowAi: boolean },
): Promise<ExtractedBrand> {
  const dir = createPreviewDir();
  try {
    const capture = await captureWebsite(rawUrl, dir, {
      maxHeight: EXTRACT_CAPTURE_HEIGHT,
      format: "image/jpeg",
      extractBrand: true,
    });
    const brand = await refineBrandFromCapture(capture, opts);
    // Final guard: never hand back a logoUrl that isn't attribute-safe.
    if (brand.logoUrl && !isSafeLogoUrl(brand.logoUrl)) brand.logoUrl = null;
    return brand;
  } finally {
    disposePreview({ dir });
  }
}
