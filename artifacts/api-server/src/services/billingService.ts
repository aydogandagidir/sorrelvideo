import { eq, sql } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
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

/** Returns the current month's first day in UTC (for render count reset). */
function startOfNextMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** Returns true if the reset date has passed (i.e., a new billing period started). */
function isNewMonth(resetAt: Date | null): boolean {
  if (!resetAt) return true;
  return new Date() >= resetAt;
}

/**
 * Determines the user's current plan by querying the stripe.subscriptions table
 * (synced by stripe-replit-sync). Falls back to "free" if no active sub found.
 */
export async function getUserPlan(
  stripeCustomerId: string | null,
): Promise<"free" | "pro"> {
  if (!stripeCustomerId) return "free";

  try {
    const result = await db.execute(
      sql`SELECT id FROM stripe.subscriptions
          WHERE customer = ${stripeCustomerId}
            AND status IN ('active', 'trialing')
          LIMIT 1`,
    );
    return result.rows.length > 0 ? "pro" : "free";
  } catch {
    return "free";
  }
}

/** Returns billing info for a user. */
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
 * Checks render limit for free users. Throws with { reason: "upgrade_required" }
 * if the limit is exceeded.
 */
export async function checkAndIncrementRenderCount(
  userId: string,
): Promise<void> {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (!user) throw new Error("User not found");

  const plan = await getUserPlan(user.stripeCustomerId);

  if (plan === "pro") {
    await db
      .update(usersTable)
      .set({ renderCount: (user.renderCount ?? 0) + 1 })
      .where(eq(usersTable.id, userId));
    return;
  }

  let renderCount = user.renderCount ?? 0;
  let renderResetAt = user.renderResetAt;

  if (isNewMonth(renderResetAt)) {
    renderCount = 0;
    renderResetAt = startOfNextMonth();
  }

  if (renderCount >= FREE_RENDER_LIMIT) {
    throw Object.assign(new Error("Render limit reached — upgrade to Pro"), {
      reason: "upgrade_required",
      status: 403,
    });
  }

  await db
    .update(usersTable)
    .set({ renderCount: renderCount + 1, renderResetAt })
    .where(eq(usersTable.id, userId));
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
