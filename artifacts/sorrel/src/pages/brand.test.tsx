/**
 * Brand Kit page — two behaviors matter: the form HYDRATES from the loaded
 * brand kit (companyName, colors, voice all reflect server values), and SAVE
 * issues a PUT /api/brand carrying the edited payload. The save handler also
 * has a small but real branch: an unset brandVoice is omitted from the body
 * (the backend rejects the empty-string placeholder), so we assert both the
 * "omitted when empty" and "included when chosen" shapes.
 *
 * `useGetBrandKit` / `useUpdateBrandKit` are generated Orval hooks (customFetch
 * → PUT), so we use the real-Response fetch mock and read the captured request
 * body to verify what was sent.
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

const AUTH_ROUTE: ApiFetchRoute = {
  url: "/api/auth/user",
  json: { user: null },
};
const BILLING_ROUTE: ApiFetchRoute = { url: "/api/billing/me", status: 500, json: {} };

function brandKit(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    logoUrl: null,
    primaryColor: "#112233",
    secondaryColor: "#ffffff",
    accentColor: "#ff0000",
    fontFamily: "Inter",
    companyName: "Acme Rockets",
    brandVoice: null,
    voiceDescription: "",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

/** The body sent on the most recent PUT /api/brand call, parsed from JSON. */
function lastBrandPutBody(): Record<string, unknown> | undefined {
  const calls = fetchMock?.mock.mock.calls ?? [];
  for (let i = calls.length - 1; i >= 0; i--) {
    const [input, init] = calls[i] as [RequestInfo | URL, RequestInit?];
    const url = typeof input === "string" ? input : (input as Request).url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "PUT" && /\/api\/brand$/.test(url)) {
      return init?.body ? JSON.parse(init.body as string) : {};
    }
  }
  return undefined;
}

describe("Brand Kit — hydration", () => {
  it("populates the form from the loaded brand kit", async () => {
    fetchMock = installApiFetchMock([
      AUTH_ROUTE,
      BILLING_ROUTE,
      {
        url: "/api/brand",
        method: "GET",
        json: brandKit({ companyName: "Acme Rockets", brandVoice: "bold" }),
      },
    ]);

    renderWithProviders(<Brand />);

    // The company-name input reflects the server value once loaded.
    const nameInput = await waitFor(() =>
      screen.getByLabelText(/company name/i),
    );
    expect(nameInput).toHaveValue("Acme Rockets");
    // The brand-voice select is set to the stored enum.
    expect(screen.getByLabelText(/brand voice/i)).toHaveValue("bold");
    // Live preview echoes the company name (rendered text node).
    expect(screen.getAllByText("Acme Rockets").length).toBeGreaterThan(0);
  });
});

describe("Brand Kit — save", () => {
  it("PUTs the edited values, omitting brandVoice when none is chosen", async () => {
    const user = userEvent.setup();
    fetchMock = installApiFetchMock([
      AUTH_ROUTE,
      BILLING_ROUTE,
      // brandVoice null → the select stays on the empty placeholder.
      { url: "/api/brand", method: "GET", json: brandKit({ brandVoice: null }) },
      { url: "/api/brand", method: "PUT", json: brandKit() },
    ]);

    renderWithProviders(<Brand />);

    const nameInput = await waitFor(() =>
      screen.getByLabelText(/company name/i),
    );
    await user.clear(nameInput);
    await user.type(nameInput, "Nebula Inc");

    await user.click(screen.getByRole("button", { name: /save brand kit/i }));

    await waitFor(() => expect(lastBrandPutBody()).toBeDefined());
    const body = lastBrandPutBody();
    expect(body?.companyName).toBe("Nebula Inc");
    // The empty-string placeholder is NOT forwarded as brandVoice.
    expect(body).not.toHaveProperty("brandVoice");
    // Other fields ride along.
    expect(body?.primaryColor).toBe("#112233");
  });

  it("includes brandVoice in the payload once a tone is selected", async () => {
    const user = userEvent.setup();
    fetchMock = installApiFetchMock([
      AUTH_ROUTE,
      BILLING_ROUTE,
      { url: "/api/brand", method: "GET", json: brandKit({ brandVoice: null }) },
      { url: "/api/brand", method: "PUT", json: brandKit({ brandVoice: "playful" }) },
    ]);

    renderWithProviders(<Brand />);

    const voiceSelect = await waitFor(() => screen.getByLabelText(/brand voice/i));
    await user.selectOptions(voiceSelect, "playful");

    await user.click(screen.getByRole("button", { name: /save brand kit/i }));

    await waitFor(() => expect(lastBrandPutBody()).toBeDefined());
    expect(lastBrandPutBody()?.brandVoice).toBe("playful");
  });

  it("surfaces a destructive alert if the brand kit fails to load", async () => {
    fetchMock = installApiFetchMock([
      AUTH_ROUTE,
      BILLING_ROUTE,
      { url: "/api/brand", method: "GET", status: 500, json: {} },
    ]);

    renderWithProviders(<Brand />);

    await waitFor(() =>
      expect(screen.getByText(/failed to load brand kit/i)).toBeInTheDocument(),
    );
  });
});
