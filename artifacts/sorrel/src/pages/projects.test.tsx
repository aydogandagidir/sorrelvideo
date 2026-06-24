/**
 * Projects page — the render library. After the design port, each project is a
 * 9:16 thumbnail card that opens a detail modal; the per-project controls
 * (Render / Re-render / Download / Delete) live in that modal. The surface that
 * matters here: the list's data-driven states (loading / error / empty CTA), the
 * status → controls mapping in the detail, and the delete-confirmation
 * AlertDialog (trash only *arms* it; only the explicit "Delete" confirm fires the
 * DELETE — Cancel must not). We mock at the fetch boundary (real Responses, so the
 * generated hooks run through `customFetch`) and assert on the issued request.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Projects from "./projects";
import {
  installApiFetchMock,
  renderWithProviders,
  type ApiFetchRoute,
} from "@/test/test-utils";

// The draft/failed detail preview mounts <HfPlayer>, whose wrapper dynamically
// imports the @hyperframes/player web component — which jsdom can't register.
// Stub it to a plain div exposing the computed src so tests stay hermetic and
// can assert the preview points at the project's composition route.
vi.mock("@/components/hf-player", () => ({
  HfPlayer: (props: { src: string }) => (
    <div data-testid="hf-player" data-src={props.src} />
  ),
}));

let fetchMock: ReturnType<typeof installApiFetchMock> | undefined;

afterEach(() => {
  fetchMock?.restore();
  fetchMock = undefined;
});

function draftProject(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "Q3 Promo",
    description: null,
    status: "draft",
    module: "studio",
    templateId: null,
    thumbnailUrl: null,
    videoUrl: null,
    duration: 12,
    renderError: null,
    compositionVars: { "user.headline": "Hi", "user.ctaText": "Go" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...over,
  };
}

/** Common no-op stubs for the ambient Layout + brand fetches. */
const LAYOUT_ROUTES: ApiFetchRoute[] = [
  { url: "/api/auth/user", json: { user: null } },
  { url: "/api/billing/me", status: 500, json: {} },
  { url: "/api/brand", status: 500, json: {} },
];

function listRoute(projects: unknown[]): ApiFetchRoute {
  return { url: "/api/projects", method: "GET", json: projects };
}

/**
 * Open a project's detail modal by clicking its card (by project name). Scoped
 * to the grid so it never matches the global RenderTray (which also lists a
 * rendering project by name).
 */
async function openDetail(name: string) {
  const user = userEvent.setup();
  const grid = await screen.findByTestId("projects-grid");
  await user.click(within(grid).getByText(name));
  return screen.findByRole("dialog");
}

