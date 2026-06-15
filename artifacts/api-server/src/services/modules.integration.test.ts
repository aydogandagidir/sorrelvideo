import { beforeEach, describe, expect, it } from "vitest";
import { db, modulesTable } from "@workspace/db";
import { seedModules, MODULE_CATALOG } from "./modulesService";
import { truncateAll } from "../test/integration";
import { INTEGRATION_AVAILABLE } from "../test/setup";

const SEED_COUNT = MODULE_CATALOG.length;

describe.runIf(INTEGRATION_AVAILABLE)("seedModules", () => {
  beforeEach(truncateAll);

  it("seeds the whole module catalog, then is idempotent", async () => {
    const first = await seedModules();
    expect(first).toBe(SEED_COUNT);

    const rows = await db.select().from(modulesTable);
    expect(rows).toHaveLength(SEED_COUNT);
    const slugs = new Set(rows.map((r) => r.slug));
    for (const m of MODULE_CATALOG) {
      expect(slugs.has(m.slug)).toBe(true);
    }

    // Insert-if-missing keyed by slug → a re-run inserts nothing (no duplicates).
    const second = await seedModules();
    expect(second).toBe(0);
    expect(await db.select().from(modulesTable)).toHaveLength(SEED_COUNT);
  });

  it("preserves an existing row's metadata (insert-if-missing never clobbers)", async () => {
    await db.insert(modulesTable).values({
      slug: MODULE_CATALOG[0].slug,
      name: "Custom Studio",
      description: "Hand-edited",
      icon: "Blocks",
      status: "beta",
      features: [],
    });

    const inserted = await seedModules();
    expect(inserted).toBe(SEED_COUNT - 1);

    const custom = (await db.select().from(modulesTable)).find(
      (r) => r.slug === MODULE_CATALOG[0].slug,
    );
    expect(custom?.name).toBe("Custom Studio");
    expect(custom?.status).toBe("beta");
  });
});
