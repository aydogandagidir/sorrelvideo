import { Router, type IRouter } from "express";
import { WebsiteToVideoBody, GetProjectResponse } from "@workspace/api-zod";
import { websiteCaptureLimiter } from "../middlewares/rateLimit";
import { createWebsiteVideoProject } from "../services/websiteToVideoService";
import { SsrfError } from "../lib/ssrfGuard";
import { WebsiteCaptureError } from "../services/websiteCaptureService";
import { normalizeWebsiteUrl } from "../lib/websiteUrl";

const router: IRouter = Router();

function serializeDates<T>(data: T): T {
  return JSON.parse(JSON.stringify(data));
}

// POST /api/website-to-video — screenshot a user-supplied URL (SSRF-guarded in
// websiteCaptureService) and create a branded `website-showcase` project from it,
// returned so the SPA can navigate straight to it and render. Rate-limited
// because each call launches headless Chrome.
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

    try {
      // Users routinely paste a bare host ("bluedev.dev"); default the scheme to
      // https:// so it isn't rejected as "Invalid URL". assertSafeUrl (inside
      // captureWebsite) still validates the result, so SSRF protection is intact.
      const project = await createWebsiteVideoProject(
        req.user.id,
        normalizeWebsiteUrl(parsed.data.url),
      );
      res.status(201).json(GetProjectResponse.parse(serializeDates(project)));
    } catch (err) {
      // Unsafe/invalid URL → 400 (caller's fault); site unreachable → 502.
      if (err instanceof SsrfError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof WebsiteCaptureError) {
        res.status(502).json({ error: err.message });
        return;
      }
      req.log.error({ err }, "website-to-video failed");
      res.status(500).json({ error: "Could not create the video" });
    }
  },
);

export default router;
