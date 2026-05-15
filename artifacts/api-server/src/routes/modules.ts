import { Router, type IRouter } from "express";
import { db, modulesTable } from "@workspace/db";
import { ListModulesResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/modules", async (_req, res): Promise<void> => {
  const modules = await db.select().from(modulesTable).orderBy(modulesTable.id);
  res.json(ListModulesResponse.parse(modules));
});

export default router;
