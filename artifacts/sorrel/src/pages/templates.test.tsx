/**
 * Templates gallery — the paid-path behaviors:
 *  - the gallery renders a card per template (name + per-template badges);
 *  - a premium template shows the LOCKED affordance ("Unlock Template") for a
 *    Free user, while the same template is usable ("Use Template") for Pro —
 *    this is the upgrade nudge surface;
 *  - clicking "Use Template" fires POST /api/templates/:id/use and, on success,
 *    navigates the user to /projects?focus=<newId> (the create → land funnel).
 *
 * `isPro` comes from the plain-fetch billing hook; the list + "use" calls go
 * through the generated Orval hooks (customFetch). The real-Response fetch mock
 * serves both. We assert the navigation by reading Wouter's location from a
 * sibling probe rendered inside the same Router.
 */
import { afterEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "wouter";
import Templates from "./templates";
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

function template(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "Bold Promo",
    description: "A punchy intro card.",
    category: "marketing",
    module: "studio-default",
    thumbnailUrl: "https://cdn.example.com/thumb.png",
    duration: 8,
    isPremium: false,
    tags: ["intro"],
    ...over,
  };
}

function billingRoute(plan: "free" | "pro"): ApiFetchRoute {
  return {
    url: "/api/billing/me",
    json: {
      plan,
      renderCount: 0,
      renderLimit: plan === "pro" ? null : 3,
      renderResetAt: null,
      aiCount: 0,
      aiLimit: plan === "pro" ? null : 10,
      aiResetAt: null,
      stripeCustomerId: null,
    },
  };
}

const AUTH_ROUTE: ApiFetchRoute = { url: "/api/auth/user", json: { user: null } };

/** Reads the current Wouter location so navigation can be asserted. */
function LocationProbe() {
  const [location] = useLocation();
  return <div data-testid="location">{location}</div>;
}