describe("Projects — list states", () => {
  it("shows the skeleton loaders while the project list is loading", () => {
    fetchMock = installApiFetchMock([]);
    fetchMock.mock.mockImplementation(() => new Promise(() => {}));

    const { container } = renderWithProviders(<Projects />, { route: "/projects" });

    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(
      0,
    );
    expect(
      screen.queryByRole("heading", { name: /no projects yet/i }),
    ).not.toBeInTheDocument();
  });

  it("renders a destructive error alert when the list request fails", async () => {
    fetchMock = installApiFetchMock([
      ...LAYOUT_ROUTES,
      { url: "/api/projects", method: "GET", status: 500, json: {} },
    ]);

    renderWithProviders(<Projects />, { route: "/projects" });

    await waitFor(() =>
      expect(screen.getByText(/failed to load projects/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("renders the empty-state CTA when there are no projects", async () => {
    fetchMock = installApiFetchMock([...LAYOUT_ROUTES, listRoute([])]);

    renderWithProviders(<Projects />, { route: "/projects" });

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /no projects yet/i }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /create first project/i }),
    ).toBeInTheDocument();
  });
});

describe("Projects — sort", () => {
  it("reorders the grid by the selected sort (updatedAt + name)", async () => {
    const user = userEvent.setup();
    // Names + dates are deliberately misaligned so each sort yields a DISTINCT
    // order: alpha = Apple/Banana/Cherry, date desc = Banana/Apple/Cherry.
    fetchMock = installApiFetchMock([
      ...LAYOUT_ROUTES,
      listRoute([
        draftProject({
          id: 1,
          name: "Banana",
          updatedAt: "2026-03-01T00:00:00.000Z",
        }),
        draftProject({
          id: 2,
          name: "Apple",
          updatedAt: "2026-02-01T00:00:00.000Z",
        }),
        draftProject({
          id: 3,
          name: "Cherry",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      ]),
    ]);

    renderWithProviders(<Projects />, { route: "/projects" });
    await screen.findByTestId("projects-grid");

    const order = () =>
      Array.from(screen.getByTestId("projects-grid").children).map((card) =>
        ["Apple", "Banana", "Cherry"].find((n) =>
          card.textContent?.includes(n),
        ),
      );

    // Default: Newest (updatedAt desc).
    expect(order()).toEqual(["Banana", "Apple", "Cherry"]);

    const sortSelect = screen.getByLabelText(/sort projects/i);
    await user.selectOptions(sortSelect, "name");
    expect(order()).toEqual(["Apple", "Banana", "Cherry"]);

    await user.selectOptions(sortSelect, "oldest");
    expect(order()).toEqual(["Cherry", "Apple", "Banana"]);
  });
});

describe("Projects — card → detail controls", () => {
  it("a draft card opens a detail with Render + an enabled delete control", async () => {
    fetchMock = installApiFetchMock([
      ...LAYOUT_ROUTES,
      listRoute([draftProject({ name: "Draft One" })]),
    ]);

    renderWithProviders(<Projects />, { route: "/projects" });
    const dialog = await openDetail("Draft One");

    expect(
      within(dialog).getByRole("button", { name: /render now/i }),
    ).toBeInTheDocument();
    // Ready-only actions are absent for a draft.
    expect(
      within(dialog).queryByRole("button", { name: /re-render/i }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: /delete project/i }),
    ).toBeEnabled();
    // The draft stage shows the REAL composition preview pointed at this
    // project's composition route (not the generic mock thumbnail). Unsaved copy
    // / param edits ride along as a ?vars= override (the fixture has copy), so
    // assert the route prefix rather than an exact, override-free URL.
    const preview = within(dialog).getByTestId("hf-player");
    expect(preview.getAttribute("data-src")).toMatch(
      /^\/api\/projects\/1\/composition(\?vars=|$)/,
    );
  });

  it("a ready card opens a detail with Download + Re-render", async () => {
    fetchMock = installApiFetchMock([
      ...LAYOUT_ROUTES,
      listRoute([draftProject({ id: 2, name: "Ready One", status: "ready" })]),
    ]);

    renderWithProviders(<Projects />, { route: "/projects" });
    const dialog = await openDetail("Ready One");

    expect(
      within(dialog).getByRole("link", { name: /download mp4/i }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: /re-render/i }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: /share/i }),
    ).toBeInTheDocument();
  });

  it("a rendering card shows the rendering badge and disables delete in the detail", async () => {
    fetchMock = installApiFetchMock([
      ...LAYOUT_ROUTES,
      listRoute([
        draftProject({
          id: 3,
          name: "Rendering One",
          status: "rendering",
          renderProgress: 42,
        }),
      ]),
    ]);

    renderWithProviders(<Projects />, { route: "/projects" });
    // The card shows a "Rendering" status before we open anything (scoped to the
    // grid — the global RenderTray also lists the rendering project by name).
    const grid = await screen.findByTestId("projects-grid");
    expect(within(grid).getByText("Rendering One")).toBeInTheDocument();
    expect(screen.getAllByText(/rendering/i).length).toBeGreaterThan(0);

    const dialog = await openDetail("Rendering One");
    expect(within(dialog).getByText(/42%/)).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: /delete project/i }),
    ).toBeDisabled();
  });
});

