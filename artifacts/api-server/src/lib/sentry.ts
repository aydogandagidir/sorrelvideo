import * as Sentry from "@sentry/node";

let initialized = false;

/**
 * Initialise Sentry on the server. No-op when SENTRY_DSN is not set so the
 * app keeps working in local development without an external dependency.
 *
 * Call this BEFORE importing app.ts / spinning up Express — the SDK patches
 * a bunch of globals (http, node:async_hooks) on init.
 */
export function initSentry(): void {
  if (initialized) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    release: process.env.GIT_SHA,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    sendDefaultPii: false,
    beforeSend(event) {
      // Belt-and-braces: scrub request bodies and headers in case a route ever
      // logs them. Sentry already redacts cookies/auth headers, but body
      // shape is route-specific.
      if (event.request) {
        delete event.request.cookies;
        if (event.request.data && typeof event.request.data === "object") {
          const data = event.request.data as Record<string, unknown>;
          for (const k of ["password", "newPassword", "token", "apiKey"]) {
            if (k in data) data[k] = "[redacted]";
          }
        }
      }
      return event;
    },
  });
  initialized = true;
}

export function isSentryEnabled(): boolean {
  return initialized;
}

export { Sentry };
