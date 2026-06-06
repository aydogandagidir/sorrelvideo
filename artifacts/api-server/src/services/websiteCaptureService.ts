import path from "node:path";
import fs from "node:fs";
import puppeteer from "puppeteer";
import { assertSafeUrl, SsrfError } from "../lib/ssrfGuard";
import { logger } from "../lib/logger";
import { bboxToCrop, type CropRegion } from "../lib/websiteCrop";

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

export interface WebsiteCapture {
  url: string;
  title: string;
  themeColor: string | null;
  screenshotPath: string;
  width: number;
  height: number;
  /** Set when `opts.selector` matched an element — the region to feature. */
  selectorCrop?: CropRegion;
  /** Set when `opts.extractSections` — candidate sections for AI matching. */
  sections?: PageSection[];
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
  opts?: { maxHeight?: number; selector?: string; extractSections?: boolean },
): Promise<WebsiteCapture> {
  // SSRF guard first — throws SsrfError before any network/browser work.
  const url = await assertSafeUrl(rawUrl);

  fs.mkdirSync(outDir, { recursive: true });
  const screenshotPath = path.join(outDir, "capture.png");

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

    const buf = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: captureHeight },
    });
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

    logger.info(
      { url: url.toString(), title, captureHeight },
      "Website captured",
    );
    return {
      url: url.toString(),
      title,
      themeColor,
      screenshotPath,
      width: VIEWPORT.width,
      height: captureHeight,
      selectorCrop,
      sections,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export { SsrfError };
