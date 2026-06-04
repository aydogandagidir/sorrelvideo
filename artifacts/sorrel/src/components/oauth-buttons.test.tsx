/**
 * OAuthButtons renders ONLY the providers the backend reports as configured via
 * GET /api/auth/oauth/providers. When none are configured the whole block
 * (buttons + "or continue with email" divider) renders nothing, so the
 * email/password form isn't left dangling a divider over a 503 button.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { OAuthButtons } from "./oauth-buttons";
import { installFetchMock, renderWithProviders } from "@/test/test-utils";

let fetchMock: ReturnType<typeof installFetchMock> | undefined;

afterEach(() => {
  fetchMock?.restore();
  fetchMock = undefined;
});

describe("OAuthButtons", () => {
  it("renders nothing while the providers request is still pending", () => {
    // Never-resolving fetch keeps `providers` null → component returns null.
    fetchMock = installFetchMock();
    fetchMock.mock.mockImplementation(() => new Promise(() => {}));

    const { container } = renderWithProviders(<OAuthButtons />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when no providers are configured", async () => {
    fetchMock = installFetchMock([
      { url: "/api/auth/oauth/providers", json: { providers: [] } },
    ]);

    const { container } = renderWithProviders(<OAuthButtons />);

    // Give the effect a tick to resolve to [].
    await waitFor(() => expect(fetchMock?.mock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(
      screen.queryByText(/or continue with email/i),
    ).not.toBeInTheDocument();
  });

  it("renders ONLY the GitHub button when github is the sole provider", async () => {
    fetchMock = installFetchMock([
      { url: "/api/auth/oauth/providers", json: { providers: ["github"] } },
    ]);

    renderWithProviders(<OAuthButtons />);

    expect(
      await screen.findByRole("button", { name: /continue with github/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /continue with google/i }),
    ).not.toBeInTheDocument();
    // The divider appears once at least one provider renders.
    expect(screen.getByText(/or continue with email/i)).toBeInTheDocument();
  });

  it("renders both buttons when github + google are configured", async () => {
    fetchMock = installFetchMock([
      {
        url: "/api/auth/oauth/providers",
        json: { providers: ["github", "google"] },
      },
    ]);

    renderWithProviders(<OAuthButtons />);

    expect(
      await screen.findByRole("button", { name: /continue with github/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /continue with google/i }),
    ).toBeInTheDocument();
  });

  it("ignores unknown provider names returned by the API", async () => {
    fetchMock = installFetchMock([
      {
        url: "/api/auth/oauth/providers",
        json: { providers: ["github", "facebook", 42] },
      },
    ]);

    renderWithProviders(<OAuthButtons />);

    expect(
      await screen.findByRole("button", { name: /continue with github/i }),
    ).toBeInTheDocument();
    // No button for the unrecognized provider.
    expect(
      screen.queryByRole("button", { name: /facebook/i }),
    ).not.toBeInTheDocument();
  });

  it("treats a failed providers request as 'none configured'", async () => {
    fetchMock = installFetchMock([
      {
        url: "/api/auth/oauth/providers",
        status: 503,
        json: { error: "down" },
      },
    ]);

    const { container } = renderWithProviders(<OAuthButtons />);

    await waitFor(() => expect(fetchMock?.mock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("navigates to the GitHub start endpoint when the button is clicked", async () => {
    fetchMock = installFetchMock([
      { url: "/api/auth/oauth/providers", json: { providers: ["github"] } },
    ]);

    // Capture window.location.href assignment without a real navigation.
    const hrefSetter = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...originalLocation,
        set href(v: string) {
          hrefSetter(v);
        },
        get href() {
          return "";
        },
      },
    });

    try {
      renderWithProviders(<OAuthButtons />);
      const btn = await screen.findByRole("button", {
        name: /continue with github/i,
      });
      btn.click();
      expect(hrefSetter).toHaveBeenCalledWith("/api/auth/oauth/github");
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });
});
