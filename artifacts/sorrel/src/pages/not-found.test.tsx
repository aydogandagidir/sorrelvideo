/**
 * NotFound is the catch-all route. Beyond rendering the 404 copy + a working
 * "back to dashboard" link, it must use theme tokens (background / foreground /
 * muted / destructive) rather than hardcoded light-mode colors, so the page
 * renders correctly in dark mode too. We assert on the token classes and guard
 * against a regression to literal light-mode utilities.
 */
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import NotFound from "./not-found";
import { renderWithProviders } from "@/test/test-utils";

describe("NotFound", () => {
  it("renders the 404 heading and explanatory copy", () => {
    renderWithProviders(<NotFound />);

    expect(
      screen.getByRole("heading", { name: /404 page not found/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/couldn.t find the page you were looking for/i),
    ).toBeInTheDocument();
  });

  it("links back to the dashboard", () => {
    renderWithProviders(<NotFound />);

    expect(
      screen.getByRole("link", { name: /back to dashboard/i }),
    ).toHaveAttribute("href", "/dashboard");
  });

  it("uses theme tokens for the surface, heading, and accent colors", () => {
    const { container } = renderWithProviders(<NotFound />);

    // Outer surface is the themed background, not a hardcoded white.
    const surface = container.querySelector(".bg-background");
    expect(surface).not.toBeNull();

    // Heading uses the foreground token.
    expect(screen.getByRole("heading", { name: /404/i })).toHaveClass(
      "text-foreground",
    );
    // Body copy uses the muted-foreground token.
    expect(screen.getByText(/couldn.t find the page/i)).toHaveClass(
      "text-muted-foreground",
    );
    // The alert icon uses the destructive token.
    expect(container.querySelector(".text-destructive")).not.toBeNull();
  });

  it("does NOT hardcode light-mode color utilities", () => {
    const { container } = renderWithProviders(<NotFound />);
    const html = container.innerHTML;

    // A regression to literal light-mode classes would break dark mode.
    for (const banned of [
      "bg-white",
      "text-black",
      "text-gray-900",
      "text-gray-500",
      "bg-gray-50",
    ]) {
      expect(html).not.toContain(banned);
    }
  });
});
