import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, templatesTable } from "@workspace/db";
import {
  ListTemplatesQueryParams,
  ListTemplatesResponse,
  CreateTemplateBody,
  GetTemplateParams,
  GetTemplateResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/templates", async (req, res): Promise<void> => {
  const parsed = ListTemplatesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const conditions = [];
  if (parsed.data.category) {
    conditions.push(eq(templatesTable.category, parsed.data.category));
  }
  if (parsed.data.module) {
    conditions.push(eq(templatesTable.module, parsed.data.module));
  }

  const templates = await db
    .select()
    .from(templatesTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(templatesTable.id);

  res.json(ListTemplatesResponse.parse(templates));
});

router.post("/templates", async (req, res): Promise<void> => {
  const parsed = CreateTemplateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [template] = await db.insert(templatesTable).values(parsed.data).returning();
  res.status(201).json(GetTemplateResponse.parse(template));
});

router.get("/templates/:id", async (req, res): Promise<void> => {
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

  res.json(GetTemplateResponse.parse(template));
});

export default router;
