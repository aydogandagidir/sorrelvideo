import { inArray } from "drizzle-orm";
import { db, modulesTable } from "@workspace/db";

type ModuleSeed = typeof modulesTable.$inferInsert;

/**
 * The platform-module catalog shown on /modules. Seeded idempotently on boot
 * (insert-if-missing by `slug`) so a fresh environment's grid reflects reality
 * instead of rendering permanently empty — the same storefront reasoning as
 * `seedPlatformTemplates`. `icon` is a lucide-react component NAME the SPA maps
 * to a glyph (see pages/modules.tsx); `status` is the honest availability
 * (`active` | `beta` | `coming_soon`).
 */
export const MODULE_CATALOG: ModuleSeed[] = [
  {
    slug: "studio",
    name: "Studio",
    description:
      "Compose branded videos from templates with a live preview and AI-written copy.",
    icon: "Wand2",
    status: "active",
    features: [
      "Live composition preview",
      "AI copy fill",
      "Typed template parameters",
    ],
  },
  {
    slug: "website-to-video",
    name: "Website → Video",
    description:
      "Paste any URL and turn the page into a branded showcase video automatically.",
    icon: "Globe",
    status: "active",
    features: ["Full-page capture", "Auto brand detection", "Adaptive length"],
  },
  {
    slug: "live-avatar",
    name: "Live Avatar",
    description:
      "A real-time conversational AI host, plus script → talking-host videos with captions.",
    icon: "Bot",
    status: "active",
    features: [
      "Browser voice in & out",
      "Brand-voiced replies",
      "Script → narrated MP4",
    ],
  },
  {
    slug: "analytics",
    name: "Analytics",
    description:
      "Render performance, output mix, and plan usage across your whole account.",
    icon: "BarChart3",
    status: "beta",
    features: [
      "Render success rate",
      "Output-format breakdown",
      "Quota usage",
    ],
  },
  {
    slug: "brand-dna",
    name: "Brand DNA",
    description:
      "An AI-extracted, editable brand profile that keeps every video on-brand.",
    icon: "Palette",
    status: "active",
    features: [
      "URL brand extraction",
      "Multiple brand kits",
      "Video idea generation",
    ],
  },
  {
    slug: "bulk",
    name: "Bulk Render",
    description:
      "Render many videos at once from a CSV/JSON of per-video variations.",
    icon: "Layers",
    status: "coming_soon",
    features: ["CSV / JSON import", "Batch render queue", "Per-row variables"],
  },
  {
    slug: "collab",
    name: "Collaboration",
    description:
      "Share projects with teammates and manage who can view or edit each video.",
    icon: "Users",
    status: "coming_soon",
    features: ["Project sharing", "Member roles", "Workspace access control"],
  },
];

/**
 * Idempotently seed the module catalog. Insert-if-missing keyed by `slug`, so
 * re-runs and live edits to an existing row are never clobbered. Returns the
 * number of rows inserted (0 when already seeded).
 */
export async function seedModules(): Promise<number> {
  if (MODULE_CATALOG.length === 0) return 0;

  const slugs = MODULE_CATALOG.map((m) => m.slug);
  const existing = await db
    .select({ slug: modulesTable.slug })
    .from(modulesTable)
    .where(inArray(modulesTable.slug, slugs));
  const present = new Set(existing.map((r) => r.slug));

  const missing = MODULE_CATALOG.filter((m) => !present.has(m.slug));
  if (missing.length === 0) return 0;

  await db.insert(modulesTable).values(missing);
  return missing.length;
}
