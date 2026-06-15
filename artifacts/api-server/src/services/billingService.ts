import { and, eq, inArray } from "drizzle-orm";
import { db, pool, stripeSubscriptionsTable, usersTable } from "@workspace/db";
import { getUncachableStripeClient } from "../stripeClient";
import { logger } from "../lib/logger";

const FREE_RENDER_LIMIT = 3;
const FREE_AI_LIMIT = 10;

/**
 * Monthly cap on DISTRIBUTED (Lambda) renders — applied even to Pro users.
 * Lambda renders cost real AWS money per run, so unlike the inline/bullmq paths
 * (which Pro gets unlimited) the distributed backend is metered for everyone to
 * bound spend. Overridable via DISTRIBUTED_RENDER_LIMIT (default 100).
 */
const DISTRIBUTED_RENDER_LIMIT =
  Number(process.env.DISTRIBUTED_RENDER_LIMIT ?? "100") || 100;

export interface BillingInfo {
  plan: "free" | "pro";
  renderCount: number;
  renderLimit: number | null;
  renderResetAt: string | null;
  aiCount: number;
  aiLimit: number | null;
  aiResetAt: string | null;
  stripeCustomerId: string | null;
}

/** Returns the first day of next month in UTC (used as the render counter reset date). */
function startOfNextMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** Returns true if the monthly reset date has passed. */
function isNewMonth(resetAt: Date | null): boolean {
  if (!resetAt) return true;
  return new Date() >= resetAt;
}

/**
 * Determines the user's current plan by reading the local stripe_subscriptions
 * cache (populated by webhook events). Falls back to "free" if no active or
 * trialing subscription is found for the customer.
 */
export async function getUserPlan(
  stripeCustomerId: string | null,
): Promise<"free" | "pro"> {
  if (!stripeCustomerId) return "free";

  try {
    const rows = await db
      .select({ id: stripeSubscriptionsTable.id })
      .from(stripeSubscriptionsTable)
      .where(
        and(
          eq(stripeSubscriptionsTable.customerId, stripeCustomerId),
          inArray(stripeSubscriptionsTable.status, ["active", "trialing"]),
        ),
      )
      .limit(1);
    return rows.length > 0 ? "pro" : "free";
  } catch (err) {
    logger.warn({ err, stripeCustomerId }, "getUserPlan lookup failed");
    return "free";
  }
}

/**
 * Apply the monthly rollover reset for a user UNDER THE SAME ROW LOCK the
 * increment helpers use, then return the (possibly reset) counters.
 *
 * Why a lock: `getBillingInfo` used to do an UNLOCKED `db.update(... = 0)` when
 * the month had rolled over. That write raced the `FOR UPDATE` increment helpers
 * — a GET /billing landing between a concurrent `checkAndIncrement*`'s SELECT and
 * COMMIT could clobber a just-incremented count back to 0 (a free-usage leak).
 * Taking the row lock here serializes the reset against those helpers, so the
 * zeroing only ever happens when no increment is mid-flight, and `getBillingInfo`
 * itself becomes read-only (it just consumes these values).
 *
 * The reset is conditional and idempotent: each counter is zeroed (and its
 * reset-at cleared) only when its window has elapsed (`isNewMonth`). When nothing
 * is due, no UPDATE runs and the committed transaction is a plain locked read.
 */
