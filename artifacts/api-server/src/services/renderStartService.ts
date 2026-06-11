/**
 * The render-START sequence — claim → quota → settings re-gate → ledger →
 * enqueue — extracted VERBATIM from POST /projects/:id/render so it has exactly
 * one implementation. Two callers: the render route (which owns auth/HTTP and
 * maps the result codes to its original response bodies) and
 * `createTalkingHostVideo` (auto-render after creating a script→video project,
 * where a quota block degrades to "saved as draft" instead of an HTTP 403).
 *
 * The sequence has six claim-release/refund pairings (quota 403, re-gate 403 +
 * refund, ledger 503 + refund, enqueue 503 + refund, RenderAlreadyActiveError
 * 409 with the charge deliberately KEPT, success). Duplicating it would drift;
 * the three render integration suites (renderClaimRelease / renderReGate /
 * renderReRenderRace) pin this behavior through the route.
 *
 * EXPECTED outcomes return result codes, never throw — only truly unexpected
 * errors propagate (the route's implicit-500 path, unchanged).
 */
import { and, eq, ne } from "drizzle-orm";
import { db, projectsTable, usersTable } from "@workspace/db";
import { logger } from "../lib/logger";
import {
  enqueueRender,
  isQueueEnabled,
  RenderAlreadyActiveError,
} from "../lib/renderQueue";
import { selectBackend } from "../lib/renderBackend";
import {
  createRenderJob as createRenderJobRow,
  markCancelled,
  markFailed,
} from "./renderJobsService";
import {
  checkAndIncrementRenderCount,
  checkAndIncrementDistributedRenderCount,
  decrementRenderCount,
  getUserPlan,
} from "./billingService";
import {
  resolveSettings,
  assertRenderSettingsAllowed,
} from "./renderSettingsService";

type ProjectRow = typeof projectsTable.$inferSelect;

export type StartRenderResult =
  /** Claimed: `project` is the row with status "rendering". */
  | { ok: true; project: ProjectRow; renderJobId: string }
  /** Another render holds the claim (or its queue lock) — route maps to 409. */
  | { ok: false; code: "already_rendering" }
  /** Render quota / Pro-gate rejection — route maps to 403 upgrade_required. */
  | { ok: false; code: "upgrade_required"; message: string }
  /** Ledger/enqueue infrastructure failure — route maps to 503. */
  | { ok: false; code: "unavailable" };

/**
 * Start a render for an already-loaded, ownership-verified project. Callers own
 * auth + the 404/403 ownership checks (and the route additionally pre-checks
 * premium-template access before calling).
 */
