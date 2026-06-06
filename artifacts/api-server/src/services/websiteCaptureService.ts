import path from "node:path";
import fs from "node:fs";
import puppeteer from "puppeteer";
import { assertSafeUrl, SsrfError } from "../lib/ssrfGuard";
import { logger } from "../lib/logger";
import { bboxToCrop, type CropRegion } from "../lib/websiteCrop";
import { mergeCandidates, type ColorCandidate } from "../lib/brandColors";
import { isSafeLogoUrl } from "../lib/logoUrl";

export class WebsiteCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebsiteCaptureError";
  }
}

/** A candidate page section for the AI "describe the part you want" mode. */
export interface PageSection {
  /** Heading / text snippet shown to the LLM to match the user's description. */
  label: string;
  /** The section's region as a 0–1 crop of the capture. */
  crop: CropRegion;
}

/** Brand signals scraped from the page (for the Brand Kit auto-extract flow). */
export interface ScrapedBrandSignals {
  /** og:site_name / application-name — a cleaner brand name than the <title>. */
  siteName: string | null;
  /** meta description / og:description — context for naming the company. */
  description: string | null;
  /** Deduped, normalised, weight-sorted color candidates seen on the page. */
  colors: ColorCandidate[];
  /** Primary font family names seen on headings/body (raw first tokens). */
  fontFamilies: string[];
  /** Absolute, http(s)-safe logo image URLs (header img / og:image / icon). */
  logoCandidates: string[];
  /** Visible page copy (headings + paragraphs) for narrative DNA synthesis. */
  textSample: string;
}

export type CaptureMediaType = "image/png" | "image/jpeg";

export interface WebsiteCapture {
  url: string;
  title: string;
  themeColor: string | null;
  screenshotPath: string;
  /** MIME type of the written screenshot — build the data URI from this. */
  mediaType: CaptureMediaType;
  width: number;
  height: number;
  /** Set when `opts.selector` matched an element — the region to feature. */
  selectorCrop?: CropRegion;
  /** Set when `opts.extractSections` — candidate sections for AI matching. */
  sections?: PageSection[];
  /** Set when `opts.extractBrand` — scraped brand signals for AI refinement. */
  brand?: ScrapedBrandSignals;
}

const VIEWPORT = { width: 1280, height: 800 } as const;
const NAV_TIMEOUT_MS = 20_000;
// Cap a very tall page so a single capture can't blow up memory / the render.
const MAX_CAPTURE_HEIGHT = 6000;

/**
 * Capture a screenshot + basic metadata of a user-supplied website, for the
 * website→video flow. SECURITY (SSRF): the URL is validated with assertSafeUrl
 * BEFORE the browser launches, AND every main-frame navigation (including
 * redirects) is re-validated through request interception — so a public URL that
 * 30x-redirects to http://169.254.169.254 (cloud metadata) is aborted mid-flight.
 * Sub-resource SSRF and DNS rebinding remain the infra layer's responsibility
 * (the render box should have no internal network egress — see DEPLOYMENT.md).
 */
