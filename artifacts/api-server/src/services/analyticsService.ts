/**
 * Analytics service — userId-scoped aggregation over the `render_jobs` ledger
 * (joined to `projects` for human-readable names/modules).
 *
 * Distinct from `statsService`/`/stats/overview` (the Dashboard's project-level
 * counters): this powers the Analytics screen's render-performance metrics —
 * success rate, per-day activity, format/template breakdowns, recent attempts.
 *
 * Every query filters `WHERE render_jobs.user_id = ?` (the multi-tenant
 * isolation invariant); the route owns auth, this module owns the SQL. Day
 * bucketing is done in UTC (`created_at AT TIME ZONE 'UTC'`) so the SQL buckets
 * line up with the UTC axis built in JS (`toISOString().slice(0, 10)`),
 * avoiding a session-timezone vs. Node-timezone skew at day boundaries.
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, renderJobsTable, projectsTable } from "@workspace/db";

/** How many trailing days the activity series covers. */
const ACTIVITY_DAYS = 30;
/** How many rows the "recent renders" table shows. */
const RECENT_LIMIT = 8;
/** How many entries the "top templates" breakdown shows. */
const TOP_TEMPLATES_LIMIT = 6;

export interface ActivityPoint {
  /** UTC day, formatted YYYY-MM-DD. */
  date: string;
  ready: number;
  failed: number;
  total: number;
}

export interface AnalyticsOverview {
  totals: {
    totalRenders: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    inProgress: number;
    /** succeeded / (succeeded + failed); null when no render has completed. */
    successRate: number | null;
    totalCostCents: number;
  };
  activity: ActivityPoint[];
  formats: { format: string; count: number }[];
  topTemplates: { module: string; count: number }[];
  recentRenders: {
    id: string;
    projectId: number;
    projectName: string | null;
    module: string | null;
    status: string;
    format: string | null;
    costCents: number | null;
    createdAt: Date;
  }[];
}

/** YYYY-MM-DD for a Date in UTC (matches the SQL `AT TIME ZONE 'UTC'` bucket). */
function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Build the full Analytics overview for one user. Runs the independent
 * aggregations concurrently, then stitches them into the response shape the
 * `AnalyticsOverview` OpenAPI schema validates.
 */
export async function getAnalyticsOverview(
  userId: string,
): Promise<AnalyticsOverview> {
  const since = new Date(Date.now() - (ACTIVITY_DAYS - 1) * 86_400_000);

  // The day bucket expression, reused verbatim in SELECT and GROUP BY.
  const dayExpr = sql<string>`to_char(${renderJobsTable.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

  const [statusRows, activityRows, formatRows, topTemplates, recentRenders] =
    await Promise.all([
      // Totals + cost, grouped by lifecycle status.
      db
        .select({
          status: renderJobsTable.status,
          count: sql<number>`count(*)::int`,
          cost: sql<number>`coalesce(sum(${renderJobsTable.costCents}), 0)::int`,
        })
        .from(renderJobsTable)
        .where(eq(renderJobsTable.userId, userId))
        .groupBy(renderJobsTable.status),

      // Per-day ready/failed counts over the trailing window.
      db
        .select({
          day: dayExpr,
          status: renderJobsTable.status,
          count: sql<number>`count(*)::int`,
        })
        .from(renderJobsTable)
        .where(
          and(
            eq(renderJobsTable.userId, userId),
            gte(renderJobsTable.createdAt, since),
          ),
        )
        .groupBy(dayExpr, renderJobsTable.status),

      // Output-format breakdown (null format → "unknown").
      db
        .select({
          format: sql<string>`coalesce(${renderJobsTable.format}, 'unknown')`,
          count: sql<number>`count(*)::int`,
        })
        .from(renderJobsTable)
        .where(eq(renderJobsTable.userId, userId))
        .groupBy(sql`coalesce(${renderJobsTable.format}, 'unknown')`)
        .orderBy(sql`count(*) desc`),

      // Most-rendered template modules (join projects for the module label).
      db
        .select({
          module: projectsTable.module,
          count: sql<number>`count(*)::int`,
        })
        .from(renderJobsTable)
        .innerJoin(
          projectsTable,
          eq(projectsTable.id, renderJobsTable.projectId),
        )
        .where(eq(renderJobsTable.userId, userId))
        .groupBy(projectsTable.module)
        .orderBy(sql`count(*) desc`)
        .limit(TOP_TEMPLATES_LIMIT),

      // Most recent attempts (join projects for name/module).
      db
        .select({
          id: renderJobsTable.id,
          projectId: renderJobsTable.projectId,
          projectName: projectsTable.name,
          module: projectsTable.module,
          status: renderJobsTable.status,
          format: renderJobsTable.format,
          costCents: renderJobsTable.costCents,
          createdAt: renderJobsTable.createdAt,
        })
        .from(renderJobsTable)
        .innerJoin(
          projectsTable,
          eq(projectsTable.id, renderJobsTable.projectId),
        )
        .where(eq(renderJobsTable.userId, userId))
        .orderBy(desc(renderJobsTable.createdAt))
        .limit(RECENT_LIMIT),
    ]);

  // Fold status groups into the headline totals.
  const byStatus = new Map(statusRows.map((r) => [r.status, r.count]));
  const succeeded = byStatus.get("ready") ?? 0;
  const failed = byStatus.get("failed") ?? 0;
  const cancelled = byStatus.get("cancelled") ?? 0;
  const inProgress =
    (byStatus.get("queued") ?? 0) + (byStatus.get("rendering") ?? 0);
  const totalRenders = statusRows.reduce((sum, r) => sum + r.count, 0);
  const totalCostCents = statusRows.reduce((sum, r) => sum + r.cost, 0);
  const completed = succeeded + failed;
  const successRate = completed > 0 ? succeeded / completed : null;

  // Zero-fill the activity axis so the chart always spans the full window.
  const activityByDay = new Map<
    string,
    { ready: number; failed: number; total: number }
  >();
  for (const row of activityRows) {
    const entry = activityByDay.get(row.day) ?? {
      ready: 0,
      failed: 0,
      total: 0,
    };
    entry.total += row.count;
    if (row.status === "ready") entry.ready += row.count;
    else if (row.status === "failed") entry.failed += row.count;
    activityByDay.set(row.day, entry);
  }
  const activity: ActivityPoint[] = [];
  for (let i = ACTIVITY_DAYS - 1; i >= 0; i--) {
    const key = utcDayKey(new Date(Date.now() - i * 86_400_000));
    const entry = activityByDay.get(key) ?? { ready: 0, failed: 0, total: 0 };
    activity.push({ date: key, ...entry });
  }

  return {
    totals: {
      totalRenders,
      succeeded,
      failed,
      cancelled,
      inProgress,
      successRate,
      totalCostCents,
    },
    activity,
    formats: formatRows,
    topTemplates,
    recentRenders,
  };
}
