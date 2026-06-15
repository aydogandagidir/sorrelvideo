/**
 * Analytics page tests.
 *
 * Two concerns are covered:
 *  1. AI-quota visibility (the original fix): the "AI drafts used" card must
 *     surface the real `aiCount / aiLimit` from /api/billing/me (Free) or a bare
 *     count + "Unlimited" hint (Pro), never a hardcoded "—"; plus render-usage
 *     and the billing error path.
 *  2. The render-metrics sections backed by GET /api/analytics/overview — KPI
 *     totals, format/template breakdowns, the recent-renders table, and empty
 *     states.
 *
 * The page mixes a plain-fetch hook (`useBillingInfo`) with an Orval-generated
 * hook (`useGetAnalyticsOverview`, via `customFetch`). The latter reads
 * `response.text()`/headers, which the lightweight `installFetchMock` stub does
 * not implement — so we use `installApiFetchMock`, which returns real `Response`
 * objects and serves both hook styles.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import Analytics from "./analytics";
import {
  installApiFetchMock,
  renderWithProviders,
  type ApiFetchRoute,
} from "@/test/test-utils";

// Recharts' ResponsiveContainer (rendered once data loads) needs
// ResizeObserver, which jsdom doesn't implement. A no-op shim lets the chart
// mount so the surrounding cards can be asserted on.
beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
      ResizeObserverStub;
  }
});

let fetchMock: ReturnType<typeof installApiFetchMock> | undefined;

afterEach(() => {
  fetchMock?.restore();
  fetchMock = undefined;
});

const AUTH_ROUTE: ApiFetchRoute = {
  url: "/api/auth/user",
  json: { user: null },
};

function billing(over: Record<string, unknown>): ApiFetchRoute {
  return {
    url: "/api/billing/me",
    json: {
      plan: "free",
      renderCount: 0,
      renderLimit: 3,
      renderResetAt: null,
      aiCount: 0,
      aiLimit: 10,
      aiResetAt: null,
      stripeCustomerId: null,
      ...over,
    },
  };
}

/** A populated /analytics/overview payload (numbers chosen to not collide with
 *  the billing quota labels asserted elsewhere). */
function analyticsOverview(over: Record<string, unknown> = {}): ApiFetchRoute {
  return {
    url: "/analytics/overview",
    json: {
      totals: {
        totalRenders: 12,
        succeeded: 9,
        failed: 2,
        cancelled: 1,
        inProgress: 0,
        successRate: 0.818,
        totalCostCents: 0,
      },
      activity: [
        { date: "2026-05-20", ready: 2, failed: 0, total: 2 },
        { date: "2026-05-21", ready: 1, failed: 1, total: 2 },
      ],
      formats: [
        { format: "mp4", count: 8 },
        { format: "webm", count: 4 },
      ],
      topTemplates: [
        { module: "studio-default", count: 6 },
        { module: "website-showcase", count: 4 },
      ],
      recentRenders: [
        {
          id: "rj-1",
          projectId: 1,
          projectName: "Launch promo",
          module: "studio-default",
          status: "ready",
          format: "mp4",
          costCents: null,
          createdAt: "2026-06-01T10:00:00.000Z",
        },
      ],
      ...over,
    },
  };
}

const EMPTY_ANALYTICS: ApiFetchRoute = {
  url: "/analytics/overview",
  json: {
    totals: {
      totalRenders: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      inProgress: 0,
      successRate: null,
      totalCostCents: 0,
    },
    activity: [],
    formats: [],
    topTemplates: [],
    recentRenders: [],
  },
};

/** Finds the summary card whose title matches, to scope value assertions. */
function cardByTitle(title: RegExp): HTMLElement {
  const heading = screen.getByText(title);
  const card = heading.closest(
    "div.rounded-xl, div.rounded-lg, [class*='rounded']",
  );
  if (!card) throw new Error(`card for ${title} not found`);
  return card as HTMLElement;
}

