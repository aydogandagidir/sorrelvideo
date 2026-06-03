/**
 * Pricing page — the load-bearing behavior under test is the conversion funnel
 * fix: a logged-OUT visitor who clicks the Pro CTA must be sent to /login with
 * a `returnTo=/pricing` so they land back on the pricing page after auth (and
 * can resume checkout in one click) rather than being dumped on the dashboard.
 *
 * `useAuth` + `useBillingPrices` are plain-fetch hooks, so the lightweight
 * fetch mock is enough. `login()` navigates via `window.location.href`, which
 * we stub (mirroring lib/auth-web's use-auth test) to capture the redirect.
 */
import { afterEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Pricing from "./pricing";
import {
  installFetchMock,
  renderWithProviders,
  type FetchRoute,
} from "@/test/test-utils";

const PRICES_ROUTE: FetchRoute = {
  url: "/api/billing/prices",
  json: {
    prices: [
      {
        id: "price_month_123",
        unitAmount: 2900,
        currency: "usd",
        interval: "month",
        productName: "Sorrel Pro",
      },
    ],
  },
};

const ANON_AUTH: FetchRoute = { url: "/api/auth/user", json: { user: null } };
const LOGGED_IN_AUTH: FetchRoute = {
  url: "/api/auth/user",
  json: { user: { id: "u1", email: "a@b.com" } },
};

let fetchMock: ReturnType<typeof installFetchMock> | undefined;
const originalLocation = window.location;

/** Stub window.location.href so login()'s redirect is observable. */
function stubLocationHref(): { current: string } {
  const ref = { current: "" };
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      pathname: "/pricing",
      search: "",
      hash: "",
      set href(value: string) {
        ref.current = value;
      },
      get href() {
        return ref.current;
      },
    },
  });
  return ref;
}

afterEach(() => {
  fetchMock?.restore();
  fetchMock = undefined;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
});

describe("Pricing — price rendering", () => {
  it("shows the monthly price derived from the billing prices fetch", async () => {
    fetchMock = installFetchMock([PRICES_ROUTE, ANON_AUTH]);

    renderWithProviders(<Pricing />, { route: "/pricing" });

    // 2900 cents → "$29".
    await waitFor(() => expect(screen.getByText("$29")).toBeInTheDocument());
    // Both plan headings render.
    expect(screen.getByRole("heading", { name: "Free" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pro" })).toBeInTheDocument();
  });
});

describe("Pricing — logged-out funnel (returnTo)", () => {
  it("a logged-out Pro CTA routes to /login carrying returnTo=/pricing", async () => {
    const user = userEvent.setup();
    const href = stubLocationHref();
    fetchMock = installFetchMock([PRICES_ROUTE, ANON_AUTH]);

    renderWithProviders(<Pricing />, { route: "/pricing" });

    // For an anonymous visitor the Pro CTA reads "Sign up & Get Started" and
    // becomes enabled once a monthly price is available.
    const cta = await screen.findByRole("button", {
      name: /sign up & get started/i,
    });
    await waitFor(() => expect(cta).toBeEnabled());

    await user.click(cta);

    // The funnel fix: returnTo is the (encoded) /pricing path, not the default.
    expect(href.current).toBe("/login?returnTo=%2Fpricing");
  });

  it("a logged-IN user's Pro CTA reads 'Get Started' and does NOT redirect to login", async () => {
    const user = userEvent.setup();
    const href = stubLocationHref();
    // No checkout stub → mutateAsync rejects; the handler swallows it. We only
    // assert it did NOT take the login path.
    fetchMock = installFetchMock([
      PRICES_ROUTE,
      LOGGED_IN_AUTH,
      { url: "/api/billing/checkout", status: 500, json: {} },
    ]);

    renderWithProviders(<Pricing />, { route: "/pricing" });

    const cta = await screen.findByRole("button", { name: /^get started$/i });
    await waitFor(() => expect(cta).toBeEnabled());

    await user.click(cta);

    // It attempts checkout, not the login redirect.
    expect(href.current).not.toContain("/login");
  });
});