describe("Templates — gallery + error/empty", () => {
  it("renders a card per template once the list resolves", async () => {
    fetchMock = installApiFetchMock([
      AUTH_ROUTE,
      billingRoute("free"),
      {
        url: "/api/templates",
        method: "GET",
        json: [
          template({ id: 1, name: "Bold Promo" }),
          template({ id: 2, name: "Minimal Intro" }),
        ],
      },
    ]);

    renderWithProviders(<Templates />);

    await waitFor(() =>
      expect(screen.getByText("Bold Promo")).toBeInTheDocument(),
    );
    expect(screen.getByText("Minimal Intro")).toBeInTheDocument();
    // Both cards expose a usable CTA (neither is premium here).
    expect(
      screen.getAllByRole("button", { name: /use template/i }),
    ).toHaveLength(2);
  });

  it("hides demo templates by default, then a toggle reveals them with a Demo badge", async () => {
    const user = userEvent.setup();
    fetchMock = installApiFetchMock([
      AUTH_ROUTE,
      billingRoute("free"),
      {
        url: "/api/templates",
        method: "GET",
        json: [
          template({ id: 1, name: "Studio Intro", customizable: true }),
          template({ id: 2, name: "Map Demo", customizable: false }),
        ],
      },
    ]);

    renderWithProviders(<Templates />);

    // The customizable template shows by default; the demo is hidden (no badge).
    await waitFor(() =>
      expect(screen.getByText("Studio Intro")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Map Demo")).not.toBeInTheDocument();
    expect(screen.queryByText("Demo")).not.toBeInTheDocument();

    // The toggle reveals the demo, now carrying a "Demo" badge.
    await user.click(
      screen.getByRole("button", { name: /show 1 demo template/i }),
    );
    expect(screen.getByText("Map Demo")).toBeInTheDocument();
    expect(screen.getByText("Demo")).toBeInTheDocument();
  });

  it("shows the empty-state copy when there are no templates", async () => {
    fetchMock = installApiFetchMock([
      AUTH_ROUTE,
      billingRoute("free"),
      { url: "/api/templates", method: "GET", json: [] },
    ]);

    renderWithProviders(<Templates />);

    await waitFor(() =>
      expect(screen.getByText(/no templates found/i)).toBeInTheDocument(),
    );
  });

  it("renders the error alert when the list request fails", async () => {
    fetchMock = installApiFetchMock([
      AUTH_ROUTE,
      billingRoute("free"),
      { url: "/api/templates", method: "GET", status: 500, json: {} },
    ]);

    renderWithProviders(<Templates />);

    await waitFor(() =>
      expect(screen.getByText(/failed to load templates/i)).toBeInTheDocument(),
    );
  });
});

describe("Templates — premium gating affordance", () => {
  it("a premium template is LOCKED for a Free user (Unlock, not Use)", async () => {
    fetchMock = installApiFetchMock([
      AUTH_ROUTE,
      billingRoute("free"),
      {
        url: "/api/templates",
        method: "GET",
        json: [template({ id: 5, name: "Premium Reel", isPremium: true })],
      },
    ]);

    renderWithProviders(<Templates />);

    await waitFor(() =>
      expect(screen.getByText("Premium Reel")).toBeInTheDocument(),
    );
    // The premium badge + the locked CTA both render for Free.
    expect(screen.getByText("Premium")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /unlock template/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /use template/i }),
    ).not.toBeInTheDocument();
  });

  it("opens the upgrade modal when a Free user clicks the locked CTA", async () => {
    const user = userEvent.setup();
    fetchMock = installApiFetchMock([
      AUTH_ROUTE,
      billingRoute("free"),
      { url: "/api/billing/prices", json: { prices: [] } },
      {
        url: "/api/templates",
        method: "GET",
        json: [template({ id: 5, name: "Premium Reel", isPremium: true })],
      },
    ]);

    renderWithProviders(<Templates />);
    await waitFor(() =>
      expect(screen.getByText("Premium Reel")).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: /unlock template/i }));

    // The premium_template upgrade dialog appears.
    expect(
      await screen.findByRole("heading", {
        name: /premium template requires pro/i,
      }),
    ).toBeInTheDocument();
  });

  it("a premium template is USABLE for a Pro user", async () => {
    fetchMock = installApiFetchMock([
      AUTH_ROUTE,
      billingRoute("pro"),
      {
        url: "/api/templates",
        method: "GET",
        json: [template({ id: 5, name: "Premium Reel", isPremium: true })],
      },
    ]);

    renderWithProviders(<Templates />);

    await waitFor(() =>
      expect(screen.getByText("Premium Reel")).toBeInTheDocument(),
    );
    // Pro sees the live "Use Template" CTA, not the lock.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /use template/i }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: /unlock template/i }),
    ).not.toBeInTheDocument();
  });
});

describe("Templates — use → create → navigate", () => {
  it("posts to /use and navigates to the focused project on success", async () => {
    const user = userEvent.setup();
    fetchMock = installApiFetchMock([
      AUTH_ROUTE,
      billingRoute("pro"),
      {
        url: "/api/templates",
        method: "GET",
        json: [template({ id: 12, name: "Launch Card" })],
      },
      {
        url: "/api/templates/12/use",
        method: "POST",
        json: { id: 99, name: "Launch Card", status: "draft", module: "studio-default" },
      },
    ]);

    renderWithProviders(
      <>
        <Templates />
        <LocationProbe />
      </>,
    );

    await waitFor(() =>
      expect(screen.getByText("Launch Card")).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: /use template/i }));

    // onSuccess → setLocation(`/projects?focus=99`).
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/projects",
      ),
    );

    // The POST to the template's /use endpoint actually fired.
    const usedCreate = (fetchMock?.mock.mock.calls ?? []).some((args) => {
      const url =
        typeof args[0] === "string" ? args[0] : (args[0] as Request).url;
      return /\/api\/templates\/12\/use$/.test(url);
    });
    expect(usedCreate).toBe(true);
  });
});
