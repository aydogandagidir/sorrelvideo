import { Router, type IRouter } from "express";
import { eq, and, or, isNull } from "drizzle-orm";
import { db, templatesTable } from "@workspace/db";
import {
  ListTemplatesQueryParams,
  ListTemplatesResponse,
  CreateTemplateBody,
  GetTemplateParams,
  GetTemplateResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

function serializeDates<T>(data: T): T {
  return JSON.parse(JSON.stringify(data));
}

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

  res.json(GetTemplateResponse.parse(serializeDates(template)));
});

export default router;
