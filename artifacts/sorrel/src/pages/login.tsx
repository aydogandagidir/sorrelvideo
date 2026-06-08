import { useState, useEffect, type FormEvent } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { Loader2, Github } from "lucide-react";
import { useAuth } from "@workspace/auth-web";
import { cn } from "@/lib/utils";
import loginBg from "@/assets/login-bg.jpg";

type OAuthProvider = "github" | "google";

function getReturnTo(search: string): string {
  const params = new URLSearchParams(search);
  const value = params.get("returnTo");
  if (!value || !value.startsWith("/") || value.startsWith("//"))
    return "/dashboard";
  return value;
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.75h3.57c2.08-1.92 3.28-4.74 3.28-8.07z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.75c-.99.66-2.26 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.99 10.99 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
        fill="#EA4335"
      />
    </svg>
  );
}

/** A premium glass OAuth tile (real provider; bounces through the backend). */
function OAuthTile({ provider }: { provider: OAuthProvider }) {
  return (
    <button
      type="button"
      aria-label={`Continue with ${provider === "google" ? "Google" : "GitHub"}`}
      onClick={() => {
        window.location.href = `/api/auth/oauth/${provider}`;
      }}
      className="flex items-center justify-center rounded-md border border-border bg-white/5 px-4 py-2.5 transition-all hover:border-primary/50 hover:bg-white/10 hover:shadow-[0_0_10px_hsl(var(--primary)/0.2)]"
    >
      {provider === "google" ? (
        <GoogleIcon className="h-5 w-5" />
      ) : (
        <Github className="h-5 w-5" />
      )}
    </button>
  );
}

export default function LoginPage() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const returnTo = getReturnTo(search);
  const { loginWithPassword } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Only providers the backend has actually configured are shown (same source
  // of truth as the shared OAuthButtons): GET /api/auth/oauth/providers.
  const [providers, setProviders] = useState<OAuthProvider[]>([]);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/oauth/providers", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : { providers: [] }))
      .then((data: { providers?: unknown }) => {
        if (!active) return;
        setProviders(
          Array.isArray(data.providers)
            ? data.providers.filter(
                (p): p is OAuthProvider => p === "github" || p === "google",
              )
            : [],
        );
      })
      .catch(() => active && setProviders([]));
    return () => {
      active = false;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await loginWithPassword({ email: email.trim(), password });
      setLocation(returnTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  }

  const inputClass =
    "w-full rounded-md border border-border bg-black/40 px-4 py-3 text-sm text-foreground outline-none transition-all duration-300 placeholder:text-muted-foreground/60 focus:border-primary focus:shadow-[0_0_12px_hsl(var(--primary)/0.2)]";

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-black text-foreground">
      {/* Background: blurred 3D tech graphic + dim overlay + drifting accent glows. */}
      <div
        className="fixed inset-0 z-[-2] bg-cover bg-center"
        style={{ backgroundImage: `url(${loginBg})`, filter: "blur(8px) brightness(0.4)" }}
        aria-hidden="true"
      />
      <div
        className="fixed inset-0 z-[-1] bg-background/50 backdrop-blur-sm"
        aria-hidden="true"
      />
      <div className="login-glow login-glow-tl" aria-hidden="true" />
      <div className="login-glow login-glow-br" aria-hidden="true" />

      {/* Header */}
      <header className="relative z-10 w-full backdrop-blur-md">
        <div className="mx-auto flex max-w-[1280px] items-center px-6 py-4">
          <Link
            href="/"
            className="text-xl font-bold tracking-tight"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Sorrel
          </Link>
        </div>
      </header>

      {/* Card */}
      <main className="relative z-10 flex flex-1 items-center justify-center p-6">
        <div
          className="w-full max-w-md rounded-xl border border-white/10 bg-white/[0.03] p-8 shadow-[0_8px_32px_rgba(0,0,0,0.5)] backdrop-blur-2xl"
          style={{ animation: "loginRise 0.8s cubic-bezier(0.16,1,0.3,1) both" }}
        >
          <div className="mb-8 text-center">
            <h1
              className="text-2xl font-semibold tracking-tight"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Welcome back
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Sign in to your account
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5" noValidate>
            <div className="space-y-2">
              <label
                htmlFor="email"
                className="block text-xs font-semibold tracking-wide"
              >
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                placeholder="name@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                className={inputClass}
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label htmlFor="password" className="text-xs font-semibold tracking-wide">
                  Password
                </label>
                <Link
                  href="/forgot-password"
                  className="text-xs text-muted-foreground transition-colors hover:text-primary"
                >
                  Forgot password?
                </Link>
              </div>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
                className={inputClass}
              />
            </div>
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={submitting}
              className="login-cta mt-1 flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-3 font-bold text-primary-foreground transition-all duration-300 hover:brightness-95 disabled:opacity-70"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Signing in…
                </>
              ) : (
                "Sign in"
              )}
            </button>
          </form>

          {providers.length > 0 && (
            <div className="mt-8">
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center">
                  <span className="px-2 text-xs text-muted-foreground">
                    Or continue with
                  </span>
                </div>
              </div>
              <div
                className={cn(
                  "mt-6 grid gap-4",
                  providers.length === 1 ? "grid-cols-1" : "grid-cols-2",
                )}
              >
                {providers.includes("google") && <OAuthTile provider="google" />}
                {providers.includes("github") && <OAuthTile provider="github" />}
              </div>
            </div>
          )}

          <p className="mt-8 text-center text-sm text-muted-foreground">
            Don&apos;t have an account?{" "}
            <Link
              href="/signup"
              className="font-semibold text-foreground transition-colors hover:text-primary"
            >
              Sign up
            </Link>
          </p>
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 mt-auto w-full border-t border-border bg-background/50 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1280px] flex-col items-center justify-between gap-4 px-6 py-7 md:flex-row">
          <span
            className="text-base font-semibold"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Sorrel
          </span>
          <div className="flex gap-6 text-xs text-muted-foreground">
            <Link href="/privacy" className="transition-colors hover:text-primary">
              Privacy Policy
            </Link>
            <Link href="/terms" className="transition-colors hover:text-primary">
              Terms of Service
            </Link>
            <a
              href="mailto:hello@sorrel.video"
              className="transition-colors hover:text-primary"
            >
              Contact
            </a>
          </div>
          <span className="text-xs text-muted-foreground">
            © 2026 Sorrel Technologies. All rights reserved.
          </span>
        </div>
      </footer>
    </div>
  );
}
