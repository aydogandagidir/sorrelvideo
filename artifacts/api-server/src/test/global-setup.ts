import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

/**
 * Vitest globalSetup: stands up a single Postgres test container that's reused
 * across all api-server test files, applies the Drizzle schema once, then
 * `provide`s the connection URL to the test workers.
 *
 * Failures are non-fatal: if Docker isn't reachable (or the user passes
 * SORREL_SKIP_INTEGRATION_DB=true), we provide an empty URL — *.integration.test.ts
 * files key off that and skip themselves so the rest of the suite still runs.
 *
 * CI runs on ubuntu-latest with Docker built-in, so integration tests run
 * there. Local Windows / macOS dev without Docker Desktop sees them skipped.
 */
let container: StartedPostgreSqlContainer | null = null;

export default async function globalSetup(
  project: TestProject,
): Promise<() => Promise<void>> {
  if (process.env.SORREL_SKIP_INTEGRATION_DB === "true") {
    project.provide("INTEGRATION_DATABASE_URL", "");
    return async () => {};
  }

  try {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("sorrel_test")
      .withUsername("postgres")
      .withPassword("postgres")
      .start();

    const url = container.getConnectionUri();

    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, "../../../..");
    execSync("pnpm --filter @workspace/db run push-force", {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: url },
      stdio: "pipe",
    });

    project.provide("INTEGRATION_DATABASE_URL", url);
  } catch (err) {
    console.warn(
      `[vitest globalSetup] Could not start a Postgres testcontainer — ` +
        `*.integration.test.ts will skip. Cause: ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
    project.provide("INTEGRATION_DATABASE_URL", "");
  }

  return async () => {
    await container?.stop().catch(() => {});
    container = null;
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    INTEGRATION_DATABASE_URL: string;
  }
}
