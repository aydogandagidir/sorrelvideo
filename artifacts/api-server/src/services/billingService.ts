import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  pool,
  stripeSubscriptionsTable,
  usersTable,
} from "@workspace/db";
import { getUncachableStripeClient } from "../stripeClient";
import { logger } from "../lib/logger";

const FREE_RENDER_LIMIT = 3;

export interface BillingInfo {
  plan: "free" | "pro";
  renderCount: number;
  renderLimit: number | null;
  renderResetAt: string | null;
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

/** Returns billing info for a user.
 *
 * If the monthly period has rolled over, the counter is reset in the DB so
 * that the next call (and the render-count check) see a consistent zero value.
 */
export async function getBillingInfo(userId: string): Promise<BillingInfo> {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (!user) throw new Error("User not found");

  const plan = await getUserPlan(user.stripeCustomerId);

  let renderCount = user.renderCount;
  let renderResetAt = user.renderResetAt;

  if (isNewMonth(renderResetAt)) {
    renderCount = 0;
    renderResetAt = null;
    // Persist the reset so subsequent reads are consistent
    await db
      .update(usersTable)
      .set({ renderCount: 0, renderResetAt: null })
      .where(eq(usersTable.id, userId));
  }

  return {
    plan,
    renderCount,
    renderLimit: plan === "free" ? FREE_RENDER_LIMIT : null,
    renderResetAt: renderResetAt ? renderResetAt.toISOString() : null,
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

    const plan = await getUserPlan(row.stripe_customer_id);

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

export { FREE_RENDER_LIMIT };