async function applyMonthlyResetLocked(userId: string): Promise<{
  renderCount: number;
  renderResetAt: Date | null;
  aiCount: number;
  aiResetAt: Date | null;
}> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const lockResult = await client.query<{
      render_count: number;
      render_reset_at: Date | null;
      ai_count: number;
      ai_reset_at: Date | null;
    }>(
      `SELECT render_count, render_reset_at, ai_count, ai_reset_at
         FROM users
        WHERE id = $1
          FOR UPDATE`,
      [userId],
    );

    const row = lockResult.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      throw new Error("User not found");
    }

    let renderCount = row.render_count;
    let renderResetAt: Date | null = row.render_reset_at;
    let aiCount = row.ai_count;
    let aiResetAt: Date | null = row.ai_reset_at;

    const sets: string[] = [];
    const values: unknown[] = [];
    if (isNewMonth(renderResetAt)) {
      renderCount = 0;
      renderResetAt = null;
      sets.push(`render_count = 0`, `render_reset_at = NULL`);
    }
    if (isNewMonth(aiResetAt)) {
      aiCount = 0;
      aiResetAt = null;
      sets.push(`ai_count = 0`, `ai_reset_at = NULL`);
    }
    if (sets.length > 0) {
      values.push(userId);
      await client.query(
        `UPDATE users SET ${sets.join(", ")} WHERE id = $1`,
        values,
      );
    }

    await client.query("COMMIT");
    return { renderCount, renderResetAt, aiCount, aiResetAt };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Returns billing info for a user.
 *
 * If the monthly period has rolled over, the counter is reset in the DB so
 * that the next call (and the render-count check) see a consistent zero value.
 * The reset runs under the same row lock as the increment helpers
 * (`applyMonthlyResetLocked`), so it can't clobber a concurrent increment.
 */
export async function getBillingInfo(userId: string): Promise<BillingInfo> {
  const [user] = await db
    .select({ stripeCustomerId: usersTable.stripeCustomerId })
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (!user) throw new Error("User not found");

  const plan = await getUserPlan(user.stripeCustomerId);

  // Locked, idempotent monthly rollover; returns the live (post-reset) counters.
  const { renderCount, renderResetAt, aiCount, aiResetAt } =
    await applyMonthlyResetLocked(userId);

  return {
    plan,
    renderCount,
    renderLimit: plan === "free" ? FREE_RENDER_LIMIT : null,
    renderResetAt: renderResetAt ? renderResetAt.toISOString() : null,
    aiCount,
    aiLimit: plan === "free" ? FREE_AI_LIMIT : null,
    aiResetAt: aiResetAt ? aiResetAt.toISOString() : null,
    stripeCustomerId: user.stripeCustomerId,
  };
}

/**
 * Atomically checks and increments the monthly render count for the user.
 *
 * Uses a single UPDATE ... RETURNING statement guarded by the limit condition
 * to prevent race conditions under concurrent render requests. If the row was
 * not updated (limit already reached or new month not yet reset), we re-fetch
 * to return the precise rejection reason.
 *
 * Pro users: count is incremented unconditionally (no limit).
 * Free users: 403 is thrown with reason:"upgrade_required" once the monthly
 *             limit (FREE_RENDER_LIMIT) is reached.
 */
