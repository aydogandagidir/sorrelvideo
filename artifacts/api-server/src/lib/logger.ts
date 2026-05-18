import pino, { type LoggerOptions } from "pino";

const isProduction = process.env.NODE_ENV === "production";
const logtailToken = process.env.LOGTAIL_SOURCE_TOKEN;

interface PinoTarget {
  target: string;
  options?: Record<string, unknown>;
  level?: pino.Level;
}

const targets: PinoTarget[] = [];

// Local dev: pretty-print to stdout. Production: structured stdout (no
// pino-pretty layer) so the host log shipper (Railway / Better Stack) parses
// JSON cleanly.
if (!isProduction) {
  targets.push({
    target: "pino-pretty",
    options: { colorize: true },
  });
}

// Better Stack (Logtail) — only when the token is supplied. Falls back to
// stdout-only otherwise so misconfigured environments still ship logs.
if (logtailToken) {
  targets.push({
    target: "@logtail/pino",
    options: { sourceToken: logtailToken },
  });
}

const options: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
};

if (targets.length > 0) {
  options.transport = { targets };
}

export const logger = pino(options);
