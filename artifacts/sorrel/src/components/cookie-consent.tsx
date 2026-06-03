import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Cookie } from "lucide-react";
import { Button } from "@/components/ui/button";

const STORAGE_KEY = "sorrel.cookieConsent";

function readDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "dismissed";
  } catch {
    // localStorage can throw (private mode, disabled storage). Treat as
    // not-yet-dismissed but the dismiss action below will no-op gracefully.
    return false;
  }
}

/**
 * App-wide cookie-consent banner. Sorrel only sets strictly-necessary cookies
 * (the auth session), so this is an acknowledgement rather than a consent gate —
 * dismissal is remembered in localStorage so it shows once per browser.
 */
export function CookieConsent() {
  // Start hidden; reveal after mount so we never flash the banner for visitors
  // who already dismissed it (and so the build has no window access at import).
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!readDismissed()) {
      setVisible(true);
    }
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, "dismissed");
    } catch {
      // Ignore — if we can't persist, the banner simply reappears next load.
    }
    setVisible(false);
  };

  return (
    <div
      role="dialog"
      aria-label="Cookie notice"
      className="fixed inset-x-0 bottom-0 z-50 border-t bg-background/95 backdrop-blur-md shadow-lg"
    >
      <div className="container mx-auto flex flex-col items-start gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <Cookie className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <p className="text-sm text-muted-foreground">
            We use strictly-necessary cookies to keep you signed in and to run
            the Service. See our{" "}
            <Link
              href="/privacy"
              className="text-primary underline-offset-4 hover:underline"
            >
              Privacy Policy
            </Link>{" "}
            for details.
          </p>
        </div>
        <Button
          size="sm"
          onClick={dismiss}
          className="shrink-0 self-stretch sm:self-auto"
        >
          Got it
        </Button>
      </div>
    </div>
  );
}