export async function checkAndIncrementRenderCount(
  userId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the row for update to prevent concurrent races
    const lockResult = await client.query<{
      render_count: number;
      render_reset_at: Date | null;
      stripe_customer_id: string | null;
    }>(
      `SELECT render_count, render_reset_at, stripe_customer_id
         FROM users
        WHERE id = $1
          FOR UPDATE`,
      [userId],
    );

    const row = lockResult.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      throw new Error("User not found");
    }

    // Plan check on the SAME locked client (not getUserPlan/db) — grabbing a
    // second pool connection while holding this FOR UPDATE transaction exhausts
    // the pool and deadlocks under concurrency, which hung the CI integration
    // tests (the txn never commits, so its row lock blocks the next truncate).
    const planCheck = row.stripe_customer_id
      ? await client.query(
          `SELECT 1 FROM stripe_subscriptions
            WHERE customer_id = $1 AND status IN ('active', 'trialing')
            LIMIT 1`,
          [row.stripe_customer_id],
        )
      : null;
    const plan: "free" | "pro" =
      planCheck && planCheck.rows.length > 0 ? "pro" : "free";

    if (plan === "pro") {
      // Pro users have unlimited renders; do not increment render_count so that
      // if the user later downgrades, their Free quota is not pre-consumed by
      // renders made while on a paid plan.
      await client.query("COMMIT");
      return;
    }

    // Reset counter if the monthly period has rolled over
    let renderCount = row.render_count;
    let renderResetAt: Date | null = row.render_reset_at;

    if (isNewMonth(renderResetAt)) {
      renderCount = 0;
      renderResetAt = startOfNextMonth();
    }

    if (renderCount >= FREE_RENDER_LIMIT) {
      await client.query("ROLLBACK");
      throw Object.assign(new Error("Render limit reached — upgrade to Pro"), {
        reason: "upgrade_required",
        status: 403,
      });
    }

    await client.query(
      `UPDATE users
          SET render_count = $1, render_reset_at = $2
        WHERE id = $3`,
      [renderCount + 1, renderResetAt, userId],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * REFUND one render against a Free user's monthly quota.
 *
 * `checkAndIncrementRenderCount` is charged at render-CLAIM time (so the count
 * guards concurrency), but a render that never produces output — the
 * `executeRender` failure path, or a post-claim release (render-settings re-gate
 * rejection, ledger-row insert failure, enqueue failure) — would otherwise burn
 * that Free render permanently. This gives it back.
 *
 * Discipline mirrors the increment helper (pg `FOR UPDATE` row lock) so a refund
 * can't race a concurrent increment/reset. Two guards keep it safe:
 *   - FLOORED AT 0 — never drive the count negative (defends against a double
 *     refund or a refund with nothing charged).
 *   - CURRENT-MONTH WINDOW ONLY — if the period has already rolled over
 *     (`isNewMonth(render_reset_at)`), the charge being refunded belonged to an
 *     expired window that the next read/increment will zero anyway, so refunding
 *     would wrongly eat into the fresh month's allowance. In that case it's a
 *     no-op.
 *
 * Pro users are never charged (the increment is skipped), so a refund is a
 * harmless no-op for them — `render_count` stays 0, floored. Best-effort by
 * design: callers invoke it on an error path and should not let a refund failure
 * mask the original error.
 */
export async function decrementRenderCount(userId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const lockResult = await client.query<{
      render_count: number;
      render_reset_at: Date | null;
    }>(
      `SELECT render_count, render_reset_at
         FROM users
        WHERE id = $1
          FOR UPDATE`,
      [userId],
    );

    const row = lockResult.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return;
    }

    // Only refund a charge that belongs to the CURRENT window. A rolled-over
    // window resets to 0 on the next read anyway; decrementing here would steal
    // from next month's allowance.
    if (isNewMonth(row.render_reset_at) || row.render_count <= 0) {
      await client.query("COMMIT");
      return;
    }

    await client.query(
      `UPDATE users
          SET render_count = render_count - 1
        WHERE id = $1`,
      [userId],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Atomically checks and increments the monthly AI suggest count for a user.
 *
 * Mirrors checkAndIncrementRenderCount: pg row lock + monthly reset.
 * Pro users bypass the counter (downgrading later doesn't pre-consume the
 * Free quota). Free users hit `upgrade_required` after FREE_AI_LIMIT.
 */
export async function checkAndIncrementAiCount(userId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const lockResult = await client.query<{
      ai_count: number;
      ai_reset_at: Date | null;
      stripe_customer_id: string | null;
    }>(
      `SELECT ai_count, ai_reset_at, stripe_customer_id
         FROM users
        WHERE id = $1
          FOR UPDATE`,
      [userId],
    );

    const row = lockResult.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      throw new Error("User not found");
    }

    // Plan check on the SAME locked client (not getUserPlan/db) — grabbing a
    // second pool connection while holding this FOR UPDATE transaction exhausts
    // the pool and deadlocks under concurrency, which hung the CI integration
    // tests (the txn never commits, so its row lock blocks the next truncate).
    const planCheck = row.stripe_customer_id
      ? await client.query(
          `SELECT 1 FROM stripe_subscriptions
            WHERE customer_id = $1 AND status IN ('active', 'trialing')
            LIMIT 1`,
          [row.stripe_customer_id],
        )
      : null;
    const plan: "free" | "pro" =
      planCheck && planCheck.rows.length > 0 ? "pro" : "free";

    if (plan === "pro") {
      // Pro: unlimited AI suggests; don't bump the counter.
      await client.query("COMMIT");
      return;
    }

    let aiCount = row.ai_count;
    let aiResetAt: Date | null = row.ai_reset_at;

    if (isNewMonth(aiResetAt)) {
      aiCount = 0;
      aiResetAt = startOfNextMonth();
    }

    if (aiCount >= FREE_AI_LIMIT) {
      await client.query("ROLLBACK");
      throw Object.assign(
        new Error("AI suggestion limit reached — upgrade to Pro"),
        { reason: "upgrade_required", status: 403 },
      );
    }

    await client.query(
      `UPDATE users
          SET ai_count = $1, ai_reset_at = $2
        WHERE id = $3`,
      [aiCount + 1, aiResetAt, userId],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Enforce the monthly DISTRIBUTED (Lambda) render cap — applied to EVERY plan,
 * including Pro. Unlike `checkAndIncrementRenderCount` (the Free quota that Pro
 * bypasses), this bounds the per-run-cost Lambda backend for all users so a single
 * account can't run up an unbounded AWS bill.
 *
 * ATOMIC check-and-increment under a pg `FOR UPDATE` row lock (the same proven
 * shape as `checkAndIncrementRenderCount`), with a monthly reset. This closes the
 * prior check-then-act race: the old version counted the `render_jobs` ledger with
 * an UNLOCKED read and the ledger INSERT happened later, so N concurrent dispatches
 * across different projects of one user could each observe `used < limit` and all
 * proceed, overrunning the cap. The counter now lives on a locked users row, so
 * concurrent dispatches serialize and the Nth-over-limit one is rejected.
 *
 * No refund on a later pre-dispatch failure: the cap is a coarse COST CEILING, so
 * consuming one of N slots on a failed attempt errs on the safe (spend-bounding)
 * side and avoids threading a decrement through the pinned render-start flow.
 *
 * Throws `{ reason: "upgrade_required", status: 403 }` when the cap is hit — the
 * SAME shape as the Free-quota / premium rejections, so the existing 403 handler
 * and `UpgradeModal` fire unchanged.
 */
export async function checkAndIncrementDistributedRenderCount(
  userId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const lockResult = await client.query<{
      distributed_render_count: number;
      distributed_render_reset_at: Date | null;
    }>(
      `SELECT distributed_render_count, distributed_render_reset_at
         FROM users
        WHERE id = $1
          FOR UPDATE`,
      [userId],
    );

    const row = lockResult.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      throw new Error("User not found");
    }

    let count = row.distributed_render_count;
    let resetAt: Date | null = row.distributed_render_reset_at;
    if (isNewMonth(resetAt)) {
      count = 0;
      resetAt = startOfNextMonth();
    }

    if (count >= DISTRIBUTED_RENDER_LIMIT) {
      await client.query("ROLLBACK");
      throw Object.assign(
        new Error("Monthly distributed render limit reached — upgrade to Pro"),
        { reason: "upgrade_required", status: 403 },
      );
    }

    await client.query(
      `UPDATE users
          SET distributed_render_count = $1, distributed_render_reset_at = $2
        WHERE id = $3`,
      [count + 1, resetAt, userId],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Creates or retrieves a Stripe customer for the user, stores the ID in DB.
 */
export async function ensureStripeCustomer(
  userId: string,
  email: string | null,
): Promise<string> {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (!user) throw new Error("User not found");

  if (user.stripeCustomerId) return user.stripeCustomerId;

  const stripe = await getUncachableStripeClient();
  const customer = await stripe.customers.create({
    email: email ?? undefined,
    metadata: { userId },
  });

  await db
    .update(usersTable)
    .set({ stripeCustomerId: customer.id })
    .where(eq(usersTable.id, userId));

  logger.info({ userId, customerId: customer.id }, "Created Stripe customer");
  return customer.id;
}

export { DISTRIBUTED_RENDER_LIMIT, FREE_AI_LIMIT, FREE_RENDER_LIMIT };
