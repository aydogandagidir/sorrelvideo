/**
 * RenderSettingsForm — the Free/Pro gate is the behavior that mirrors the
 * server's `assertRenderSettingsAllowed`. For a Free user a Pro-only option
 * stays clickable but, when picked, fires `onUpgrade()` and is NOT applied
 * (the control snaps back); for a Pro user the same pick flows through
 * `onChange`. These tests pin that contract plus the watermark-switch inversion.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RenderSettingsForm } from "./render-settings-form";
import { DEFAULT_RENDER_SETTINGS } from "@/lib/render-settings";
import { renderWithProviders } from "@/test/test-utils";

// RenderSettingsForm imports `useUpload` from @workspace/object-storage-web,
// which pulls in the Uppy-based ObjectUploader — a browser-only component the
// jsdom test env can't transform (its react/jsx-dev-runtime import fails to
// resolve cross-package), which otherwise makes this whole suite fail to LOAD.
// These tests exercise the Free/Pro gating, not uploads, so stub the hook.
vi.mock("@workspace/object-storage-web", () => ({
  useUpload: () => ({ uploadFile: vi.fn(), isUploading: false, error: null }),
}));

afterEach(() => vi.restoreAllMocks());

function setup(plan: "free" | "pro", overrides = {}) {
  const onChange = vi.fn();
  const onUpgrade = vi.fn();
  const value = { ...DEFAULT_RENDER_SETTINGS, ...overrides };
  renderWithProviders(
    <RenderSettingsForm
      value={value}
      onChange={onChange}
      plan={plan}
      onUpgrade={onUpgrade}
    />,
  );
  return { onChange, onUpgrade };
}

describe("RenderSettingsForm — Free plan gating", () => {
  it("badges Pro-only quality + fps options for a Free user", () => {
    setup("free");

    // "High" quality and "60" fps are Pro-only → the aria-label carries (Pro).
    expect(
      screen.getByRole("radio", { name: /high \(pro\)/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: /60 fps \(pro\)/i }),
    ).toBeInTheDocument();

    // The allowed floor options are NOT badged.
    expect(
      screen.getByRole("radio", { name: /^standard$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: /^24 fps$/i }),
    ).toBeInTheDocument();
  });

  it("fires onUpgrade and does NOT apply when a Free user picks a locked quality", async () => {
    const user = userEvent.setup();
    const { onChange, onUpgrade } = setup("free");

    await user.click(screen.getByRole("radio", { name: /high \(pro\)/i }));

    expect(onUpgrade).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("fires onUpgrade and does NOT apply when a Free user picks 60 fps", async () => {
    const user = userEvent.setup();
    const { onChange, onUpgrade } = setup("free");

    await user.click(screen.getByRole("radio", { name: /60 fps \(pro\)/i }));

    expect(onUpgrade).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("applies an allowed (non-Pro) pick even on the Free plan", async () => {
    const user = userEvent.setup();
    const { onChange, onUpgrade } = setup("free");

    await user.click(screen.getByRole("radio", { name: /^standard$/i }));

    expect(onUpgrade).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ quality: "standard" }),
    );
  });

  it("shows the Free transition cap hint and the remove-watermark Pro badge", () => {
    setup("free");

    expect(
      screen.getByText(/free plan supports up to 1 transition/i),
    ).toBeInTheDocument();
    // The "Remove watermark" label carries a Pro badge for Free users.
    const removeLabel = screen.getByText("Remove watermark").closest("label");
    expect(removeLabel).not.toBeNull();
    expect(
      within(removeLabel as HTMLElement).getByText("Pro"),
    ).toBeInTheDocument();
  });
});

describe("RenderSettingsForm — Pro plan", () => {
  it("does NOT badge quality options for a Pro user", () => {
    setup("pro");

    expect(screen.getByRole("radio", { name: /^high$/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("radio", { name: /high \(pro\)/i }),
    ).not.toBeInTheDocument();
  });

  it("applies a high-quality pick through onChange for a Pro user", async () => {
    const user = userEvent.setup();
    const { onChange, onUpgrade } = setup("pro");

    await user.click(screen.getByRole("radio", { name: /^high$/i }));

    expect(onUpgrade).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ quality: "high" }),
    );
  });

  it("omits the Free transition-cap hint for a Pro user", () => {
    setup("pro");
    expect(
      screen.queryByText(/free plan supports up to/i),
    ).not.toBeInTheDocument();
  });
});

describe("RenderSettingsForm — watermark switch inversion", () => {
  it("checks 'Remove watermark' when the project is NOT watermarked", () => {
    // watermark:false (Pro state) → the inverse 'remove' switch is ON.
    setup("pro", { watermark: false });
    expect(
      screen.getByRole("switch", { name: /remove watermark/i }),
    ).toBeChecked();
  });

  it("turns watermark OFF (Pro) by toggling the remove switch on for a Pro user", async () => {
    const user = userEvent.setup();
    // Start watermarked → switch is off; clicking it requests watermark:false.
    const { onChange } = setup("pro", { watermark: true });

    await user.click(screen.getByRole("switch", { name: /remove watermark/i }));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ watermark: false }),
    );
  });
});