describe("Projects — edit copy (draft/failed)", () => {
  it("a draft detail exposes an editable copy form and saves user.* compositionVars", async () => {
    const user = userEvent.setup();
    fetchMock = installApiFetchMock([
      ...LAYOUT_ROUTES,
      listRoute([draftProject({ id: 5, name: "Editable" })]),
      {
        url: "/api/projects/5",
        method: "PATCH",
        status: 200,
        json: draftProject({ id: 5, name: "Editable" }),
      },
      { url: "/api/projects", method: "GET", json: [] },
    ]);

    renderWithProviders(<Projects />, { route: "/projects" });
    const dialog = await openDetail("Editable");

    // The copy is now an editable field seeded with the saved headline — not the
    // read-only "Headline ·" display.
    const headline = within(dialog).getByLabelText(/headline/i);
    expect(headline).toHaveValue("Hi");
    await user.clear(headline);
    await user.type(headline, "New headline");

    await user.click(within(dialog).getByRole("button", { name: /save copy/i }));

    await waitFor(() => {
      const patch = patchCalls().find((c) => /\/api\/projects\/5$/.test(c.url));
      expect(patch).toBeTruthy();
    });
    const patch = patchCalls().find((c) => /\/api\/projects\/5$/.test(c.url));
    const vars = (patch?.body as { compositionVars?: Record<string, string> })
      .compositionVars;
    expect(vars?.["user.headline"]).toBe("New headline");
    // Untouched fields are preserved from the saved copy.
    expect(vars?.["user.ctaText"]).toBe("Go");
  });

  it("‘Edit with AI’ posts the instruction + current copy and applies the result", async () => {
    const user = userEvent.setup();
    fetchMock = installApiFetchMock([
      ...LAYOUT_ROUTES,
      listRoute([draftProject({ id: 6, name: "AiEdit" })]),
      {
        url: "/api/ai/edit",
        method: "POST",
        status: 200,
        json: { headline: "Punchy", bodyText: "Tight.", ctaText: "Go" },
      },
    ]);

    renderWithProviders(<Projects />, { route: "/projects" });
    const dialog = await openDetail("AiEdit");

    await user.type(
      within(dialog).getByPlaceholderText(/make the headline punchier/i),
      "make it punchy",
    );
    await user.click(within(dialog).getByRole("button", { name: /edit with ai/i }));

    // The result is applied to the editable fields (so the user can Save + render).
    await waitFor(() =>
      expect(within(dialog).getByLabelText(/headline/i)).toHaveValue("Punchy"),
    );
    const post = postCalls().find((c) => /\/api\/ai\/edit$/.test(c.url));
    expect(
      (post?.body as { instruction?: string; current?: { ctaText?: string } })
        .instruction,
    ).toBe("make it punchy");
    expect(
      (post?.body as { current?: { ctaText?: string } }).current?.ctaText,
    ).toBe("Go");
  });

  it("a quick-edit chip posts its canned instruction + the current copy", async () => {
    const user = userEvent.setup();
    fetchMock = installApiFetchMock([
      ...LAYOUT_ROUTES,
      listRoute([draftProject({ id: 8, name: "Chips" })]),
      {
        url: "/api/ai/edit",
        method: "POST",
        status: 200,
        json: { headline: "Tighter", bodyText: "Short.", ctaText: "Go" },
      },
    ]);

    renderWithProviders(<Projects />, { route: "/projects" });
    const dialog = await openDetail("Chips");

    // No instruction typed — the chip carries a canned one.
    await user.click(within(dialog).getByRole("button", { name: /^shorter$/i }));

    await waitFor(() =>
      expect(within(dialog).getByLabelText(/headline/i)).toHaveValue("Tighter"),
    );
    const post = postCalls().find((c) => /\/api\/ai\/edit$/.test(c.url));
    expect(
      (post?.body as { instruction?: string }).instruction,
    ).toMatch(/shorter/i);
    expect(
      (post?.body as { current?: { ctaText?: string } }).current?.ctaText,
    ).toBe("Go");
  });
});

