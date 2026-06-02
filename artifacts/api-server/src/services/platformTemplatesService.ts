import { and, inArray, isNull } from "drizzle-orm";
import { db, templatesTable } from "@workspace/db";
import { REGISTRY_TEMPLATES } from "./registryTemplates";

/**
 * Idempotently seed the vendored Hyperframes registry templates as PLATFORM
 * templates (userId = null → visible to every authenticated user). Insert-if-
 * missing, keyed by `module` (the registry slug), so existing rows and re-runs
 * are left untouched and metadata edits to a live row are never clobbered.
 *
 * Runs on boot (see index.ts) rather than as a manual script: the gallery is the
 * storefront, and a fresh environment with an empty gallery is the same as
 * having no product. A forgotten manual seed step is exactly the failure we want
 * to make impossible — so this is wired into startup like applyBillingMigration.
 *
 * Returns the number of templates inserted (0 when already seeded).
 */
export async function seedPlatformTemplates(): Promise<number> {
  if (REGISTRY_TEMPLATES.length === 0) return 0;

  const slugs = REGISTRY_TEMPLATES.map((t) => t.slug);
  const existing = await db
    .select({ module: templatesTable.module })
    .from(templatesTable)
    .where(
      and(isNull(templatesTable.userId), inArray(templatesTable.module, slugs)),
    );
  const present = new Set(existing.map((r) => r.module));

  const missing = REGISTRY_TEMPLATES.filter((t) => !present.has(t.slug));
  if (missing.length === 0) return 0;

  await db.insert(templatesTable).values(
    missing.map((t) => ({
      userId: null,
      name: t.name,
      description: t.description || null,
      category: t.category,
      module: t.slug,
      thumbnailUrl: t.thumbnailUrl,
      duration: t.duration,
      isPremium: t.isPremium,
      tags: t.tags,
    })),
  );

  return missing.length;
}
