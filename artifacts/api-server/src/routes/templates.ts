import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { Router, type IRouter } from "express";
import { eq, and, or, isNull } from "drizzle-orm";
import {
  db,
  templatesTable,
  usersTable,
  projectsTable,
  DEFAULT_RENDER_SETTINGS,
} from "@workspace/db";
import {
  ListTemplatesQueryParams,
  ListTemplatesResponse,
  CreateTemplateBody,
  GetTemplateParams,
  GetTemplateResponse,
  GetProjectResponse,
} from "@workspace/api-zod";
import { getUserPlan } from "../services/billingService";
import {
  resolveEntryFile,
  renderCompositionTemplate,
} from "../services/renderService";
import {
  resolutionForModule,
  REGISTRY_TEMPLATES,
} from "../services/registryTemplates";

const router: IRouter = Router();

/**
 * Slugs that ship a self-hosted poster PNG under compositions/thumbnails/. Built
 * from the vendored registry manifest so the thumbnails route only ever serves a
 * known template's poster (an allow-list — never an arbitrary `:slug` off disk).
 */
const THUMBNAIL_SLUGS = new Set(REGISTRY_TEMPLATES.map((t) => t.slug));

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

// GET /api/templates/thumbnails/:slug — serve a platform template's self-hosted
// gallery poster (PNG). These are first-frame stills rendered FROM each vendored
// composition (scripts/generate-thumbnails.mjs → compositions/thumbnails/<slug>.png)
// and committed, replacing the dependency on HeyGen's static.heygen.ai CDN. The
// manifest's `thumbnailUrl` points here; seedPlatformTemplates persists it.
//
// PUBLIC (intentional, NOT auth-gated): the gallery renders this as a plain
// `<img src>` and a brand-neutral sample poster is the same "look before you
// buy" affordance as the static CDN thumbnail it replaces — exactly like the
// already-public hover-preview. Serving it starts no render and consumes no
// quota.
//
// SPEC-EXEMPT: loaded directly by the browser as an <img> source, not through
// the OpenAPI-generated React Query hooks — like the /composition preview + the
// project video/thumbnail stream routes. Deliberately absent from openapi.yaml.
//
// MUST be registered before `GET /templates/:id` so "thumbnails" isn't parsed as
// an :id. The :slug is matched against the vendored manifest (an allow-list), so
// a crafted value can't traverse out of the thumbnails dir.
router.get("/templates/thumbnails/:slug", (req, res): void => {
  const raw = Array.isArray(req.params.slug)
    ? req.params.slug[0]
    : req.params.slug;
  // Tolerate the ".png" suffix the manifest URL carries (…/<slug>.png).
  const slug = raw.replace(/\.png$/i, "");
  if (!THUMBNAIL_SLUGS.has(slug)) {
    res.status(404).json({ error: "Thumbnail not found" });
    return;
  }

  const thumbPath = path.join(COMPOSITIONS_DIR, "thumbnails", `${slug}.png`);
  if (!fs.existsSync(thumbPath)) {
    res.status(404).json({ error: "Thumbnail not available" });
    return;
  }

  // Committed, content-addressed by slug and brand-neutral → safe to cache hard.
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.setHeader("Content-Type", "image/png");
  // Stream manually rather than res.sendFile — Express 5's send() rejects
  // absolute paths containing spaces (the repo can live under ".../Artificial
  // Inteligence/..."), same constraint as the project video/thumbnail routes.
  fs.createReadStream(thumbPath).pipe(res);
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

// POST /api/templates/:id/use — create a project FROM a template, at the
// template's NATIVE aspect ratio. Registry templates author a fixed canvas
// (mostly 1920×1080); without matching the project's resolution to it the render
// would force the portrait default and distort the composition. Premium
// templates require a Pro plan (same gate as GET /templates/:id). The created
// project is returned so the SPA can navigate straight to it.
router.post("/templates/:id/use", async (req, res): Promise<void> => {
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
  // A template owned by a different user must not leak — treat it as missing.
  if (template.userId !== null && template.userId !== req.user.id) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  // Premium templates require a Pro plan (mirrors GET /templates/:id).
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

  // Match the project to the template's native aspect ratio. null for the
  // responsive hand-authored templates → keep the portrait-first default.
  const resolution = resolutionForModule(template.module);
  const renderSettings = resolution
    ? { ...DEFAULT_RENDER_SETTINGS, resolution }
    : null;

  const [project] = await db
    .insert(projectsTable)
    .values({
      userId: req.user.id,
      name: template.name,
      module: template.module,
      templateId: template.id,
      renderSettings,
    })
    .returning();

  res.status(201).json(GetProjectResponse.parse(serializeDates(project)));
});

export default router;
