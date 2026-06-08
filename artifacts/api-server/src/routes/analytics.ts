import { Router, type IRouter } from "express";
import { GetAnalyticsOverviewResponse } from "@workspace/api-zod";
import { getAnalyticsOverview } from "../services/analyticsService";

const router: IRouter = Router();

/** Drizzle returns `Date` objects; flatten to JSON before Zod parsing. */
function serializeDates<T>(data: T): T {
  return JSON.parse(JSON.stringify(data));
}

router.get("/analytics/overview", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const data = await getAnalyticsOverview(req.user.id);

  res.json(GetAnalyticsOverviewResponse.parse(serializeDates(data)));
});

export default router;
