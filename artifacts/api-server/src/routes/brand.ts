import { Router, type IRouter } from "express";
import { db, brandKitTable } from "@workspace/db";
import {
  GetBrandKitResponse,
  UpdateBrandKitBody,
  UpdateBrandKitResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/brand", async (_req, res): Promise<void> => {
  const [kit] = await db.select().from(brandKitTable).limit(1);

  if (!kit) {
    // Auto-create default brand kit
    const [created] = await db
      .insert(brandKitTable)
      .values({
        primaryColor: "#6366f1",
        secondaryColor: "#8b5cf6",
        fontFamily: "Inter",
      })
      .returning();
    res.json(GetBrandKitResponse.parse(created));
    return;
  }

  res.json(GetBrandKitResponse.parse(kit));
});

router.put("/brand", async (req, res): Promise<void> => {
  const parsed = UpdateBrandKitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Upsert: update existing or create if none
  const [existing] = await db.select().from(brandKitTable).limit(1);

  if (existing) {
    const [kit] = await db
      .update(brandKitTable)
      .set(parsed.data)
      .returning();
    res.json(UpdateBrandKitResponse.parse(kit));
  } else {
    const [kit] = await db
      .insert(brandKitTable)
      .values({
        primaryColor: "#6366f1",
        secondaryColor: "#8b5cf6",
        fontFamily: "Inter",
        ...parsed.data,
      })
      .returning();
    res.json(UpdateBrandKitResponse.parse(kit));
  }
});

export default router;
