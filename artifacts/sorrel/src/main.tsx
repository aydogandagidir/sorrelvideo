import * as Sentry from "@sentry/react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Init Sentry browser SDK before mounting React so error boundaries can
// capture errors during initial render. No-op when VITE_SENTRY_DSN is unset.
// These VITE_* values are inlined at BUILD time (see Dockerfile build stage);
// the Docker build defaults them to "" when unset, so guard on truthiness
// rather than nullishness — an empty string must behave like "not provided".
const sentryDsn = import.meta.env.VITE_SENTRY_DSN;
if (sentryDsn) {
  // Empty/absent/non-numeric → fall back to the 10% default. Note `Number("")`
  // is 0 (finite), so an empty string can't be distinguished by isFinite alone
  // — check for a non-blank string before parsing.
  const rawTracesRate = import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE?.trim();
  const parsedTracesRate = rawTracesRate ? Number(rawTracesRate) : NaN;
  Sentry.init({
    dsn: sentryDsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_GIT_SHA || undefined,
    tracesSampleRate: Number.isFinite(parsedTracesRate) ? parsedTracesRate : 0.1,
    sendDefaultPii: false,
  });
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root was not found in index.html");
}
createRoot(rootElement).render(<App />);
