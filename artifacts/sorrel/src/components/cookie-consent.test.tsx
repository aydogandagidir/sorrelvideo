/**
 * CookieConsent shows once per browser: visible when no localStorage flag is
 * set, and dismissal both hides the banner and persists the flag so it stays
 * hidden on the next mount.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CookieConsent } from "./cookie-consent";
import { renderWithProviders } from "@/test/test-utils";

const STORAGE_KEY = "sorrel.cookieConsent";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("CookieConsent", () => {
  it("shows the banner when no consent flag is stored", async () => {
    renderWithProviders(<CookieConsent />);

    // Revealed after mount (an effect flips `visible` true).
    expect(
      await screen.findByRole("dialog", { name: /cookie notice/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /got it/i })).toBeInTheDocument();
  });

  it("stays hidden when the dismissed flag is already set", () => {
    localStorage.setItem(STORAGE_KEY, "dismissed");

    renderWithProviders(<CookieConsent />);

    expect(
      screen.queryByRole("dialog", { name: /cookie notice/i }),
    ).not.toBeInTheDocument();
  });

  it("hides the banner and persists the flag when dismissed", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CookieConsent />);

    const banner = await screen.findByRole("dialog", {
      name: /cookie notice/i,
    });
    await user.click(within(banner).getByRole("button", { name: /got it/i }));

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: /cookie notice/i }),
      ).not.toBeInTheDocument(),
    );
    expect(localStorage.getItem(STORAGE_KEY)).toBe("dismissed");
  });

  it("links to the Privacy Policy", async () => {
    renderWithProviders(<CookieConsent />);

    const link = await screen.findByRole("link", { name: /privacy policy/i });
    expect(link).toHaveAttribute("href", "/privacy");
  });
});
