/**
 * Pure gate/option logic for the render-settings form. These mirror the
 * server's `assertRenderSettingsAllowed` / `formatSupportsAlpha` and are the
 * cheapest place to pin the Free/Pro format matrix (the form's shadcn Select is
 * closed by default, so opening it in jsdom to read badges is brittle — the
 * gate predicate is the real contract the badges render from).
 */
import { describe, expect, it } from "vitest";
import {
  FORMAT_OPTIONS,
  formatSupportsAlpha,
  isProOnly,
} from "./render-settings";
import { RenderSettingsFormat } from "@workspace/api-client-react";

describe("isProOnly('format')", () => {
  it("treats mp4 and gif as Free, everything else Pro", () => {
    expect(isProOnly("format", RenderSettingsFormat.mp4)).toBe(false);
    expect(isProOnly("format", RenderSettingsFormat.gif)).toBe(false);
    expect(isProOnly("format", RenderSettingsFormat.webm)).toBe(true);
    expect(isProOnly("format", RenderSettingsFormat.mov)).toBe(true);
    expect(isProOnly("format", RenderSettingsFormat["png-sequence"])).toBe(true);
  });
});

describe("FORMAT_OPTIONS", () => {
  it("lists gif as a selectable option (Animated · no audio)", () => {
    const gif = FORMAT_OPTIONS.find(
      (o) => o.value === RenderSettingsFormat.gif,
    );
    expect(gif).toBeDefined();
    expect(gif?.label).toBe("GIF");
    expect(gif?.hint).toMatch(/no audio/i);
  });
});

describe("formatSupportsAlpha (frontend, mirrors the server)", () => {
  it("is false for the opaque formats (mp4, gif), true for the alpha set", () => {
    expect(formatSupportsAlpha(RenderSettingsFormat.mp4)).toBe(false);
    expect(formatSupportsAlpha(RenderSettingsFormat.gif)).toBe(false);
    expect(formatSupportsAlpha(RenderSettingsFormat.webm)).toBe(true);
    expect(formatSupportsAlpha(RenderSettingsFormat.mov)).toBe(true);
    expect(formatSupportsAlpha(RenderSettingsFormat["png-sequence"])).toBe(true);
  });
});
