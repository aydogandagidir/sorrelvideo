import pino, { type LoggerOptions } from "pino";

const isProduction = process.env.NODE_ENV === "production";

const options: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
};

// Dev: pretty colorized stdout. Production: structured JSON straight to stdout
// so the host log shipper parses it cleanly. On Railway, forward those logs to
// Better Stack / Logtail with a native **log drain** (Project → Settings →
// Log drains) — no in-process transport needed, which avoids the fragile
// worker-thread bundling that pino transports require under esbuild.
if (!isProduction) {
  options.transport = {
    target: "pino-pretty",
    options: { colorize: true },
  };
}

export const logger = pino(options);
