/**
 * Brand Kit page — now multi-kit. Three behaviors matter: the kit list HYDRATES
 * the editor from the default kit (listed first), "Detect" prefills the form
 * from POST /brand-kits/extract and switches to a NEW draft, and Save routes to
 * POST /brand-kits (new draft) vs PATCH /brand-kits/:id (existing kit).
 *
 * The hooks are generated Orval hooks (customFetch), so we use the real-Response
 * fetch mock and read captured request bodies. NOTE: the mock matches URLs by
 * substring, and "/api/brand-kits" contains "/api/brand" — so every rule uses an
 * ANCHORED regex (+ method) to avoid cross-matching.
 */
import { afterEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Brand from "./brand";
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

const AUTH_ROUTE: ApiFetchRoute = { url: "/api/auth/user", json: { user: null } };
const BILLING_ROUTE: ApiFetchRoute = {
  url: "/api/billing/me",
  status: 500,
  json: {},
};

function brandKit(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "Acme",
    isDefault: true,
    sourceUrl: null,
    logoUrl: null,
    primaryColor: "#112233",
    secondaryColor: "#445566",
    accentColor: "#ff0000",
    fontFamily: "Inter",
    companyName: "Acme Rockets",
    brandVoice: null,
    voiceDescription: "",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const LIST_ROUTE: ApiFetchRoute = {
  url: /\/api\/brand-kits$/,
  method: "GET",
  json: [brandKit(), brandKit({ id: 2, name: "Side project", isDefault: false })],
};

/** Body of the most recent request matching method + an anchored URL regex. */
function lastBody(method: string, urlRe: RegExp): Record<string, unknown> | undefined {
  const calls = fetchMock?.mock.mock.calls ?? [];
  for (let i = calls.length - 1; i >= 0; i--) {
    const [input, init] = calls[i] as [RequestInfo | URL, RequestInit?];
    const url = typeof input === "string" ? input : (input as Request).url;
    const m = (init?.method ?? "GET").toUpperCase();
    if (m === method.toUpperCase() && urlRe.test(url)) {
      return init?.body ? JSON.parse(init.body as string) : {};
    }
  }
  return undefined;
}

describe("Brand Kit — multi-kit", () => {
  it("lists kits and hydrates the editor from the default kit", async () => {
    fetchMock = installApiFetchMock([AUTH_ROUTE, BILLING_ROUTE, LIST_ROUTE]);
    renderWithProviders(<Brand />);

    const nameInput = await waitFor(() => screen.getByLabelText(/company name/i));
    expect(nameInput).toHaveValue("Acme Rockets");
    // Both kits show as switcher chips (exact names — "Delete Acme" is a separate
    // button, so a loose /Acme/ would match two elements).
    expect(screen.getByRole("button", { name: "Acme" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Side project" }),
    ).toBeInTheDocument();
  });

  it("detects a brand from a URL then creates a new kit", async () => {
    const user = userEvent.setup();
    fetchMock = installApiFetchMock([
      AUTH_ROUTE,
      BILLING_ROUTE,
      {
        url: /\/api\/brand-kits\/extract$/,
        method: "POST",
        json: {
          companyName: "Nebula Inc",
          primaryColor: "#abcdef",
          secondaryColor: "#102030",
          accentColor: "#ffaa00",
          fontFamily: "Poppins",
          logoUrl: null,
          sourceUrl: "https://nebula.test",
        },
      },
      { url: /\/api\/brand-kits$/, method: "POST", json: brandKit({ id: 9, companyName: "Nebula Inc" }) },
      LIST_ROUTE,
    ]);
    renderWithProviders(<Brand />);

    const detectInput = await waitFor(() =>
      screen.getByLabelText(/website url to detect/i),
    );
    await user.type(detectInput, "nebula.test");
    await user.click(screen.getByRole("button", { name: /^detect$/i }));

    // The detected company name lands in the form.
    await waitFor(() =>
      expect(screen.getByLabelText(/company name/i)).toHaveValue("Nebula Inc"),
    );

    // Saving the draft POSTs to /brand-kits with the detected values.
    await user.click(screen.getByRole("button", { name: /create brand kit/i }));
    await waitFor(() =>
      expect(lastBody("POST", /\/api\/brand-kits$/)).toBeDefined(),
    );
    const body = lastBody("POST", /\/api\/brand-kits$/);
    expect(body?.companyName).toBe("Nebula Inc");
    expect(body?.primaryColor).toBe("#abcdef");
    expect(body?.sourceUrl).toBe("https://nebula.test");
  });

  it("saves edits to an existing kit via PATCH", async () => {
    const user = userEvent.setup();
    fetchMock = installApiFetchMock([
      AUTH_ROUTE,
      BILLING_ROUTE,
      { url: /\/api\/brand-kits\/\d+$/, method: "PATCH", json: brandKit() },
      LIST_ROUTE,
    ]);
    renderWithProviders(<Brand />);

    const nameInput = await waitFor(() => screen.getByLabelText(/company name/i));
    await user.clear(nameInput);
    await user.type(nameInput, "Acme Galaxy");
    await user.click(screen.getByRole("button", { name: /save brand kit/i }));

    await waitFor(() =>
      expect(lastBody("PATCH", /\/api\/brand-kits\/\d+$/)).toBeDefined(),
    );
    expect(lastBody("PATCH", /\/api\/brand-kits\/\d+$/)?.companyName).toBe(
      "Acme Galaxy",
    );
  });
});
