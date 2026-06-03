import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useAuth } from "./use-auth";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useAuth — hydration", () => {
  it("starts in a loading state, then hydrates the user from /api/auth/user", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        user: {
          id: "u_1",
          email: "a@example.com",
          firstName: "Ada",
          lastName: null,
          profileImageUrl: null,
        },
      }),
    });

    const { result } = renderHook(() => useAuth());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.user).toBeNull();

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user?.email).toBe("a@example.com");
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/user", {
      credentials: "include",
    });
  });

  it("treats a failed fetch as an anonymous user", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"));

    const { result } = renderHook(() => useAuth());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.user).toBeNull();
  });
});

describe("useAuth — login (returnTo)", () => {
  const originalLocation = window.location;

  function stubLocation(initial: {
    pathname?: string;
    search?: string;
    hash?: string;
  }): { current: string } {
    const ref = { current: "" };
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        pathname: initial.pathname ?? "/",
        search: initial.search ?? "",
        hash: initial.hash ?? "",
        set href(value: string) {
          ref.current = value;
        },
        get href() {
          return ref.current;
        },
      },
    });
    return ref;
  }

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  async function mountAnonymous() {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ user: null }) });
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    return result;
  }

  it("forwards an explicit local returnTo as a query param", async () => {
    const href = stubLocation({ pathname: "/pricing" });
    const result = await mountAnonymous();

    result.current.login("/studio?tab=ai");

    expect(href.current).toBe("/login?returnTo=%2Fstudio%3Ftab%3Dai");
  });

  it("captures the current path (incl. search + hash) when no arg is given", async () => {
    const href = stubLocation({
      pathname: "/projects",
      search: "?sort=new",
      hash: "#row-3",
    });
    const result = await mountAnonymous();

    result.current.login();

    expect(href.current).toBe(
      "/login?returnTo=%2Fprojects%3Fsort%3Dnew%23row-3",
    );
  });

  it("omits returnTo for the /dashboard default and for /login itself", async () => {
    const href = stubLocation({ pathname: "/dashboard" });
    const result = await mountAnonymous();

    result.current.login();
    expect(href.current).toBe("/login");

    result.current.login("/login?returnTo=%2Fstudio");
    expect(href.current).toBe("/login");
  });

  it("rejects non-local (absolute / protocol-relative) targets", async () => {
    const href = stubLocation({ pathname: "/studio" });
    const result = await mountAnonymous();

    result.current.login("https://evil.example.com");
    expect(href.current).toBe("/login");

    result.current.login("//evil.example.com");
    expect(href.current).toBe("/login");
  });
});

describe("useAuth — loginWithPassword", () => {
  it("posts credentials and updates the user on success", async () => {
    // 1) initial hydration call → anonymous
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ user: null }),
    });
    // 2) login call → returns user
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        user: {
          id: "u_2",
          email: "b@example.com",
          firstName: null,
          lastName: null,
          profileImageUrl: null,
        },
      }),
    });

    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const user = await result.current.loginWithPassword({
      email: "b@example.com",
      password: "secret123!",
    });

    expect(user.id).toBe("u_2");
    await waitFor(() => expect(result.current.user?.id).toBe("u_2"));

    const loginCall = fetchMock.mock.calls[1];
    expect(loginCall[0]).toBe("/api/auth/login");
    expect((loginCall[1] as RequestInit).method).toBe("POST");
  });

  it("throws when the login endpoint returns an error", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ user: null }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: "Email or password is incorrect" }),
    });

    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await expect(
      result.current.loginWithPassword({ email: "x@y.com", password: "bad" }),
    ).rejects.toThrow(/incorrect/);
  });
});
