import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, brandKitTable } from "@workspace/db";
import {
  GetBrandKitResponse,
  UpdateBrandKitBody,
  UpdateBrandKitResponse,
} from "@workspace/api-zod";
import { isSafeLogoUrl } from "../lib/logoUrl";

const router: IRouter = Router();

function serializeDates<T>(data: T): T {
  return JSON.parse(JSON.stringify(data));
}

router.get("/brand", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const [kit] = await db
    .select()
    .from(brandKitTable)
    .where(eq(brandKitTable.userId, req.user.id))
    .limit(1);

  if (!kit) {
    // First touch: create the default kit. `onConflictDoNothing` on the
    // UNIQUE(user_id) target makes this safe under a concurrent first GET —
    // the loser's insert is a no-op (returns nothing) instead of duplicating
    // the row, so we fall back to re-reading the winner's kit.
    const [created] = await db
      .insert(brandKitTable)
      .values({
        userId: req.user.id,
        primaryColor: "#6366f1",
        secondaryColor: "#8b5cf6",
        fontFamily: "Inter",
      })
      .onConflictDoNothing({ target: brandKitTable.userId })
      .returning();
    if (created) {
      res.json(GetBrandKitResponse.parse(serializeDates(created)));
      return;
    }
    const [existing] = await db
      .select()
      .from(brandKitTable)
      .where(eq(brandKitTable.userId, req.user.id))
      .limit(1);
    res.json(GetBrandKitResponse.parse(serializeDates(existing)));
    return;
  }

  res.json(GetBrandKitResponse.parse(serializeDates(kit)));
});

router.put("/brand", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const parsed = UpdateBrandKitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // The logoUrl is injected verbatim into an HTML `src="…"` attribute at render
  // time (logo-outro), and brand.* substitution intentionally does not escape
  // quotes (CSS font-family relies on that). Reject anything that isn't a clean
  // http(s) URL here so it can't break out of the attribute later.
  if (!isSafeLogoUrl(parsed.data.logoUrl)) {
    res.status(400).json({
      error: "logoUrl must be a valid http(s) URL",
    });
    return;
  }

  // Idempotent upsert keyed on UNIQUE(user_id): inserts the row on first touch,
  // updates it otherwise — in one statement, so two concurrent first-touch PUTs
  // can't duplicate the row (the loser hits the conflict and updates instead).
  // The row is always the caller's (keyed by req.user.id), so no ownership
  // branch is needed; the previous select-then-update could 403 a row that
  // could never belong to anyone else.
  const [kit] = await db
    .insert(brandKitTable)
    .values({
      userId: req.user.id,
      primaryColor: "#6366f1",
      secondaryColor: "#8b5cf6",
      fontFamily: "Inter",
      ...parsed.data,
    })
    .onConflictDoUpdate({
      target: brandKitTable.userId,
      // Always include user_id (a no-op self-assignment) so the SET clause is
      // never empty — an empty PUT body (every field optional) would otherwise
      // emit invalid `DO UPDATE SET` SQL. updatedAt still bumps via $onUpdate.
      set: { userId: req.user.id, ...parsed.data },
    })
    .returning();
  res.json(UpdateBrandKitResponse.parse(serializeDates(kit)));
});

export default router;
