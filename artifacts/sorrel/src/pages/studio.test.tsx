/**
 * Studio create page — the template picker. Studio used to hard-code the
 * `studio` module; it now offers the copy-compatible templates (studio,
 * product-launch, brand-promo, social-teaser, brand-story), all of which take
 * the same headline/body/CTA. These pin: the picker re-points the live preview
 * at the chosen module, and "Create & render" creates the project with it. We
 * mock at the fetch boundary (real Responses → the generated hooks run through
 * `customFetch`) and assert on the issued request.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Studio from "./studio";
import {
  installApiFetchMock,
  renderWithProviders,
  type ApiFetchRoute,
} from "@/test/test-utils";

// The live preview mounts <HfPlayer> (a dynamic web component jsdom can't
// register). Stub it to a div exposing the computed src so we can assert which
// composition route the preview points at.
vi.mock("@/components/hf-player", () => ({
  HfPlayer: (props: { src: string }) => (
    <div data-testid="hf-player" data-src={props.src} />
  ),
}));

// The spotlight-clip uploader pulls in Uppy's ObjectUploader, which doesn't
// resolve under vitest (react/jsx-dev-runtime). We don't exercise uploads here,
// so stub the hook to a no-op.
vi.mock("@workspace/object-storage-web", () => ({
  useUpload: () => ({ uploadFile: vi.fn(), isUploading: false, error: null }),
}));

let fetchMock: ReturnType<typeof installApiFetchMock> | undefined;

afterEach(() => {
  fetchMock?.restore();
  fetchMock = undefined;
});

/** Ambient Layout + brand/billing fetches (Free user; no brand kit). */
const LAYOUT_ROUTES: ApiFetchRoute[] = [
  { url: "/api/auth/user", json: { user: null } },
  { url: "/api/billing/me", status: 500, json: {} },
  { url: "/api/brand", status: 500, json: {} },
];

function previewSrc(): string {
  return screen.getByTestId("hf-player").getAttribute("data-src") ?? "";
}

/** POST calls captured by the active mock, with the JSON body parsed. */
function postCalls(): Array<{ url: string; body: unknown }> {
  const calls = fetchMock?.mock.mock.calls ?? [];
  return calls
    .filter((args) => {
      const init = args[1] as RequestInit | undefined;
      const input = args[0] as RequestInfo | URL;
      const method = (
        init?.method ??
        (typeof input === "object" && "method" in input
          ? (input as Request).method
          : "GET")
      ).toUpperCase();
      return method === "POST";
    })
    .map((args) => {
      const init = args[1] as RequestInit | undefined;
      const url =
        typeof args[0] === "string"
          ? (args[0] as string)
          : (args[0] as Request).url;
      let body: unknown;
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = undefined;
        }
      }
      return { url, body };
    });
}

describe("Studio — template picker", () => {
  it("re-points the live preview at the picked template module", async () => {
    const user = userEvent.setup();
    fetchMock = installApiFetchMock([...LAYOUT_ROUTES]);

    renderWithProviders(<Studio />, { route: "/studio" });

    // Defaults to the Studio template.
    expect(previewSrc()).toMatch(/^\/api\/compositions\/studio\/preview/);

    await user.click(screen.getByRole("button", { name: /product launch/i }));

    await waitFor(() =>
      expect(previewSrc()).toMatch(
        /^\/api\/compositions\/product-launch\/preview/,
      ),
    );
  });

  it("creates the project with the picked module", async () => {
    const user = userEvent.setup();
    fetchMock = installApiFetchMock([
      ...LAYOUT_ROUTES,
      {
        url: /\/api\/projects$/,
        method: "POST",
        status: 201,
        json: { id: 1, name: "x", status: "draft", module: "brand-promo" },
      },
      {
        url: /\/projects\/1\/render-settings$/,
        method: "PATCH",
        status: 200,
        json: {},
      },
      { url: /\/projects\/1\/render$/, method: "POST", status: 202, json: {} },
      { url: /\/api\/projects$/, method: "GET", json: [] },
    ]);

    renderWithProviders(<Studio />, { route: "/studio" });

    await user.click(screen.getByRole("button", { name: /brand promo/i }));
    await user.click(screen.getByRole("button", { name: /create & render/i }));

    await waitFor(() => {
      const post = postCalls().find((c) => /\/api\/projects$/.test(c.url));
      expect(post).toBeTruthy();
    });
    const post = postCalls().find((c) => /\/api\/projects$/.test(c.url));
    expect((post?.body as { module?: string }).module).toBe("brand-promo");
  });

  it("generates an AI background (with the prompt) before rendering when one is set", async () => {
    const user = userEvent.setup();
    fetchMock = installApiFetchMock([
      ...LAYOUT_ROUTES,
      {
        url: /\/api\/projects$/,
        method: "POST",
        status: 201,
        json: { id: 1, name: "x", status: "draft", module: "studio" },
      },
      {
        url: /\/projects\/1\/ai-image$/,
        method: "POST",
        status: 200,
        json: { id: 1, status: "draft", module: "studio" },
      },
      {
        url: /\/projects\/1\/render-settings$/,
        method: "PATCH",
        status: 200,
        json: {},
      },
      { url: /\/projects\/1\/render$/, method: "POST", status: 202, json: {} },
      { url: /\/api\/projects$/, method: "GET", json: [] },
    ]);

    renderWithProviders(<Studio />, { route: "/studio" });

    // Default module = studio (supports AI background) → the control is shown.
    await user.type(
      screen.getByPlaceholderText(/koyu degrade/i),
      "neon grid backdrop",
    );
    await user.click(screen.getByRole("button", { name: /create & render/i }));

    await waitFor(() =>
      expect(
        postCalls().some((c) => /\/projects\/1\/ai-image$/.test(c.url)),
      ).toBe(true),
    );
    const bg = postCalls().find((c) => /\/projects\/1\/ai-image$/.test(c.url));
    expect((bg?.body as { prompt?: string }).prompt).toBe("neon grid backdrop");
    // …and the render still fires (AI bg is a pre-render step, not a gate).
    expect(postCalls().some((c) => /\/projects\/1\/render$/.test(c.url))).toBe(
      true,
    );
  });
});
