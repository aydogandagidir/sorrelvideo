import { Link } from "wouter";
import { ArrowRight, Video } from "lucide-react";
import { useAuth } from "@workspace/auth-web";

/**
 * Shared top bar for the PUBLIC marketing surfaces (landing + pricing). Extracted
 * so the two pages can't drift, and — critically for the conversion funnel — so a
 * first-time visitor always has an explicit "Sign up free" path. Returning,
 * already-authenticated visitors instead see "Open App" → /dashboard.
 */
export function MarketingHeader({
  active,
}: {
  active?: "features" | "pricing";
}) {
  const { isAuthenticated } = useAuth();
  const navLink = (current: boolean) =>
    current
      ? "text-foreground font-semibold"
      : "text-muted-foreground hover:text-foreground transition-colors";
  return (
    <header className="fixed top-0 z-50 w-full border-b bg-background/80 backdrop-blur-md">
      <div className="container mx-auto flex h-16 items-center justify-between px-4">
        <Link
          href="/"
          className="flex items-center gap-2 font-bold text-lg tracking-tight"
        >
          <Video className="h-5 w-5 text-primary" />
          <span>Sorrel</span>
        </Link>

        <nav className="hidden md:flex gap-6 text-sm font-medium">
          {/* Plain anchor: works as an in-page scroll on "/" and a cross-page jump
              from /pricing without depending on wouter hash handling. */}
          <a href="/#features" className={navLink(active === "features")}>
            Features
          </a>
          <Link href="/pricing" className={navLink(active === "pricing")}>
            Pricing
          </Link>
        </nav>

        <div className="flex items-center gap-1.5 sm:gap-2">
          {isAuthenticated ? (
            <Link
              href="/dashboard"
              className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Open App <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          ) : (
            <>
              <Link
                href="/login"
                className="hidden sm:inline-flex h-9 items-center justify-center rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                Log in
              </Link>
              <Link
                href="/signup"
                className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Sign up free
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
