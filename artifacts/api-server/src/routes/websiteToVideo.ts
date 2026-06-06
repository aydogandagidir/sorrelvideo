import { Router, type IRouter, type Response } from "express";
import type { Logger } from "pino";
import {
  WebsiteToVideoBody,
  WebsiteToVideoPreviewBody,
  GetProjectResponse,
} from "@workspace/api-zod";
import { websiteCaptureLimiter } from "../middlewares/rateLimit";
import {
  createWebsiteVideoProject,
  captureWebsitePreview,
} from "../services/websiteToVideoService";
import { SsrfError } from "../lib/ssrfGuard";
import { WebsiteCaptureError } from "../services/websiteCaptureService";
import { normalizeWebsiteUrl } from "../lib/websiteUrl";

const router: IRouter = Router();

function serializeDates<T>(data: T): T {
  return JSON.parse(JSON.stringify(data));
}

// Unsafe/invalid URL → 400 (caller's fault); site unreachable → 502; else 500.
function handleCaptureError(err: unknown, res: Response, log: Logger): void {
  if (err instanceof SsrfError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof WebsiteCaptureError) {
    res.status(502).json({ error: err.message });
    return;
  }
  log.error({ err }, "website-to-video failed");
  res.status(500).json({ error: "Could not create the video" });
}

// POST /api/website-to-video/preview — step 1 of the crop flow: capture the page
// (SSRF-guarded) and return the screenshot + a previewId, WITHOUT creating a
// project. The SPA shows the shot, the user drag-selects a region, then POSTs it
// back to /website-to-video. Rate-limited (each call launches headless Chrome).
router.post(
  "/website-to-video/preview",
  websiteCaptureLimiter,
  async (req, res): Promise<void> => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const parsed = WebsiteToVideoPreviewBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const preview = await captureWebsitePreview(
        req.user.id,
        normalizeWebsiteUrl(parsed.data.url),
      );
      res.status(201).json(preview);
    } catch (err) {
      handleCaptureError(err, res, req.log);
    }
  },
);

// POST /api/website-to-video — create a branded `website-showcase` project from a
// fresh URL capture OR a previewId (the crop flow) plus an optional crop region /
// duration. Returned so the SPA can navigate straight to it and render.
router.post(
  "/website-to-video",
  websiteCaptureLimiter,
  async (req, res): Promise<void> => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const parsed = WebsiteToVideoBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const { url, previewId, crop, selector, section, duration } = parsed.data;
    if (!url && !previewId) {
      res.status(400).json({ error: "A url or previewId is required." });
      return;
    }

    try {
      const project = await createWebsiteVideoProject(req.user.id, {
        // `previewId` reuses the server-stored capture; a bare-host `url` gets
        // https:// prepended (assertSafeUrl inside captureWebsite still validates,
        // so SSRF protection is intact).
        url: url ? normalizeWebsiteUrl(url) : undefined,
        previewId: previewId ?? undefined,
        crop: crop ?? undefined,
        selector: selector ?? undefined,
        section: section ?? undefined,
        duration: duration ?? undefined,
      });
      res.status(201).json(GetProjectResponse.parse(serializeDates(project)));
    } catch (err) {
      handleCaptureError(err, res, req.log);
    }
  },
);

export default router;
