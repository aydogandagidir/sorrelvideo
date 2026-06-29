import { Router, type IRouter, type Request, type Response } from "express";
import { LintCompositionBody } from "@workspace/api-zod";
import { DEFAULT_RENDER_SETTINGS, type RenderResolution } from "@workspace/db";
import { lintComposition } from "../services/compositionCompilerService";
import {
  buildCompositionHtml,
  isKnownModule,
} from "../services/renderService";
import { findUnsafeCompositionVar } from "../lib/compositionVars";

const router: IRouter = Router();

const PREVIEW_RESOLUTIONS: ReadonlySet<RenderResolution> = new Set<
  RenderResolution
>(["landscape", "portrait", "square"]);

/**
 * POST /api/compositions/lint
 *
 * Lints composition HTML and returns the findings as a `LintMessage[]`. This is
 * a NON-BLOCKING reporting tool for the Studio editor / debugging — it is
 * deliberately NOT wired into the render route as a gate. Sorrel's real
 * compositions drive the engine via `window.__hf` (not Studio's
 * `window.__timelines`), so they don't lint clean; rejecting renders on lint
 * errors would reject every current render.
 *
 * Auth-gated so it isn't an open linting oracle. The body is validated by the
 * generated `LintCompositionBody` zod schema (400 on failure).
 */
router.post(
  "/compositions/lint",
  async (req: Request, res: Response): Promise<void> => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const parsed = LintCompositionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues[0]?.message ?? "Invalid request",
      });
      return;
    }

    res.json({ messages: await lintComposition(parsed.data.source) });
  },
);

/**
 * GET /api/compositions/:module/preview
 *
 * A real, brand-substituted preview of a composition MODULE (not a saved
 * project) — for the Studio create page, which has no project id until submit.
 * Renders the user's default brand kit + STUDIO_FALLBACKS through the same
 * `buildCompositionHtml` merge the render path uses, so the `<hyperframes-player>`
 * iframe shows the true composition. SPEC-EXEMPT (browser iframe src, like the
 * project `/composition` route + the thumbnails route).
 *
 * - auth-gated.
 * - `:module` must be a KNOWN composition (isKnownModule) → else 404 (the
 *   default-fallback would otherwise silently serve `studio-default`).
 * - optional `?vars=<base64 JSON object>` overrides, run through the SAME
 *   injection gate as the project route — this route is module-keyed (not
 *   ownership-bound), so an un-gated override would be reflected XSS.
 * - optional `?resolution=landscape|portrait|square` lays out the aspect.
 */
router.get(
  "/compositions/:module/preview",
  async (req: Request, res: Response): Promise<void> => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const module = Array.isArray(req.params.module)
      ? req.params.module[0]
      : req.params.module;
    if (!isKnownModule(module)) {
      res.status(404).json({ error: "Unknown composition module" });
      return;
    }

    let overrides: Record<string, string> | null = null;
    const rawVars = req.query.vars;
    if (typeof rawVars === "string" && rawVars.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(rawVars, "base64").toString("utf-8"));
      } catch {
        res.status(400).json({ error: "Invalid vars: not base64-encoded JSON" });
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        res.status(400).json({ error: "Invalid vars: expected a JSON object" });
        return;
      }
      const unsafe = findUnsafeCompositionVar(parsed as Record<string, string>);
      if (unsafe) {
        res.status(400).json({ error: unsafe.reason });
        return;
      }
      overrides = parsed as Record<string, string>;
    }

    const rawRes = req.query.resolution;
    const resolution =
      typeof rawRes === "string" && PREVIEW_RESOLUTIONS.has(rawRes as RenderResolution)
        ? (rawRes as RenderResolution)
        : DEFAULT_RENDER_SETTINGS.resolution;

    const html = await buildCompositionHtml(
      {
        id: 0,
        userId: req.user.id,
        module,
        compositionVars: overrides,
        brandKitId: null, // → the user's default kit (loadBrandKit), like the render
        renderSettings: { ...DEFAULT_RENDER_SETTINGS, resolution },
      },
      // Preview: strip the legacy __hf/__player host so the <hyperframes-player>
      // resolves the timeline (it skips the __timelines adapter otherwise).
      { preview: true },
    );

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  },
);

export default router;
