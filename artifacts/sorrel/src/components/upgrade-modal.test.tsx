/**
 * UpgradeModal — the reason → copy mapping is the load-bearing behavior here.
 * studio.tsx / projects.tsx derive a `reason` prop from a backend 403 (string
 * matching on the error message) and pass it in; if this mapping drifts the
 * wrong nudge silently shows. These tests pin each reason's title + body, plus
 * the price rendering that comes from the billing fetch.
 */
import { afterEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { UpgradeModal } from "./upgrade-modal";
import {
  installFetchMock,
  renderWithProviders,
  type FetchRoute,
} from "@/test/test-utils";

const PRICE_ROUTE: FetchRoute = {
  url: "/api/billing/prices",
  json: {
    prices: [
      {
        id: "price_month",
        unitAmount: 1900,
        currency: "usd",
        interval: "month",
        productName: "Sorrel Pro",
      },
    ],
  },
};

let fetchMock: ReturnType<typeof installFetchMock> | undefined;

afterEach(() => {
  fetchMock?.restore();
  fetchMock = undefined;
});

describe("UpgradeModal — reason → copy mapping", () => {
  const cases = [
    {
      reason: "render_limit" as const,
      title: "You've hit the free render limit",
      bodyMatch: /3 renders per month/i,
    },
    {
      reason: "premium_template" as const,
      title: "Premium template requires Pro",
      bodyMatch: /exclusive to Pro users/i,
    },
    {
      reason: "ai_limit" as const,
      title: "You've hit the free AI limit",
      bodyMatch: /10 AI suggestions per month/i,
    },
    {
      reason: "render_quality" as const,
      title: "High-quality exports need Pro",
      bodyMatch: /4K, 60fps/i,
    },
    {
      reason: "general" as const,
      title: "Upgrade to Sorrel Pro",
      bodyMatch: /unlimited renders, all premium templates/i,
    },
  ];

  for (const { reason, title, bodyMatch } of cases) {
    it(`renders the "${reason}" title + description`, () => {
      fetchMock = installFetchMock([PRICE_ROUTE]);
      renderWithProviders(
        <UpgradeModal open onOpenChange={() => {}} reason={reason} />,
      );

      // Dialog title is the heading; assert on the role so we don't match the
      // same words appearing elsewhere.
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
      expect(screen.getByText(bodyMatch)).toBeInTheDocument();
    });
  }

  it("defaults to the general reason when none is passed", () => {
    fetchMock = installFetchMock([PRICE_ROUTE]);
    renderWithProviders(<UpgradeModal open onOpenChange={() => {}} />);

    expect(
      screen.getByRole("heading", { name: "Upgrade to Sorrel Pro" }),
    ).toBeInTheDocument();
  });
});

describe("UpgradeModal — pricing + chrome", () => {
  it("renders nothing when closed", () => {
    fetchMock = installFetchMock([PRICE_ROUTE]);
    renderWithProviders(
      <UpgradeModal open={false} onOpenChange={() => {}} reason="ai_limit" />,
    );

    expect(
      screen.queryByRole("heading", { name: "You've hit the free AI limit" }),
    ).not.toBeInTheDocument();
  });

  it("shows the monthly price (dollars) once the billing fetch resolves", async () => {
    fetchMock = installFetchMock([PRICE_ROUTE]);
    renderWithProviders(
      <UpgradeModal open onOpenChange={() => {}} reason="general" />,
    );

    // 1900 cents → $19 ; the "/month" suffix is rendered alongside.
    await waitFor(() => expect(screen.getByText("$19")).toBeInTheDocument());
    expect(screen.getByText("/month")).toBeInTheDocument();

    // The CTA enables once a monthly price exists.
    const cta = screen.getByRole("button", { name: /upgrade to pro/i });
    expect(cta).toBeEnabled();
  });

  it("falls back to a contact message + disabled CTA when no monthly price exists", async () => {
    fetchMock = installFetchMock([
      { url: "/api/billing/prices", json: { prices: [] } },
    ]);
    renderWithProviders(
      <UpgradeModal open onOpenChange={() => {}} reason="general" />,
    );

    await waitFor(() =>
      expect(screen.getByText(/contact us for pricing/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText("$19")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /upgrade to pro/i }),
    ).toBeDisabled();
  });

  it("always lists the Pro feature bullets", () => {
    fetchMock = installFetchMock([PRICE_ROUTE]);
    renderWithProviders(
      <UpgradeModal open onOpenChange={() => {}} reason="render_limit" />,
    );

    expect(
      screen.getByText("Unlimited renders & AI drafts"),
    ).toBeInTheDocument();
    expect(screen.getByText("All premium templates")).toBeInTheDocument();
    // The render_quality description also mentions 4K/60fps; the Pro bullet is
    // worded distinctly ("4K resolution & 60 fps") so neither getByText collides.
    expect(screen.getByText("4K resolution & 60 fps")).toBeInTheDocument();
  });
});
