import { useCallback, useEffect, useState } from "react";
import type { AuthUser } from "@workspace/api-client-react";

export type { AuthUser };

export interface SignupInput {
  email: string;
  password: string;
  firstName?: string | null;
  lastName?: string | null;
}

export interface LoginInput {
  email: string;
  password: string;
}

interface AuthState {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  /**
   * Navigate to the frontend /login page (e.g. for protected route gates),
   * preserving where to return after a successful sign-in. Pass an explicit
   * local path, or omit it to capture the current location. Non-local targets
   * are ignored (open-redirect guard).
   */
  login: (returnTo?: string) => void;
  /** Submit credentials to the password login endpoint. */
  loginWithPassword: (input: LoginInput) => Promise<AuthUser>;
  /** Submit a signup payload and create a new account + session. */
  signup: (input: SignupInput) => Promise<AuthUser>;
  /** Clear the session on the server and reset local state. */
  logout: () => Promise<void>;
  /** Re-fetch the current user (useful after auth-state mutations). */
  refresh: () => Promise<void>;
  /** Request a password-reset email. Always resolves (generic response). */
  requestPasswordReset: (email: string) => Promise<void>;
  /** Consume a reset token and set a new password. */
  resetPassword: (input: { token: string; password: string }) => Promise<void>;
  /** Re-send the email-verification link for an account. */
  resendVerification: (email: string) => Promise<void>;
}

interface AuthEnvelope {
  user: AuthUser | null;
}

async function readEnvelope(res: Response): Promise<AuthEnvelope> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as AuthEnvelope;
}

export function useAuth(): AuthState {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/auth/user", { credentials: "include" });
      const envelope = (await res.json()) as AuthEnvelope;
      setUser(envelope.user ?? null);
    } catch {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    refresh().catch(() => {
      if (!cancelled) setUser(null);
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const login = useCallback((returnTo?: string) => {
    const target =
      returnTo ??
      `${window.location.pathname}${window.location.search}${window.location.hash}`;
    // Only forward genuine same-origin paths; never reflect an absolute URL or
    // protocol-relative ("//host") target into returnTo (open-redirect guard).
    const safe =
      target.startsWith("/") && !target.startsWith("//") ? target : null;
    // Avoid bouncing /login → /login (would lose the real returnTo on the
    // second hop) and skip a redundant returnTo=/dashboard (login's default).
    const redirect =
      safe && safe !== "/dashboard" && !safe.startsWith("/login")
        ? `/login?returnTo=${encodeURIComponent(safe)}`
        : "/login";
    window.location.href = redirect;
  }, []);

  const loginWithPassword = useCallback(
    async (input: LoginInput): Promise<AuthUser> => {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const envelope = await readEnvelope(res);
      if (!envelope.user) throw new Error("Login succeeded without a user");
      setUser(envelope.user);
      return envelope.user;
    },
    [],
  );

  const signup = useCallback(async (input: SignupInput): Promise<AuthUser> => {
    const res = await fetch("/api/auth/signup", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const envelope = await readEnvelope(res);
    if (!envelope.user) throw new Error("Signup succeeded without a user");
    setUser(envelope.user);
    return envelope.user;
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
    } finally {
      setUser(null);
      window.location.href = "/";
    }
  }, []);

  const requestPasswordReset = useCallback(
    async (email: string): Promise<void> => {
      // Server always returns 200; we treat HTTP errors as failures regardless.
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    [],
  );

  const resetPassword = useCallback(
    async (input: { token: string; password: string }): Promise<void> => {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
    },
    [],
  );

  const resendVerification = useCallback(
    async (email: string): Promise<void> => {
      const res = await fetch("/api/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    [],
  );

  return {
    user,
    isLoading,
    isAuthenticated: !!user,
    login,
    loginWithPassword,
    signup,
    logout,
    refresh,
    requestPasswordReset,
    resetPassword,
    resendVerification,
  };
}
