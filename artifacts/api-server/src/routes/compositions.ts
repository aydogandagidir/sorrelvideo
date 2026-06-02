import { Router, type IRouter, type Request, type Response } from "express";
import { LintCompositionBody } from "@workspace/api-zod";
import { lintComposition } from "../services/compositionCompilerService";

const router: IRouter = Router();

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
  (req: Request, res: Response): void => {
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

    res.json({ messages: lintComposition(parsed.data.source) });
  },
);

export default router;