describe("Projects — duplicate", () => {
  it("clones the project via POST /projects/:id/duplicate", async () => {
    const user = userEvent.setup();
    fetchMock = installApiFetchMock([
      ...LAYOUT_ROUTES,
      listRoute([draftProject({ id: 4, name: "Original" })]),
      {
        url: /\/projects\/4\/duplicate$/,
        method: "POST",
        status: 201,
        json: draftProject({ id: 5, name: "Original (copy)" }),
      },
    ]);

    renderWithProviders(<Projects />, { route: "/projects" });
    const dialog = await openDetail("Original");

    await user.click(within(dialog).getByRole("button", { name: /duplicate/i }));

    await waitFor(() => {
      const post = postCalls().find((c) =>
        /\/projects\/4\/duplicate$/.test(c.url),
      );
      expect(post).toBeTruthy();
    });
  });
});

describe("Projects — rename", () => {
  it("renames via PATCH /projects/:id with the new name", async () => {
    const user = userEvent.setup();
    fetchMock = installApiFetchMock([
      ...LAYOUT_ROUTES,
      listRoute([draftProject({ id: 3, name: "Old Name" })]),
      {
        url: /\/api\/projects\/3$/,
        method: "PATCH",
        status: 200,
        json: draftProject({ id: 3, name: "New Name" }),
      },
    ]);

    renderWithProviders(<Projects />, { route: "/projects" });
    const dialog = await openDetail("Old Name");

    await user.click(
      within(dialog).getByRole("button", { name: /rename project/i }),
    );
    const input = within(dialog).getByLabelText(/project name/i);
    await user.clear(input);
    await user.type(input, "New Name");
    await user.click(within(dialog).getByRole("button", { name: /save name/i }));

    await waitFor(() => {
      const patch = patchCalls().find((c) => /\/api\/projects\/3$/.test(c.url));
      expect(patch).toBeTruthy();
    });
    const patch = patchCalls().find((c) => /\/api\/projects\/3$/.test(c.url));
    expect((patch?.body as { name?: string }).name).toBe("New Name");
  });
});

describe("Projects — delete confirmation AlertDialog", () => {
  it("opens the confirm dialog on trash, and only the Delete confirm fires DELETE", async () => {
    const user = userEvent.setup();
    fetchMock = installApiFetchMock([
      ...LAYOUT_ROUTES,
      listRoute([draftProject({ id: 7, name: "Doomed" })]),
      { url: "/api/projects/7", method: "DELETE", status: 204, json: {} },
      { url: "/api/projects", method: "GET", json: [] },
    ]);

    renderWithProviders(<Projects />, { route: "/projects" });
    const dialog = await openDetail("Doomed");

    // Trash only arms the AlertDialog — no DELETE yet.
    await user.click(
      within(dialog).getByRole("button", { name: /delete project/i }),
    );
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText(/can.t be undone/i)).toBeInTheDocument();
    expect(deleteCalls()).toHaveLength(0);

    await user.click(within(confirm).getByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(deleteCalls()).toHaveLength(1));
    expect(deleteCalls()[0]?.url).toMatch(/\/api\/projects\/7$/);
  });

  it("Cancel dismisses the confirm WITHOUT issuing a DELETE", async () => {
    const user = userEvent.setup();
    fetchMock = installApiFetchMock([
      ...LAYOUT_ROUTES,
      listRoute([draftProject({ id: 9, name: "Spared" })]),
      { url: "/api/projects/9", method: "DELETE", status: 204, json: {} },
    ]);

    renderWithProviders(<Projects />, { route: "/projects" });
    const dialog = await openDetail("Spared");

    await user.click(
      within(dialog).getByRole("button", { name: /delete project/i }),
    );
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: /cancel/i }));

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    expect(deleteCalls()).toHaveLength(0);
  });
});

/** All DELETE calls captured by the active fetch mock. */
function deleteCalls(): Array<{ url: string }> {
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
      return method === "DELETE";
    })
    .map((args) => ({
      url:
        typeof args[0] === "string"
          ? (args[0] as string)
          : (args[0] as Request).url,
    }));
}

