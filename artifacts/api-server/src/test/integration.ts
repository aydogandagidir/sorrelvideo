import { sql } from "drizzle-orm";
import { db, stripeSubscriptionsTable, usersTable } from "@workspace/db";

/**
 * Wipe every table in the right order (CASCADE handles FK fallout) so each
 * integration test starts with a fresh DB. Cheap on an empty schema.
 *
 * Call from `beforeEach` in every *.integration.test.ts file.
 */
export async function truncateAll(): Promise<void> {
  await db.execute(sql`
    TRUNCATE TABLE
      stripe_subscriptions,
      password_resets,
      email_verifications,
      oauth_accounts,
      sessions,
      render_jobs,
      projects,
      brand_kit,
      users,
      modules,
      templates
    RESTART IDENTITY CASCADE
  `);
}

/**
 * Insert a Free-plan user (no Stripe customer → getUserPlan returns "free") and
 * return its id. Shared by every integration suite that needs an owning user.
 */
export async function createFreeUser(): Promise<string> {
  const [row] = await db
    .insert(usersTable)
    .values({ email: `free-${Date.now()}-${Math.random()}@test.local` })
    .returning();
  return row.id;
}

/**
 * Insert a Pro user: a user with a Stripe customer id plus an `active`
 * subscription row, so getUserPlan(stripeCustomerId) returns "pro". Returns the
 * user id.
 */
export async function createProUser(): Promise<string> {
  const customerId = `cus_test_${Math.random().toString(36).slice(2)}`;
  const [row] = await db
    .insert(usersTable)
    .values({
      email: `pro-${Date.now()}-${Math.random()}@test.local`,
      stripeCustomerId: customerId,
    })
    .returning();
  await db.insert(stripeSubscriptionsTable).values({
    id: `sub_${customerId}`,
    customerId,
    status: "active",
    cancelAtPeriodEnd: false,
  });
  return row.id;
}
