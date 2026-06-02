import { beforeEach, describe, expect, it } from "vitest";
import { isNull } from "drizzle-orm";
import { db, templatesTable } from "@workspace/db";
import { seedPlatformTemplates } from "./platformTemplatesService";
import { REGISTRY_TEMPLATES } from "./registryTemplates";
import { truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

describe.runIf(INTEGRATION_AVAILABLE)("seedPlatformTemplates", () => {
  beforeEach(truncateAll);

  it("seeds every registry template as a platform row, then is idempotent", async () => {
    const first = await seedPlatformTemplates();
    expect(first).toBe(REGISTRY_TEMPLATES.length);

    const rows = await db
      .select()
      .from(templatesTable)
      .where(isNull(templatesTable.userId));
    expect(rows).toHaveLength(REGISTRY_TEMPLATES.length);
    // Every registry slug is present, as a platform (userId === null) row.
    const modules = new Set(rows.map((r) => r.module));
    for (const t of REGISTRY_TEMPLATES) {
      expect(modules.has(t.slug)).toBe(true);
    }
    expect(rows.every((r) => r.userId === null)).toBe(true);

    // Insert-if-missing keyed by module → a second run inserts nothing and the
    // row count is unchanged (no duplicates).
    const second = await seedPlatformTemplates();
    expect(second).toBe(0);
    const after = await db
      .select()
      .from(templatesTable)
      .where(isNull(templatesTable.userId));
    expect(after).toHaveLength(REGISTRY_TEMPLATES.length);
  });

  it("preserves an existing row's metadata (insert-if-missing never clobbers)", async () => {
    await db.insert(templatesTable).values({
      userId: null,
      name: "Custom Name",
      category: "Custom",
      module: REGISTRY_TEMPLATES[0].slug,
      thumbnailUrl: "https://example.test/x.png",
      duration: 99,
      isPremium: true,
      tags: [],
    });

    const inserted = await seedPlatformTemplates();
    // All registry templates EXCEPT the pre-existing slug are inserted.
    expect(inserted).toBe(REGISTRY_TEMPLATES.length - 1);

    const [preexisting] = await db
      .select()
      .from(templatesTable)
      .where(isNull(templatesTable.userId));
    // The hand-inserted row is untouched (still "Custom Name", duration 99).
    const custom = (
      await db.select().from(templatesTable).where(isNull(templatesTable.userId))
    ).find((r) => r.module === REGISTRY_TEMPLATES[0].slug);
    expect(custom?.name).toBe("Custom Name");
    expect(custom?.duration).toBe(99);
    expect(preexisting).toBeDefined();
  });
});
