/**
 * App shell (ported from the Claude Design handoff): the sidebar groups the main
 * nav and a "MODULES" section (with SOON badges), shows the Sorrel mark + v1.0
 * and a plan card; the topbar carries the breadcrumb, a ⌘K search button, and a
 * bell. The search button (and ⌘K) open the command palette. We mock auth +
 * billing at the fetch boundary so useAuth/useBillingInfo run for real.
 */
import { afterEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Layout } from "./layout";
import {
  installApiFetchMock,
  renderWithProviders,
  type ApiFetchRoute,
} from "@/test/test-utils";

let fetchMock: ReturnType<typeof installApiFetchMock> | undefined;

afterEach(() => {
  fetchMock?.restore();
  fetchMock = undefined;
});

const PRO_ROUTES: ApiFetchRoute[] = [
  { url: "/api/auth/user", json: { user: null } },
  {
    url: "/api/billing/me",
    json: {
      plan: "pro",
      renderCount: 0,
      renderLimit: null,
      renderResetAt: null,
      aiCount: 0,
      aiLimit: null,
      aiResetAt: null,
      stripeCustomerId: null,
    },
  },
];

describe("Layout shell", () => {
  it("renders the brand, grouped nav with shipped modules, plan card, and topbar", async () => {
    fetchMock = installApiFetchMock(PRO_ROUTES);
    renderWithProviders(
      <Layout>
        <div>content</div>
      </Layout>,
    );

    // Brand mark + version pin.
    expect(screen.getAllByText("Sorrel").length).toBeGreaterThan(0);
    expect(screen.getByText("v1.0")).toBeInTheDocument();

    // Main nav + the MODULES group (shipped modules only).
    expect(
      screen.getByRole("link", { name: /dashboard/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /brand dna/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Modules")).toBeInTheDocument();
    // Analytics ships as a real module — present, and with no "Soon" badge.
    expect(
      screen.getByRole("link", { name: /analytics/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^soon$/i)).not.toBeInTheDocument();
    // Unfinished modules (Bulk, Collab) are hidden from the nav until they ship.
    expect(
      screen.queryByRole("link", { name: /^bulk$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /^collab$/i }),
    ).not.toBeInTheDocument();

    // Pro plan card (async billing) + topbar search affordance.
    await waitFor(() =>
      expect(screen.getByText(/pro · unlimited/i)).toBeInTheDocument(),
    );
    // Two search affordances exist (desktop topbar + mobile header); jsdom
    // ignores the responsive CSS, so both render. At least one is present.
    expect(
      screen.getAllByRole("button", { name: /search/i }).length,
    ).toBeGreaterThan(0);
  });

  it("opens the command palette from the search button", async () => {
    const user = userEvent.setup();
    fetchMock = installApiFetchMock(PRO_ROUTES);
    renderWithProviders(
      <Layout>
        <div>content</div>
      </Layout>,
    );

    await user.click(screen.getAllByRole("button", { name: /search/i })[0]);
    expect(
      await screen.findByPlaceholderText(/jump to/i),
    ).toBeInTheDocument();
  });
});
