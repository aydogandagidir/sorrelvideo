import { Github } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

type OAuthProvider = "github" | "google";

/**
 * Continue-with-provider buttons rendered above the email/password form on
 * login + signup. Only providers the backend has actually configured (client
 * id + secret present) are shown — the SPA learns which from
 * GET /api/auth/oauth/providers. If none are configured the whole block
 * (buttons + "or continue with email" divider) renders nothing, so the email
 * form stands alone instead of dangling a divider over buttons that full-page
 * navigate to a raw 503 JSON error.
 *
 * Each button navigates to the backend, which redirects to the provider and
 * then back to /api/auth/oauth/<provider>/callback.
 */
export function OAuthButtons() {
  const [providers, setProviders] = useState<OAuthProvider[] | null>(null);

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
      .catch(() => {
        if (active) setProviders([]);
      });
    return () => {
      active = false;
    };
  }, []);

  // Unknown (still loading) or none configured → render nothing.
  if (!providers || providers.length === 0) return null;

  return (
    <div className="space-y-2">
      {providers.includes("github") && (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => {
            window.location.href = "/api/auth/oauth/github";
          }}
        >
          <Github className="h-4 w-4" />
          Continue with GitHub
        </Button>
      )}
      {providers.includes("google") && (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => {
            window.location.href = "/api/auth/oauth/google";
          }}
        >
          <GoogleIcon className="h-4 w-4" />
          Continue with Google
        </Button>
      )}
      <div className="relative my-2">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-card px-2 text-muted-foreground">
            or continue with email
          </span>
        </div>
      </div>
    </div>
  );
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
