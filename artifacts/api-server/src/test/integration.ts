import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

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