/** All calls for a given method, with the JSON request body parsed (if any). */
function requestsOf(method: string): Array<{ url: string; body: unknown }> {
  const calls = fetchMock?.mock.mock.calls ?? [];
  return calls
    .filter((args) => {
      const init = args[1] as RequestInit | undefined;
      const input = args[0] as RequestInfo | URL;
      const m = (
        init?.method ??
        (typeof input === "object" && "method" in input
          ? (input as Request).method
          : "GET")
      ).toUpperCase();
      return m === method.toUpperCase();
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

const patchCalls = () => requestsOf("PATCH");
const postCalls = () => requestsOf("POST");

/** A website→video showcase draft (no user.* copy; carries a capture). */
function w2vProject(over: Record<string, unknown> = {}) {
  return draftProject({
    id: 9,
    name: "Site Video",
    module: "website-showcase",
    compositionVars: {
      "capture.image": "data:image/jpeg;base64,AAAA",
      "capture.height": "4000",
      "capture.url": "https://acme.test",
      "capture.title": "Acme",
      duration: "38",
    },
    ...over,
  });
}

/** Decode the HfPlayer's `?vars=` override (UTF-8-safe base64, see b64UrlVars). */
function decodePreviewVars(src: string): Record<string, string> {
  const m = src.match(/[?&]vars=([^&]+)/);
  if (!m) return {};
  const bin = atob(decodeURIComponent(m[1]));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

describe("Projects — refine (website→video, no regenerate)", () => {
  it("‘Düzelt’ posts the instruction and rides the result into the live preview", async () => {
    const user = userEvent.setup();
    fetchMock = installApiFetchMock([
      ...LAYOUT_ROUTES,
      listRoute([w2vProject()]),
      {
        url: "/api/projects/9/refine",
        method: "POST",
        status: 200,
        json: {
          vars: {
            duration: "20",
            "capture.cropX": "0",
            "capture.cropY": "0",
            "capture.cropW": "1",
            "capture.cropH": "0.2",
          },
          note: "Süreyi 20 saniyeye indirdim ve hero'ya odakladım.",
        },
      },
    ]);

    renderWithProviders(<Projects />, { route: "/projects" });
    const dialog = await openDetail("Site Video");

    await user.type(
      within(dialog).getByPlaceholderText(/videoyu kısalt/i),
      "kısalt ve hero'ya odakla",
    );
    await user.click(within(dialog).getByRole("button", { name: /^düzelt$/i }));

    // The model's note is shown to the user.
    await waitFor(() =>
      expect(
        within(dialog).getByText(/hero'ya odakladım/i),
      ).toBeInTheDocument(),
    );

    // The instruction was posted to the project's refine endpoint.
    const post = postCalls().find((c) =>
      /\/api\/projects\/9\/refine$/.test(c.url),
    );
    expect((post?.body as { instruction?: string }).instruction).toBe(
      "kısalt ve hero'ya odakla",
    );

    // The returned vars ride into the live preview's ?vars= override — no render.
    const src = within(dialog)
      .getByTestId("hf-player")
      .getAttribute("data-src")!;
    const vars = decodePreviewVars(src);
    expect(vars.duration).toBe("20");
    expect(vars["capture.cropH"]).toBe("0.2");

    // A Save button appears now that there's a pending refine to persist.
    expect(
      within(dialog).getByRole("button", { name: /^kaydet$/i }),
    ).toBeInTheDocument();
  });

  it("does not show the refine box for a non-website-showcase project", async () => {
    fetchMock = installApiFetchMock([
      ...LAYOUT_ROUTES,
      listRoute([draftProject({ id: 3, name: "Studio One", module: "studio" })]),
    ]);
    renderWithProviders(<Projects />, { route: "/projects" });
    const dialog = await openDetail("Studio One");
    expect(
      within(dialog).queryByText(/prompt ile düzelt/i),
    ).not.toBeInTheDocument();
  });
});
