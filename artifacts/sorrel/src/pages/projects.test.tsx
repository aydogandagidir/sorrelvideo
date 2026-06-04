/**
 * Projects page — the paid-path surface that matters here is the project list's
 * data-driven states (loading skeleton / error alert / empty CTA) and, per
 * card, the status → controls mapping (a draft renders, a ready card watches, a
 * rendering card locks the destructive action). The headline new behavior is
 * the delete-confirmation AlertDialog: the trash button must only *arm* the
 * dialog, and only the explicit "Delete" confirm may fire the DELETE — Cancel
 * must not. We mock at the fetch boundary (real Responses, so the generated
 * `useListProjects` / `useDeleteProject` hooks run for real through
 * `customFetch`) and assert on the actual request the mutation issues.
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

/** A draft project (rendered with the Render + Delete + Studio controls). */
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...over,
  };
}

/** Common no-op stubs for the ambient Layout fetches (auth + billing). */
const LAYOUT_ROUTES: ApiFetchRoute[] = [
  { url: "/api/auth/user", json: { user: null } },
  { url: "/api/billing/me", status: 500, json: {} },
];

function listRoute(projects: unknown[]): ApiFetchRoute {
  return { url: "/api/projects", method: "GET", json: projects };
}

describe("Projects — list states", () => {
  it("shows the skeleton loaders while the project list is loading", () => {
    // Never-resolving fetch → the query stays in its loading state.
    fetchMock = installApiFetchMock([]);
    fetchMock.mock.mockImplementation(() => new Promise(() => {}));

    const { container } = renderWithProviders(<Projects />);

    // The skeleton cards use the `animate-pulse` utility from <Skeleton>.
    expect(
      container.querySelectorAll(".animate-pulse").length,
    ).toBeGreaterThan(0);
    // And no empty-state CTA yet.
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
      expect(
        screen.getByText(/failed to load projects/i),
      ).toBeInTheDocument(),
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

describe("Projects — card status → controls", () => {
  it("a draft card offers Render and an enabled delete control", async () => {
    fetchMock = installApiFetchMock([
      ...LAYOUT_ROUTES,
      listRoute([draftProject({ name: "Draft One" })]),
    ]);

    renderWithProviders(<Projects />);

    await waitFor(() =>
      expect(screen.getByText("Draft One")).toBeInTheDocument(),
    );
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Render" })).toBeInTheDocument();
    // Watch is only for ready projects.
    expect(
      screen.queryByRole("button", { name: /watch/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /delete draft one/i }),
    ).toBeEnabled();
  });

  it("a ready card offers Watch + Re-render", async () => {
    fetchMock = installApiFetchMock([
      ...LAYOUT_ROUTES,
      listRoute([
        draftProject({ id: 2, name: "Ready One", status: "ready" }),
      ]),
    ]);

    renderWithProviders(<Projects />);

    await waitFor(() =>
      expect(screen.getByText("Ready One")).toBeInTheDocument(),
    );
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /watch/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /re-render/i }),
    ).toBeInTheDocument();
    // No plain "Render" (that's draft-only).
    expect(
      screen.queryByRole("button", { name: "Render" }),
    ).not.toBeInTheDocument();
  });

  it("a rendering card shows the rendering badge and disables delete", async () => {
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

    await waitFor(() =>
      expect(screen.getByText("Rendering One")).toBeInTheDocument(),
    );
    // The status badge text ("Rendering…") appears; the in-thumbnail overlay
    // uses the same copy, so there is more than one match — assert ≥ 1.
    expect(screen.getAllByText(/rendering/i).length).toBeGreaterThan(0);
    // Determinate progress percentage from renderProgress.
    expect(screen.getByText("42%")).toBeInTheDocument();
    // Destructive delete is disabled mid-render (can't pull the rug out).
    expect(
      screen.getByRole("button", { name: /delete rendering one/i }),
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
      // The post-delete invalidation re-fetches the (now empty) list.
      { url: "/api/projects", method: "GET", json: [] },
    ]);

    renderWithProviders(<Projects />);
    await waitFor(() => expect(screen.getByText("Doomed")).toBeInTheDocument());

    // Trash button only arms the dialog — no DELETE yet.
    await user.click(screen.getByRole("button", { name: /delete doomed/i }));

    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/can.t be undone/i),
    ).toBeInTheDocument();
    expect(deleteCalls()).toHaveLength(0);

    // Confirm → the DELETE for project 7 fires exactly once.
    await user.click(within(dialog).getByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(deleteCalls()).toHaveLength(1));
    expect(deleteCalls()[0]?.url).toMatch(/\/api\/projects\/7$/);
  });

  it("Cancel dismisses the dialog WITHOUT issuing a DELETE", async () => {
    const user = userEvent.setup();
    fetchMock = installApiFetchMock([
      ...LAYOUT_ROUTES,
      listRoute([draftProject({ id: 9, name: "Spared" })]),
      { url: "/api/projects/9", method: "DELETE", status: 204, json: {} },
    ]);

    renderWithProviders(<Projects />);
    await waitFor(() => expect(screen.getByText("Spared")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /delete spared/i }));
    const dialog = await screen.findByRole("alertdialog");

    await user.click(within(dialog).getByRole("button", { name: /cancel/i }));

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    // Crucially: no DELETE was ever issued.
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
