import type * as SentryNode from "@sentry/node";
import type { Express } from "express";

// Loaded lazily so the heavy @sentry/node + @opentelemetry/* dependency graph
// is only pulled in when SENTRY_DSN is set. Without this, a static import
// would force those packages to resolve at boot even in local dev (where they
// may not be hoisted into node_modules), crashing the server.
let sentry: typeof SentryNode | null = null;

/**
 * Initialise Sentry. No-op (and zero import cost) when SENTRY_DSN is unset.
 * Call before app.listen so the SDK can patch what it needs.
 */
export async function initSentry(): Promise<void> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  sentry = await import("@sentry/node");
  sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    release: process.env.GIT_SHA,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    sendDefaultPii: false,
    beforeSend(event) {
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
}

/** Wire Sentry's Express error handler. No-op when Sentry wasn't initialised. */
export function setupSentryErrorHandler(app: Express): void {
  if (sentry) sentry.setupExpressErrorHandler(app);
}

/** Manually report an error. No-op when Sentry wasn't initialised. */
export function captureException(err: unknown): void {
  if (sentry) sentry.captureException(err);
}

export function isSentryEnabled(): boolean {
  return sentry !== null;
}
