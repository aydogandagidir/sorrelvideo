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
import { afterEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Projects from "./projects";
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

/** Open a project's detail modal by clicking its card (by project name). */
async function openDetail(name: string) {
  const user = userEvent.setup();
  await waitFor(() => expect(screen.getByText(name)).toBeInTheDocument());
  await user.click(screen.getByText(name));
  return screen.findByRole("dialog");
}

describe("Projects — list states", () => {
  it("shows the skeleton loaders while the project list is loading", () => {
    fetchMock = installApiFetchMock([]);
    fetchMock.mock.mockImplementation(() => new Promise(() => {}));

    const { container } = renderWithProviders(<Projects />);

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

    renderWithProviders(<Projects />);

    await waitFor(() =>
      expect(screen.getByText(/failed to load projects/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("renders the empty-state CTA when there are no projects", async () => {
    fetchMock = installApiFetchMock([...LAYOUT_ROUTES, listRoute([])]);

    renderWithProviders(<Projects />);

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

describe("Projects — card → detail controls", () => {
  it("a draft card opens a detail with Render + an enabled delete control", async () => {
    fetchMock = installApiFetchMock([
      ...LAYOUT_ROUTES,
      listRoute([draftProject({ name: "Draft One" })]),
    ]);

    renderWithProviders(<Projects />);
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
  });

  it("a ready card opens a detail with Download + Re-render", async () => {
    fetchMock = installApiFetchMock([
      ...LAYOUT_ROUTES,
      listRoute([draftProject({ id: 2, name: "Ready One", status: "ready" })]),
    ]);

    renderWithProviders(<Projects />);
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

    renderWithProviders(<Projects />);
    // The card shows a "Rendering" status before we open anything.
    await waitFor(() =>
      expect(screen.getByText("Rendering One")).toBeInTheDocument(),
    );
    expect(screen.getAllByText(/rendering/i).length).toBeGreaterThan(0);

    const dialog = await openDetail("Rendering One");
    expect(within(dialog).getByText(/42%/)).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: /delete project/i }),
    ).toBeDisabled();
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

    renderWithProviders(<Projects />);
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

    renderWithProviders(<Projects />);
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
