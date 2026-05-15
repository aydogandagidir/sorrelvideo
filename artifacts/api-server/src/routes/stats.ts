import { Router, type IRouter } from "express";
import { db, projectsTable, templatesTable, modulesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { GetStatsResponse } from "@workspace/api-zod";

const router: IRouter = Router();

function serializeDates<T>(data: T): T {
  return JSON.parse(JSON.stringify(data));
}

router.get("/stats/overview", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const userId = req.user.id;

  const [allProjects, totalTemplatesResult, activeModulesResult, recentProjects] =
    await Promise.all([
      db.select().from(projectsTable).where(eq(projectsTable.userId, userId)),
      db.select().from(templatesTable),
      db.select().from(modulesTable).where(eq(modulesTable.status, "active")),
      db
        .select()
        .from(projectsTable)
        .where(eq(projectsTable.userId, userId))
        .orderBy(desc(projectsTable.updatedAt))
        .limit(5),
    ]);

  const videosRendered = allProjects.filter((p) => p.status === "ready").length;

  res.json(
    GetStatsResponse.parse(
      serializeDates({
        totalProjects: allProjects.length,
        totalTemplates: totalTemplatesResult.length,
        videosRendered,
        activeModules: activeModulesResult.length,
        recentProjects,
      }),
    ),
  );
});

export default router;
