import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, brandKitTable } from "@workspace/db";
import {
  GetBrandKitResponse,
  UpdateBrandKitBody,
  UpdateBrandKitResponse,
} from "@workspace/api-zod";

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
    const [created] = await db
      .insert(brandKitTable)
      .values({
        userId: req.user.id,
        primaryColor: "#6366f1",
        secondaryColor: "#8b5cf6",
        fontFamily: "Inter",
      })
      .returning();
    res.json(GetBrandKitResponse.parse(serializeDates(created)));
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

  const [existing] = await db
    .select()
    .from(brandKitTable)
    .where(eq(brandKitTable.userId, req.user.id))
    .limit(1);

  if (existing) {
    if (existing.userId !== req.user.id) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const [kit] = await db
      .update(brandKitTable)
      .set(parsed.data)
      .where(eq(brandKitTable.userId, req.user.id))
      .returning();
    res.json(UpdateBrandKitResponse.parse(serializeDates(kit)));
  } else {
    const [kit] = await db
      .insert(brandKitTable)
      .values({
        userId: req.user.id,
        primaryColor: "#6366f1",
        secondaryColor: "#8b5cf6",
        fontFamily: "Inter",
        ...parsed.data,
      })
      .returning();
    res.json(UpdateBrandKitResponse.parse(serializeDates(kit)));
  }
});

export default router;