export async function captureWebsite(
  rawUrl: string,
  outDir: string,
  opts?: {
    maxHeight?: number;
    selector?: string;
    extractSections?: boolean;
    /** Also scrape brand signals (colors/fonts/logo/name) for the brand-kit flow. */
    extractBrand?: boolean;
    /**
     * Screenshot encoding. "jpeg" keeps a tall full-page capture's data URI
     * bounded (the website→video flow embeds it inline). Defaults to "png".
     */
    format?: CaptureMediaType;
    /** JPEG quality 1–100 (ignored for png). Defaults to 82. */
    quality?: number;
  },
): Promise<WebsiteCapture> {
  // SSRF guard first — throws SsrfError before any network/browser work.
  const url = await assertSafeUrl(rawUrl);

  const mediaType: CaptureMediaType = opts?.format ?? "image/png";
  const ext = mediaType === "image/jpeg" ? "jpg" : "png";

  fs.mkdirSync(outDir, { recursive: true });
  const screenshotPath = path.join(outDir, `capture.${ext}`);

  // Resolve an explicit Chrome binary the way the render engine does, so prod
  // works. The full `puppeteer` package downloads Chrome into ~/.cache/puppeteer
  // at build, but the Docker runtime image copies only node_modules — not that
  // cache — so a bare launch() throws "Could not find Chrome" and every
  // website→video call 502s. Reusing PRODUCER_HEADLESS_SHELL_PATH (already
  // /usr/bin/chromium in the image) fixes prod with zero new env. Undefined
  // locally keeps puppeteer's default cache resolution (dev has the binary).
  const executablePath =
    process.env.CAPTURE_CHROME_PATH ||
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.PRODUCER_HEADLESS_SHELL_PATH ||
    undefined;

  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: [
      "--disable-dev-shm-usage",
      // Keep Chrome's sandbox ON by default (we load untrusted pages). Some
      // container hosts (root, no user namespaces) require it off — opt in
      // explicitly there rather than weakening security everywhere.
      ...(process.env.CAPTURE_NO_SANDBOX === "true"
        ? ["--no-sandbox", "--disable-setuid-sandbox"]
        : []),
    ],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ ...VIEWPORT, deviceScaleFactor: 1 });
    // An untrusted page must not pop dialogs or download files.
    page.on("dialog", (d) => void d.dismiss().catch(() => undefined));

    // Re-validate every main-frame navigation (catches redirect-to-internal).
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
        assertSafeUrl(req.url())
          .then(() => req.continue())
          .catch(() => req.abort("blockedbyclient"))
          .catch(() => undefined);
      } else {
        req.continue().catch(() => undefined);
      }
    });

    let resp;
    try {
      resp = await page.goto(url.toString(), {
        waitUntil: "networkidle2",
        timeout: NAV_TIMEOUT_MS,
      });
    } catch (err) {
      throw new WebsiteCaptureError(
        `Could not load the site (${err instanceof Error ? err.message.split("\n")[0] : "navigation failed"})`,
      );
    }
    if (!resp) {
      throw new WebsiteCaptureError("The site did not respond");
    }
    if (!resp.ok()) {
      throw new WebsiteCaptureError(`The site returned HTTP ${resp.status()}`);
    }

    const title = (await page.title().catch(() => "")) || url.hostname;
    const themeColor = await page
      .$eval('meta[name="theme-color"]', (el) => el.getAttribute("content"))
      .catch(() => null);

    const fullHeight = await page
      .evaluate(() => document.documentElement.scrollHeight)
      .catch(() => VIEWPORT.height);
    const captureHeight = Math.max(
      VIEWPORT.height,
      Math.min(fullHeight, opts?.maxHeight ?? MAX_CAPTURE_HEIGHT),
    );

    const buf = await page.screenshot(
      mediaType === "image/jpeg"
        ? {
            type: "jpeg",
            quality: opts?.quality ?? 82,
            clip: { x: 0, y: 0, width: VIEWPORT.width, height: captureHeight },
          }
        : {
            type: "png",
            clip: { x: 0, y: 0, width: VIEWPORT.width, height: captureHeight },
          },
    );
    fs.writeFileSync(screenshotPath, buf);

    // Optional: resolve a CSS-selector region (the "by element" mode). The page
    // isn't scrolled, so boundingBox() is the element's absolute page position.
    let selectorCrop: CropRegion | undefined;
    if (opts?.selector) {
      const handle = await page.$(opts.selector).catch(() => null);
      const box = handle ? await handle.boundingBox().catch(() => null) : null;
      if (!box) {
        throw new WebsiteCaptureError(
          `No element on the page matches "${opts.selector}".`,
        );
      }
      selectorCrop = bboxToCrop(box, VIEWPORT.width, captureHeight);
    }

    // Optional: collect candidate sections for the AI "describe it" mode — a
    // heading/text label + the block's box, mapped to a crop. Best-effort.
    let sections: PageSection[] | undefined;
    if (opts?.extractSections) {
      const raw = await page
        .evaluate(() => {
          const found: {
            label: string;
            x: number;
            y: number;
            width: number;
            height: number;
          }[] = [];
          const seen = new Set<string>();
          const nodes = Array.from(
            document.querySelectorAll(
              "section, [id], main > div, header, footer, article",
            ),
          );
          for (const el of nodes) {
            const r = el.getBoundingClientRect();
            if (r.width < 200 || r.height < 80) continue;
            const heading = el.querySelector("h1,h2,h3,h4");
            const label = (heading?.textContent || el.textContent || "")
              .trim()
              .replace(/\s+/g, " ")
              .slice(0, 120);
            if (!label || seen.has(label)) continue;
            seen.add(label);
            found.push({
              label,
              x: r.left + window.scrollX,
              y: r.top + window.scrollY,
              width: r.width,
              height: r.height,
            });
            if (found.length >= 25) break;
          }
          return found;
        })
        .catch(() => []);
      sections = raw.map((s) => ({
        label: s.label,
        crop: bboxToCrop(s, VIEWPORT.width, captureHeight),
      }));
    }

    // Optional: scrape brand signals (colors / fonts / logo / name) for the
    // Brand Kit auto-extract flow. The page returns RAW computed color strings
    // (rgb(...)) + meta; Node normalises them (lib/brandColors) so the parsing
    // logic stays unit-testable without a browser.
    let brand: ScrapedBrandSignals | undefined;
    if (opts?.extractBrand) {
      brand = await scrapeBrandSignals(page).catch((err) => {
        logger.warn({ err, url: url.toString() }, "Brand signal scrape failed");
        return undefined;
      });
    }

    logger.info(
      { url: url.toString(), title, captureHeight },
      "Website captured",
    );
    return {
      url: url.toString(),
      title,
      themeColor,
      screenshotPath,
      mediaType,
      width: VIEWPORT.width,
      height: captureHeight,
      selectorCrop,
      sections,
      brand,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/** A handle to a Puppeteer page (kept loose to avoid importing puppeteer types). */
type EvaluablePage = {
  evaluate: <T>(fn: () => T) => Promise<T>;
};

/**
 * Scrape raw brand signals from the loaded page, then normalise them in Node.
 * In-page: collect meta, CSS custom properties, the dominant CTA/link/header
 * colors, an area-weighted background/text color frequency map, fonts, and logo
 * candidates — all as RAW strings. Node: parse → dedupe → weight-sort via
 * lib/brandColors, and resolve safe logo URLs.
 */
async function scrapeBrandSignals(
  page: EvaluablePage,
): Promise<ScrapedBrandSignals> {
  const raw = await page.evaluate(() => {
    const meta = (sel: string): string | null => {
      const el = document.querySelector(sel);
      const c = el?.getAttribute("content");
      return c && c.trim() ? c.trim() : null;
    };

    // Probe common design-system CSS custom properties for brand colors.
    const VAR_NAMES = [
      "--primary",
      "--color-primary",
      "--primary-color",
      "--brand",
      "--brand-primary",
      "--brand-color",
      "--color-brand",
      "--accent",
      "--color-accent",
      "--accent-color",
      "--secondary",
      "--color-secondary",
      "--theme-color",
      "--ds-color-primary",
      "--ion-color-primary",
      "--chakra-colors-brand-500",
    ];
    const rootStyle = getComputedStyle(document.documentElement);
    const cssVars: { name: string; value: string }[] = [];
    for (const name of VAR_NAMES) {
      const value = rootStyle.getPropertyValue(name).trim();
      if (value) cssVars.push({ name, value });
    }

    // Area-weighted color frequency. Walk a bounded set of visible elements,
    // tally background-color (strong signal) and text color (weak signal) by
    // on-screen area. Aggregate by the raw computed string (browser-normalised).
    const bgMap: Record<string, number> = {};
    const fgMap: Record<string, number> = {};
    const els = Array.from(document.querySelectorAll("body *"));
    const cap = Math.min(els.length, 4000);
    for (let i = 0; i < cap; i++) {
      const el = els[i];
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      const area = Math.min(r.width * r.height, 1920 * 1080);
      const cs = getComputedStyle(el);
      if (cs.backgroundImage && cs.backgroundImage !== "none") continue;
      const bg = cs.backgroundColor;
      if (bg) bgMap[bg] = (bgMap[bg] || 0) + area;
      const fg = cs.color;
      if (fg) fgMap[fg] = (fgMap[fg] || 0) + area * 0.2;
    }

    // The dominant CTA: the largest button-ish element in the first screen with
    // a real background color.
    const buttons = Array.from(
      document.querySelectorAll(
        'button, a[class*="btn"], a[class*="button"], [role="button"], [class*="cta"]',
      ),
    );
    let cta: string | null = null;
    let ctaArea = 0;
    for (const b of buttons) {
      const r = b.getBoundingClientRect();
      if (r.top > 1400 || r.width < 40 || r.height < 20) continue;
      const a = r.width * r.height;
      if (a > ctaArea) {
        ctaArea = a;
        cta = getComputedStyle(b).backgroundColor;
      }
    }

    const firstLink = document.querySelector("a[href]");
    const link = firstLink ? getComputedStyle(firstLink).color : null;
    const headerEl = document.querySelector(
      'header, nav, [class*="header"], [class*="navbar"]',
    );
    const header = headerEl ? getComputedStyle(headerEl).backgroundColor : null;
    const h1 = document.querySelector("h1");
    const heading = h1 ? getComputedStyle(h1).color : null;
    const bodyBg = getComputedStyle(document.body).backgroundColor;

    const fontOf = (sel: string): string | null => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).fontFamily : null;
    };
    const fontFamilies = [
      fontOf("h1"),
      fontOf("h2"),
      getComputedStyle(document.body).fontFamily,
    ].filter((f): f is string => !!f);

    const abs = (u: string | null): string | null => {
      if (!u) return null;
      try {
        return new URL(u, location.href).href;
      } catch {
        return null;
      }
    };
    const logoCandidates: string[] = [];
    document.querySelectorAll("img").forEach((img) => {
      const hay = (
        (img.getAttribute("alt") || "") +
        " " +
        (img.className || "") +
        " " +
        (img.id || "") +
        " " +
        (img.getAttribute("src") || "")
      ).toLowerCase();
      if (/logo|brand/.test(hay)) {
        const u = abs(img.currentSrc || img.src);
        if (u) logoCandidates.push(u);
      }
    });
    const headerImg = document.querySelector(
      "header img, nav img, [class*='header'] img, [class*='navbar'] img",
    ) as HTMLImageElement | null;
    if (headerImg) {
      const u = abs(headerImg.currentSrc || headerImg.src);
      if (u) logoCandidates.push(u);
    }
    const og = abs(meta('meta[property="og:image"]'));
    if (og) logoCandidates.push(og);
    const iconEl = document.querySelector(
      'link[rel="apple-touch-icon"], link[rel~="icon"]',
    );
    const icon = abs(iconEl?.getAttribute("href") ?? null);
    if (icon) logoCandidates.push(icon);

    // Visible copy for the narrative DNA: headings + lead paragraphs, in document
    // order, deduped + bounded. Skip tiny/empty nodes; cap so the AI prompt stays
    // cheap (the provider further truncates).
    const textParts: string[] = [];
    const seenText = new Set<string>();
    const textNodes = Array.from(
      document.querySelectorAll("h1, h2, h3, p, li, blockquote"),
    ).slice(0, 400);
    for (const el of textNodes) {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t.length < 12 || t.length > 400 || seenText.has(t)) continue;
      seenText.add(t);
      textParts.push(t);
      if (textParts.join(" ").length > 4000) break;
    }

    return {
      siteName:
        meta('meta[property="og:site_name"]') ||
        meta('meta[name="application-name"]'),
      description:
        meta('meta[name="description"]') ||
        meta('meta[property="og:description"]'),
      cssVars,
      backgrounds: Object.entries(bgMap),
      texts: Object.entries(fgMap),
      cta,
      link,
      header,
      heading,
      bodyBg,
      fontFamilies,
      logoCandidates,
      textSample: textParts.join("\n"),
    };
  });

  // ── Normalise in Node (testable; the browser only emits raw strings) ──
  const candidates: { hex: string; source: string; weight?: number }[] = [];
  for (const v of raw.cssVars)
    candidates.push({ hex: v.value, source: `var(${v.name})`, weight: 0.6 });
  if (raw.cta) candidates.push({ hex: raw.cta, source: "cta", weight: 0.5 });
  if (raw.link) candidates.push({ hex: raw.link, source: "link", weight: 0.4 });
  if (raw.header)
    candidates.push({ hex: raw.header, source: "header", weight: 0.35 });
  if (raw.heading)
    candidates.push({ hex: raw.heading, source: "heading", weight: 0.25 });
  if (raw.bodyBg)
    candidates.push({ hex: raw.bodyBg, source: "background", weight: 0.2 });

  const maxBg = Math.max(1, ...raw.backgrounds.map(([, a]) => a));
  for (const [color, area] of raw.backgrounds)
    candidates.push({ hex: color, source: "background", weight: 0.5 * (area / maxBg) });
  const maxFg = Math.max(1, ...raw.texts.map(([, a]) => a));
  for (const [color, area] of raw.texts)
    candidates.push({ hex: color, source: "text", weight: 0.2 * (area / maxFg) });

  const colors = mergeCandidates(candidates).slice(0, 28);

  const fontFamilies = [
    ...new Set(
      raw.fontFamilies.map((f) => f.split(",")[0]?.replace(/["']/g, "").trim()),
    ),
  ].filter((f): f is string => !!f);

  // Only logos that are clean, http(s), attribute-safe URLs (they end up in an
  // <img src="…"> at render time via the brand kit).
  const logoCandidates = [...new Set(raw.logoCandidates)].filter((u) =>
    isSafeLogoUrl(u),
  );

  return {
    siteName: raw.siteName,
    description: raw.description,
    colors,
    fontFamilies,
    logoCandidates,
    textSample: raw.textSample,
  };
}

export { SsrfError };
