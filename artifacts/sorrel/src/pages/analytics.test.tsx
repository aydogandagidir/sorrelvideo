/**
 * Analytics page — the fix under test is AI-quota visibility: the "AI drafts
 * used" card must surface the real `aiCount / aiLimit` from /api/billing/me
 * (Free) or a bare count + "Unlimited" hint (Pro), never a hardcoded "—".
 * We also cover the render-usage label and the error path.
 *
 * `useBillingInfo` is a plain-fetch hook, so the lightweight fetch mock serves
 * it (and the ambient Layout auth/billing calls share the same /api/billing/me
 * stub).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import Analytics from "./analytics";
import {
  installFetchMock,
  renderWithProviders,
  type FetchRoute,
} from "@/test/test-utils";

// Recharts' ResponsiveContainer (rendered once billing loads) needs
// ResizeObserver, which jsdom doesn't implement. A no-op shim lets the chart
// mount so the surrounding summary cards can be asserted on.
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

let fetchMock: ReturnType<typeof installFetchMock> | undefined;

afterEach(() => {
  fetchMock?.restore();
  fetchMock = undefined;
});

const AUTH_ROUTE: FetchRoute = { url: "/api/auth/user", json: { user: null } };

function billing(over: Record<string, unknown>): FetchRoute {
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

/** Finds the summary card whose title matches, to scope value assertions. */
function cardByTitle(title: RegExp): HTMLElement {
  const heading = screen.getByText(title);
  // Walk up to the Card container ([data-slot] varies; the title's closest
  // ancestor that also holds the value is the <Card>).
  const card = heading.closest("div.rounded-xl, div.rounded-lg, [class*='rounded']");
  if (!card) throw new Error(`card for ${title} not found`);
  return card as HTMLElement;
}

describe("Analytics — AI quota visibility (the fix)", () => {
  it("shows the Free user's aiCount / aiLimit, not a dash", async () => {
    fetchMock = installFetchMock([
      AUTH_ROUTE,
      billing({ aiCount: 4, aiLimit: 10 }),
    ]);

    renderWithProviders(<Analytics />);

    // The AI card surfaces "4 / 10" from billing info.
    const aiCard = await waitFor(() => cardByTitle(/ai drafts used/i));
    expect(within(aiCard).getByText("4 / 10")).toBeInTheDocument();
    // The remaining-drafts hint is computed (10 - 4 = 6 left).
    expect(within(aiCard).getByText(/6 ai drafts left this month/i)).toBeInTheDocument();
    // Regression guard: the old hardcoded placeholder must be gone.
    expect(within(aiCard).queryByText("—")).not.toBeInTheDocument();
  });

  it("flags the near-cap state in amber when ≤2 drafts remain", async () => {
    fetchMock = installFetchMock([
      AUTH_ROUTE,
      billing({ aiCount: 9, aiLimit: 10 }),
    ]);

    renderWithProviders(<Analytics />);

    const aiCard = await waitFor(() => cardByTitle(/ai drafts used/i));
    const value = within(aiCard).getByText("9 / 10");
    expect(value).toBeInTheDocument();
    // 1 draft left → near-cap amber styling + singular "draft".
    expect(value).toHaveClass("text-amber-500");
    expect(within(aiCard).getByText(/1 ai draft left this month/i)).toBeInTheDocument();
  });

  it("renders an unlimited AI hint (bare count) for a Pro user", async () => {
    fetchMock = installFetchMock([
      AUTH_ROUTE,
      billing({ plan: "pro", aiCount: 42, aiLimit: null, renderLimit: null }),
    ]);

    renderWithProviders(<Analytics />);

    const aiCard = await waitFor(() => cardByTitle(/ai drafts used/i));
    // Pro: no "/ limit", just the count, and the unlimited hint.
    expect(within(aiCard).getByText("42")).toBeInTheDocument();
    expect(
      within(aiCard).getByText(/unlimited on the pro plan/i),
    ).toBeInTheDocument();
  });
});

describe("Analytics — render usage + error", () => {
  it("shows the render usage label as count / limit", async () => {
    fetchMock = installFetchMock([
      AUTH_ROUTE,
      billing({ renderCount: 2, renderLimit: 3 }),
    ]);

    renderWithProviders(<Analytics />);

    const renderCard = await waitFor(() => cardByTitle(/renders used/i));
    expect(within(renderCard).getByText("2 / 3")).toBeInTheDocument();
  });

  it("renders the destructive error alert when billing fails", async () => {
    fetchMock = installFetchMock([
      AUTH_ROUTE,
      { url: "/api/billing/me", status: 500, json: {} },
    ]);

    renderWithProviders(<Analytics />);

    await waitFor(() =>
      expect(screen.getByText(/failed to load usage data/i)).toBeInTheDocument(),
    );
  });
});
