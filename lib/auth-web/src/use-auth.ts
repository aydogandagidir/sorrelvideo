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
  /** Navigate to the frontend /login page (e.g. for protected route gates). */
  login: () => void;
  /** Submit credentials to the password login endpoint. */
  loginWithPassword: (input: LoginInput) => Promise<AuthUser>;
  /** Submit a signup payload and create a new account + session. */
  signup: (input: SignupInput) => Promise<AuthUser>;
  /** Clear the session on the server and reset local state. */
  logout: () => Promise<void>;
  /** Re-fetch the current user (useful after auth-state mutations). */
  refresh: () => Promise<void>;
}

interface AuthEnvelope {
  user: AuthUser | null;
}

async function readEnvelope(res: Response): Promise<AuthEnvelope> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: string }
      | null;
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

  const login = useCallback(() => {
    window.location.href = "/login";
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

  const signup = useCallback(
    async (input: SignupInput): Promise<AuthUser> => {
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
    },
    [],
  );

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

  return {
    user,
    isLoading,
    isAuthenticated: !!user,
    login,
    loginWithPassword,
    signup,
    logout,
    refresh,
  };
}
