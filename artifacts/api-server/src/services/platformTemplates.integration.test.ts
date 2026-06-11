import { beforeEach, describe, expect, it } from "vitest";
import { isNull } from "drizzle-orm";
import { db, templatesTable } from "@workspace/db";
import {
  HAND_AUTHORED_TEMPLATES,
  seedPlatformTemplates,
} from "./platformTemplatesService";
import { REGISTRY_TEMPLATES } from "./registryTemplates";
import { truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

// The full platform seed = the vendored registry blocks PLUS the hand-authored
// showcase templates. Derived from the service's own lists so adding a template
// never silently breaks these counts again (they drifted once before, when the
// Track B hand-authored set landed without updating the registry-only counts).
const SEED_TOTAL = REGISTRY_TEMPLATES.length + HAND_AUTHORED_TEMPLATES.length;

describe.runIf(INTEGRATION_AVAILABLE)("seedPlatformTemplates", () => {
  beforeEach(truncateAll);

  it("seeds every platform template as a platform row, then is idempotent", async () => {
    const first = await seedPlatformTemplates();
    expect(first).toBe(SEED_TOTAL);

    const rows = await db
      .select()
      .from(templatesTable)
      .where(isNull(templatesTable.userId));
    expect(rows).toHaveLength(SEED_TOTAL);
    // Every registry + hand-authored slug is present as a platform row.
    const modules = new Set(rows.map((r) => r.module));
    for (const t of REGISTRY_TEMPLATES) {
      expect(modules.has(t.slug)).toBe(true);
    }
    for (const t of HAND_AUTHORED_TEMPLATES) {
      expect(modules.has(t.module)).toBe(true);
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
    expect(after).toHaveLength(SEED_TOTAL);
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
    // Every platform template EXCEPT the pre-existing slug is inserted.
    expect(inserted).toBe(SEED_TOTAL - 1);

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
