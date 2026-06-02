import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { Router, type IRouter } from "express";
import { eq, and, or, isNull } from "drizzle-orm";
import { db, templatesTable, usersTable } from "@workspace/db";
import {
  ListTemplatesQueryParams,
  ListTemplatesResponse,
  CreateTemplateBody,
  GetTemplateParams,
  GetTemplateResponse,
} from "@workspace/api-zod";
import { getUserPlan } from "../services/billingService";
import {
  resolveEntryFile,
  renderCompositionTemplate,
} from "../services/renderService";

const router: IRouter = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function serializeDates<T>(data: T): T {
  return JSON.parse(JSON.stringify(data));
}

/** Pick the first path that exists (mirrors renderService's env probe). */
function firstExistingDir(candidates: string[], fallback: string): string {
  return candidates.find((p) => p && fs.existsSync(p)) ?? fallback;
}

/**
 * Directory holding the composition HTML files. This intentionally duplicates
 * `renderService`'s private `COMPOSITIONS_DIR` probe (same candidate list):
 * that constant is not exported, and `renderService.ts` is owned by another
 * milestone wave (M10 part 1) so it can't be edited here to export it. The probe
 * keeps dev (`src/compositions`), the bundle (`dist/`), and the Docker image
 * (`/app/compositions`) all resolving without per-env config.
 */
const COMPOSITIONS_DIR = firstExistingDir(
  [
    path.resolve(__dirname, "compositions"), // bundled next to dist (if copied)
    path.resolve(__dirname, "../compositions"), // prod Docker: /app/compositions
    path.resolve(__dirname, "../src/compositions"), // dev: dist/../src/compositions
    path.resolve(__dirname, "../../src/compositions"), // source layout
  ],
  path.resolve(__dirname, "../compositions"),
);

/**
 * Default placeholder values for a no-context preview. Mirrors
 * `renderService`'s private `STUDIO_FALLBACKS` (not exported — see
 * COMPOSITIONS_DIR note). The template-composition endpoint serves the BASE
 * composition with NO user brand kit and NO project vars, so we feed exactly
 * these so a preview always renders sensible copy/colors instead of raw
 * `{{placeholder}}` tokens. Keep in sync with renderService if those defaults
 * change.
 */
const PREVIEW_FALLBACKS: Record<string, string> = {
  "brand.companyName": "Your Brand",
  "brand.initial": "S",
  "brand.primaryColor": "#6366f1",
  "brand.secondaryColor": "#1e293b",
  "brand.accentColor": "#f59e0b",
  "brand.fontFamily": "'Inter'",
  "brand.logoUrl": "",
  "user.headline": "Make something\nthey'll remember.",
  "user.bodyText":
    "Sorrel turns a template, your brand kit, and a few sentences into branded video — ready to ship.",
  "user.ctaText": "Try it free",
};

// Authenticated users can see platform templates (userId IS NULL) + their own
function userTemplatesFilter(userId: string) {
  return or(isNull(templatesTable.userId), eq(templatesTable.userId, userId));
}

router.get("/templates", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const parsed = ListTemplatesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const conditions = [userTemplatesFilter(req.user.id)];
  if (parsed.data.category) {
    conditions.push(eq(templatesTable.category, parsed.data.category));
  }
  if (parsed.data.module) {
    conditions.push(eq(templatesTable.module, parsed.data.module));
  }

  const templates = await db
    .select()
    .from(templatesTable)
    .where(and(...conditions))
    .orderBy(templatesTable.id);

  res.json(ListTemplatesResponse.parse(serializeDates(templates)));
});

router.post("/templates", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const parsed = CreateTemplateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [template] = await db
    .insert(templatesTable)
    .values({ ...parsed.data, userId: req.user.id })
    .returning();
  res.status(201).json(GetTemplateResponse.parse(serializeDates(template)));
});

router.get("/templates/:id", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetTemplateParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [template] = await db
    .select()
    .from(templatesTable)
    .where(eq(templatesTable.id, params.data.id));

  if (!template) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  // Deny access to templates owned by a different user
  if (template.userId !== null && template.userId !== req.user.id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // Deny access to premium templates for Free-plan users
  if (template.isPremium) {
    const stripeCustomerId =
      (
        await db
          .select({ stripeCustomerId: usersTable.stripeCustomerId })
          .from(usersTable)
          .where(eq(usersTable.id, req.user.id))
          .limit(1)
      )[0]?.stripeCustomerId ?? null;
    const plan = await getUserPlan(stripeCustomerId);
    if (plan === "free") {
      res.status(403).json({ error: "Forbidden", reason: "upgrade_required" });
      return;
    }
  }

  res.json(GetTemplateResponse.parse(serializeDates(template)));
});

// GET /api/templates/:id/composition — serve a template's BASE composition HTML
// so the templates-gallery player can render a live hover-preview WITHOUT a
// render (and without creating a project). Auth-gated (must be signed in), then
// 404 if the template row is absent or owned by another user. Platform templates
// (userId IS NULL) are visible to any authenticated user, so there is no
// per-user ownership requirement for them — only the same own-or-platform
// visibility the list/detail routes enforce.
//
// The preview uses NO user brand kit and NO project compositionVars: we read the
// template's module → composition file via `resolveEntryFile`, then run
// `renderCompositionTemplate(source, PREVIEW_FALLBACKS)` so every placeholder
// resolves to a sensible default rather than leaking raw `{{token}}`s. (We do
// NOT call `buildCompositionHtml` here precisely because it would load the
// signed-in user's brand kit — this endpoint is the brand-neutral base preview.)
//
// SPEC-EXEMPT (intentional): this route is loaded by the browser as the player's
// `src` (an <iframe>-style HTML document), NOT through Sorrel's OpenAPI-generated
// React Query hooks — exactly like the project `/composition` + studio preview
// routes. It is deliberately absent from `openapi.yaml`; adding it would only
// generate a dead client hook.
//
// Premium templates are NOT gated here: a hover-preview of a frame is the same
// "look before you buy" affordance as the static thumbnail, and the gallery
// still gates the "Use Template" action + render time for Free users. Serving a
// preview never starts a render or consumes quota.
router.get("/templates/:id/composition", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetTemplateParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [template] = await db
    .select()
    .from(templatesTable)
    .where(eq(templatesTable.id, params.data.id));

  if (!template) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  // A template owned by a different user must not leak — treat it as missing
  // (404, not 403) so its existence isn't disclosed. Platform rows
  // (userId === null) are previewable by any authenticated user.
  if (template.userId !== null && template.userId !== req.user.id) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  // Map the template's module → its composition file (falls back to the default
  // composition for an unknown module, same as the render pipeline). A missing
  // file on disk is a 404 rather than a 500.
  const entryFile = resolveEntryFile(template.module);
  const filePath = path.join(COMPOSITIONS_DIR, entryFile);
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    req.log.warn(
      { templateId: template.id, module: template.module, entryFile, err },
      "Template composition file missing",
    );
    res.status(404).json({ error: "Template preview not available" });
    return;
  }

  const html = renderCompositionTemplate(source, PREVIEW_FALLBACKS);

  // Preview is brand-neutral and identical per template, but we still send
  // `no-store` to match the project `/composition` + studio preview routes (and
  // to stay correct if the underlying composition file changes between deploys).
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // A string body is safe to res.send — the Express-5 spaces-in-path issue only
  // affects res.sendFile, which we deliberately avoid here.
  res.send(html);
});

export default router;
