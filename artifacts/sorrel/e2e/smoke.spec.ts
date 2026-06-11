import { test, expect, type Route } from "@playwright/test";

/**
 * Real-browser smoke: the shipped SPA running in Chromium through the real Vite
 * pipeline. Complements the HTTP E2E (supertest, real backend) by covering the
 * layer nothing else does — the bundle actually booting + executing in a browser,
 * client-side routing, and the signup UX. The backend is mocked at the network
 * layer so the smoke is hermetic (no DB / server / Docker) and runs anywhere.
 */

const USER = {
  id: "u_e2e",
  email: "e2e@test.local",
  firstName: null,
  lastName: null,
  profileImageUrl: null,
};

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

test("SPA boots and the signup flow works in a real browser", async ({
  page,
}) => {
  let signedUp = false;

  // No OAuth providers configured → email/password form stands alone.
  await page.route("**/api/auth/oauth/providers", (route) =>
    json(route, 200, []),
  );
  // Auth state: anonymous until signup succeeds, then the new user.
  await page.route("**/api/auth/user", (route) =>
    json(route, 200, { user: signedUp ? USER : null }),
  );
  // Signup creates the account (the real flow then routes to verify-email).
  await page.route("**/api/auth/signup", (route) => {
    signedUp = true;
    return json(route, 201, { user: USER });
  });

  // 1) The shipped SPA bundle boots + renders in a real browser.
  await page.goto("/");
  await expect(page.locator("body")).toContainText(/sorrel/i);

  // 2) Signup flow end-to-end in the browser → client-routes to verify-email.
  await page.goto("/signup");
  await page.locator("#email").fill(USER.email);
  await page.locator("#password").fill("supersecret123");
  await page.getByRole("button", { name: /create account/i }).click();
  await expect(page).toHaveURL(/check-your-email/);
});