describe("Analytics — AI quota visibility (the fix)", () => {
  it("shows the Free user's aiCount / aiLimit, not a dash", async () => {
    fetchMock = installApiFetchMock([
      AUTH_ROUTE,
      billing({ aiCount: 4, aiLimit: 10 }),
      analyticsOverview(),
    ]);

    renderWithProviders(<Analytics />);

    const aiCard = await waitFor(() => cardByTitle(/ai drafts used/i));
    expect(within(aiCard).getByText("4 / 10")).toBeInTheDocument();
    expect(
      within(aiCard).getByText(/6 ai drafts left this month/i),
    ).toBeInTheDocument();
    expect(within(aiCard).queryByText("—")).not.toBeInTheDocument();
  });

  it("flags the near-cap state in amber when ≤2 drafts remain", async () => {
    fetchMock = installApiFetchMock([
      AUTH_ROUTE,
      billing({ aiCount: 9, aiLimit: 10 }),
      analyticsOverview(),
    ]);

    renderWithProviders(<Analytics />);

    const aiCard = await waitFor(() => cardByTitle(/ai drafts used/i));
    const value = within(aiCard).getByText("9 / 10");
    expect(value).toBeInTheDocument();
    expect(value).toHaveClass("text-warning");
    expect(
      within(aiCard).getByText(/1 ai draft left this month/i),
    ).toBeInTheDocument();
  });

  it("renders an unlimited AI hint (bare count) for a Pro user", async () => {
    fetchMock = installApiFetchMock([
      AUTH_ROUTE,
      billing({ plan: "pro", aiCount: 42, aiLimit: null, renderLimit: null }),
      analyticsOverview(),
    ]);

    renderWithProviders(<Analytics />);

    const aiCard = await waitFor(() => cardByTitle(/ai drafts used/i));
    expect(within(aiCard).getByText("42")).toBeInTheDocument();
    expect(
      within(aiCard).getByText(/unlimited on the pro plan/i),
    ).toBeInTheDocument();
  });
});

describe("Analytics — render usage + error", () => {
  it("shows the render usage label as count / limit", async () => {
    fetchMock = installApiFetchMock([
      AUTH_ROUTE,
      billing({ renderCount: 2, renderLimit: 3 }),
      analyticsOverview(),
    ]);

    renderWithProviders(<Analytics />);

    const renderCard = await waitFor(() => cardByTitle(/renders used/i));
    expect(within(renderCard).getByText("2 / 3")).toBeInTheDocument();
  });

  it("renders the destructive error alert when billing fails", async () => {
    fetchMock = installApiFetchMock([
      AUTH_ROUTE,
      { url: "/api/billing/me", status: 500, json: {} },
      analyticsOverview(),
    ]);

    renderWithProviders(<Analytics />);

    await waitFor(() =>
      expect(
        screen.getByText(/failed to load usage data/i),
      ).toBeInTheDocument(),
    );
  });
});

describe("Analytics — render metrics (analytics endpoint)", () => {
  it("surfaces KPI totals, breakdowns and the recent-renders table", async () => {
    fetchMock = installApiFetchMock([
      AUTH_ROUTE,
      billing({}),
      analyticsOverview(),
    ]);

    renderWithProviders(<Analytics />);

    // KPI: total renders from the ledger.
    const totalCard = await waitFor(() => cardByTitle(/total renders/i));
    expect(within(totalCard).getByText("12")).toBeInTheDocument();

    // Success rate KPI (0.818 → "81.8%").
    expect(screen.getByText("81.8%")).toBeInTheDocument();

    // Output-format breakdown is humanized (mp4 → MP4). "MP4" shows in both the
    // breakdown and the recent-renders row, so assert ≥1 rather than uniqueness.
    expect(screen.getAllByText("MP4").length).toBeGreaterThan(0);
    // Top-template slug is title-cased (studio-default → Studio Default).
    expect(screen.getAllByText("Studio Default").length).toBeGreaterThan(0);

    // Recent-renders table row (project name is unique to the row).
    expect(screen.getByText("Launch promo")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  it("shows empty states when there are no renders", async () => {
    fetchMock = installApiFetchMock([AUTH_ROUTE, billing({}), EMPTY_ANALYTICS]);

    renderWithProviders(<Analytics />);

    // The KPI still renders (zeroed), and the empty-state copy appears in the
    // activity / breakdown / table sections.
    const totalCard = await waitFor(() => cardByTitle(/total renders/i));
    expect(within(totalCard).getByText("0")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getAllByText(/no renders yet/i).length).toBeGreaterThan(0),
    );
  });
});