export async function startProjectRender(
  userId: string,
  project: ProjectRow,
): Promise<StartRenderResult> {
  const id = project.id;

  /** Release the atomic claim back to the pre-claim status. */
  async function releaseClaim(): Promise<void> {
    await db
      .update(projectsTable)
      .set({ status: project.status })
      .where(eq(projectsTable.id, id));
  }

  // Atomically claim the render. The conditional UPDATE is the concurrency guard:
  // only one request can flip a project out of a non-rendering state, so two
  // concurrent calls can't both start a render. 0 rows → already rendering.
  const [claimed] = await db
    .update(projectsTable)
    .set({ status: "rendering", renderError: null })
    .where(and(eq(projectsTable.id, id), ne(projectsTable.status, "rendering")))
    .returning();

  if (!claimed) {
    return { ok: false, code: "already_rendering" };
  }

  // Quota AFTER the claim so the race loser never burns a render. On rejection,
  // release the claim back to the prior status (a quota block isn't a failure).
  try {
    await checkAndIncrementRenderCount(userId);
  } catch (err) {
    await releaseClaim();
    const e = err as { reason?: string; message?: string };
    if (e.reason === "upgrade_required") {
      return {
        ok: false,
        code: "upgrade_required",
        message: e.message ?? "Render limit reached",
      };
    }
    throw err;
  }

  // Re-gate the persisted render settings at render time (defense in depth — a
  // user who downgraded after saving a Pro config must not render it). On a
  // gate failure, release the claim back to the prior status (not a render
  // failure), byte-identical to the quota / premium-template rejections.
  const settings = resolveSettings(project.renderSettings);
  const [planRow] = await db
    .select({ stripeCustomerId: usersTable.stripeCustomerId })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  const plan = await getUserPlan(planRow?.stripeCustomerId ?? null);
  try {
    assertRenderSettingsAllowed(settings, plan);
    // Distributed (Lambda) renders carry a separate monthly cap — even for Pro,
    // since they cost real money. Only enforced when this render actually routes
    // to Lambda (RENDER_BACKEND=lambda + AWS env + Pro); inline/bullmq unaffected.
    if (selectBackend(plan) === "lambda") {
      await checkAndIncrementDistributedRenderCount(userId);
    }
  } catch (err) {
    const e = err as { reason?: string; message?: string };
    if (e.reason === "upgrade_required") {
      await releaseClaim();
      // Refund the render charged just above: this attempt produced no output.
      // No-op for Pro (never charged). Best-effort — never mask the rejection.
      await decrementRenderCount(userId).catch(() => undefined);
      return {
        ok: false,
        code: "upgrade_required",
        message: e.message ?? "Upgrade required",
      };
    }
    throw err;
  }

  // Open a render-job ledger row before enqueueing so the pipeline has an id to
  // advance through queued → rendering → ready/failed/cancelled. If the INSERT
  // fails (e.g. the render_jobs table is missing), release the claim back to the
  // prior status so the project is never stranded in "rendering".
  let renderJobId: string;
  try {
    renderJobId = await createRenderJobRow({
      projectId: id,
      userId,
      backend: isQueueEnabled() ? "bullmq" : "inline",
      config: settings,
      format: settings.format,
    });
  } catch (err) {
    await releaseClaim();
    // Refund the render charged above: no ledger row, so nothing will ever run
    // or produce output. No-op for Pro; best-effort so it never masks the 503.
    await decrementRenderCount(userId).catch(() => undefined);
    logger.error(
      { projectId: id, err },
      "Failed to open render-job ledger row",
    );
    return { ok: false, code: "unavailable" };
  }

  // Durable enqueue when REDIS_URL is set; inline fire-and-forget otherwise.
  // If enqueue fails, release the claim so the project isn't stranded in
  // "rendering" and resolve the just-opened ledger row.
  try {
    await enqueueRender(id, project.module, project.templateId, renderJobId, plan);
  } catch (err) {
    await releaseClaim();
    // RenderAlreadyActiveError is transient, not a failure: the PREVIOUS render
    // of this project is still finishing (its BullMQ job lock is held), so this
    // attempt was never queued. Release the claim, mark this attempt's ledger
    // row cancelled (it never ran), and report already_rendering so the client
    // retries shortly — exactly like losing the atomic claim. The burned quota
    // increment is the accepted cost of a near-simultaneous double render
    // (rare; the previous render still completes).
    if (err instanceof RenderAlreadyActiveError) {
      await markCancelled(renderJobId).catch(() => undefined);
      return { ok: false, code: "already_rendering" };
    }
    await markFailed(
      renderJobId,
      err instanceof Error ? err.message : String(err),
    ).catch(() => undefined);
    // Refund the render charged above: the enqueue failed, so the job never ran
    // and produced no output. (RenderAlreadyActiveError above intentionally keeps
    // the charge — the PREVIOUS render is still finishing and will produce one.)
    // No-op for Pro; best-effort so it never masks the 503.
    await decrementRenderCount(userId).catch(() => undefined);
    logger.error({ projectId: id, err }, "Failed to enqueue render");
    return { ok: false, code: "unavailable" };
  }

  return { ok: true, project: claimed, renderJobId };
}
