import { Router, type IRouter } from "express";
import { db, projectsTable, templatesTable, modulesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { GetStatsResponse } from "@workspace/api-zod";

const router: IRouter = Router();

function serializeDates<T>(data: T): T {
  return JSON.parse(JSON.stringify(data));
}

router.get("/stats/overview", async (_req, res): Promise<void> => {
  const [totalProjectsResult, totalTemplatesResult, activeModulesResult, recentProjects] =
    await Promise.all([
      db.select().from(projectsTable),
      db.select().from(templatesTable),
      db.select().from(modulesTable).where(eq(modulesTable.status, "active")),
      db.select().from(projectsTable).orderBy(desc(projectsTable.updatedAt)).limit(5),
    ]);

  const videosRendered = totalProjectsResult.filter((p) => p.status === "ready").length;

  res.json(
    GetStatsResponse.parse(
      serializeDates({
        totalProjects: totalProjectsResult.length,
        totalTemplates: totalTemplatesResult.length,
        videosRendered,
        activeModules: activeModulesResult.length,
        recentProjects,
      }),
    ),
  );
});

export default router;
