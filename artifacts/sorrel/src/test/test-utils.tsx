/**
 * Shared rendering + fetch-mock helpers for the `sorrel` (jsdom) vitest project.
 *
 * The SPA leans on three ambient providers almost everywhere: a TanStack Query
 * client (data hooks), a Wouter `Router` (anything that calls `useLocation` /
 * renders a `<Link>`), and a Radix `TooltipProvider` (several Shadcn controls
 * mount a `Tooltip` and throw outside a provider). `renderWithProviders` wires
 * all three so a component test can mount a single unit without reconstructing
 * `App.tsx`.
 *
 * `installFetchMock` is the network boundary: we mock `fetch`, never component
 * internals, so the tests exercise the real hook/render code paths.
 */
import { type ReactElement, type ReactNode } from "react";
import { vi } from "vitest";
import {
  render,
  type RenderOptions,
  type RenderResult,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * A QueryClient tuned for tests: retries OFF (so an error path resolves on the
 * first attempt instead of hanging the test through back-off) and no refetch on
 * window focus.
 */
export function makeTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

export interface RenderWithProvidersOptions extends Omit<
  RenderOptions,
  "wrapper"
> {
  /** Initial Wouter path. Defaults to "/". */
  route?: string;
  /** Reuse an existing client (e.g. to pre-seed the cache); otherwise a fresh one. */
  queryClient?: QueryClient;
}

export interface RenderWithProvidersResult extends RenderResult {
  queryClient: QueryClient;
}

/**
 * Render `ui` inside the QueryClient + Wouter Router + Tooltip providers.
 * Returns Testing Library's result plus the `queryClient` used.
 */
export function renderWithProviders(
  ui: ReactElement,
  {
    route = "/",
    queryClient,
    ...renderOptions
  }: RenderWithProvidersOptions = {},
): RenderWithProvidersResult {
  const client = queryClient ?? makeTestQueryClient();
  const { hook } = memoryLocation({ path: route });

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <Router hook={hook}>
          <TooltipProvider>{children}</TooltipProvider>
        </Router>
      </QueryClientProvider>
    );
  }

  return {
    queryClient: client,
    ...render(ui, { wrapper: Wrapper, ...renderOptions }),
  };
}

/** A single matcher → response rule for {@link installFetchMock}. */
export interface FetchRoute {
  /** Substring or RegExp matched against the request URL. */
  url: string | RegExp;
  /** HTTP status to return. Defaults to 200. */
  status?: number;
  /** JSON body to return from `res.json()`. Defaults to `{}`. */
  json?: unknown;
}

export interface FetchMockHandle {
  /** The `vi.fn()` standing in for global `fetch`. */
  mock: ReturnType<typeof vi.fn>;
  /** Restore the original global `fetch`. */
  restore: () => void;
}

/**
 * Install a `fetch` mock that resolves each call against `routes` (first match
 * by declaration order). Unmatched URLs resolve to a 404 so a missing stub
 * surfaces loudly rather than hanging. The returned `Response`-like object only
 * implements the surface the app actually reads (`ok`, `status`, `json()`),
 * which is all `fetch`-based hooks here touch.
 */
export function installFetchMock(routes: FetchRoute[] = []): FetchMockHandle {
  const mock = vi.fn((input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    const route = routes.find((r) =>
      typeof r.url === "string" ? url.includes(r.url) : r.url.test(url),
    );

    const status = route?.status ?? (route ? 200 : 404);
    const body = route?.json ?? {};

    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response);
  });

  vi.stubGlobal("fetch", mock);

  return {
    mock,
    restore: () => vi.unstubAllGlobals(),
  };
}

/**
 * A single matcher → response rule for {@link installApiFetchMock}. Adds an
 * optional `method` to {@link FetchRoute} so two handlers that share a path
 * (e.g. `GET /api/projects/:id` vs `DELETE /api/projects/:id`) can be told
 * apart by the request method.
 */
export interface ApiFetchRoute extends FetchRoute {
  /** Optional HTTP method to match (case-insensitive). Omit to match any. */
  method?: string;
}

/**
 * Like {@link installFetchMock}, but resolves each call to a REAL `Response`
 * object (`{ "content-type": "application/json" }`) instead of a hand-rolled
 * `{ ok, status, json }` stub.
 *
 * The generated Orval hooks (`@workspace/api-client-react`) go through
 * `customFetch`, which reads `response.text()`, `response.headers`, and
 * `response.body` — none of which the lightweight `installFetchMock` stub
 * implements. Page tests that exercise those hooks need this richer mock; it
 * works equally well for the plain-`fetch` billing/auth hooks, so a page that
 * mixes both (e.g. a `Layout`-wrapped page) can use a single handle.
 *
 * Unmatched URLs resolve to a JSON 404 so a missing stub surfaces loudly. The
 * `mock` is a `vi.fn()` so callers can assert on `fetch` call args (URL +
 * method) — the delete-confirmation flow leans on this.
 */
export function installApiFetchMock(
  routes: ApiFetchRoute[] = [],
): FetchMockHandle {
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (
      init?.method ??
      (typeof input === "object" && "method" in input ? input.method : "GET")
    ).toUpperCase();

    const route = routes.find((r) => {
      const urlMatch =
        typeof r.url === "string" ? url.includes(r.url) : r.url.test(url);
      const methodMatch = !r.method || r.method.toUpperCase() === method;
      return urlMatch && methodMatch;
    });

    const status = route?.status ?? (route ? 200 : 404);
    const body = route ? (route.json ?? {}) : { error: `No stub for ${url}` };

    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  vi.stubGlobal("fetch", mock);

  return {
    mock,
    restore: () => vi.unstubAllGlobals(),
  };
}
