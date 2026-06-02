import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { authMiddleware } from "./middlewares/authMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";
import { WebhookHandlers } from "./webhookHandlers";

const app: Express = express();

// In production, ALLOWED_ORIGINS is a comma-separated list of full origin URLs
// (e.g. "https://app.example.com,https://www.example.com").
// In development, allow any origin so the Vite dev server can reach the API.
const allowedOrigins: string[] = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
      .map((o) => o.trim())
      .filter(Boolean)
  : [];

app.use(
  cors({
    credentials: true,
    origin:
      process.env.NODE_ENV === "production"
        ? (origin, cb) => {
            // Allow requests with no Origin (same-origin navigations, curl,
            // server-to-server) and any allow-listed origin. For everything
            // else resolve with `false` — NOT an Error. A rejected origin must
            // simply omit the `Access-Control-Allow-Origin` header (the browser
            // then blocks the cross-origin read); it must never throw. Throwing
            // makes cors call `next(err)` → a 500 that ALSO breaks same-origin
            // asset loads, because Vite tags its module scripts `crossorigin`,
            // so even same-origin script/style fetches carry an Origin header
            // and run in CORS mode. A 500 there white-screens the whole SPA
            // whenever ALLOWED_ORIGINS is unset or even slightly mismatched.
            cb(null, !origin || allowedOrigins.includes(origin));
          }
        : true,
  }),
);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Stripe webhook — registered before express.json() to preserve the raw body
// required for signature verification. Mounted on both canonical and legacy paths.
async function handleStripeWebhook(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const signature = req.headers["stripe-signature"];
  if (!signature) {
    res.status(400).json({ error: "Missing stripe-signature" });
    return;
  }

  const sig = Array.isArray(signature) ? signature[0] : signature;

  try {
    await WebhookHandlers.processWebhook(req.body as Buffer, sig);
    res.status(200).json({ received: true });
  } catch (err) {
    logger.error({ err }, "Stripe webhook processing error");
    res.status(400).json({ error: "Webhook processing error" });
  }
}

const rawBody = express.raw({ type: "application/json" });

// Stripe webhook URL must be configured in the Stripe Dashboard as
// `${APP_URL}/api/billing/webhook`. The raw body is preserved above so the
// signature can be verified by stripe.webhooks.constructEvent.
app.post("/api/billing/webhook", rawBody, handleStripeWebhook);

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(authMiddleware);

app.use("/api", router);

// Production: serve the Vite SPA bundle copied into /app/public by the
// Dockerfile. API routes take precedence (mounted above). Anything that
// reaches this middleware and isn't an /api/* path falls back to index.html
// so client-side routing works on hard reloads / share links.
if (process.env.NODE_ENV === "production") {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.resolve(here, "../public");
  app.use(express.static(publicDir, { maxAge: "1h", index: false }));

  // Embedded @hyperframes/studio editor (M9): built by @workspace/studio-editor
  // and copied to public/editor by the Dockerfile. Served same-origin under
  // /editor/ so the `sid` cookie flows to its repointed /api/studio/* calls.
  // Registered BEFORE the SPA fallback so /editor/* isn't swallowed by it; its
  // assets sit under /editor/assets/* (Vite base=/editor/). A manual fallback
  // returns the editor index.html for deep links (it uses hash routing).
  const editorDir = path.join(publicDir, "editor");
  app.use(
    "/editor",
    express.static(editorDir, { maxAge: "1h", index: "index.html" }),
  );
  app.use("/editor", (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    fs.readFile(path.join(editorDir, "index.html"), (err, html) => {
      if (err) return next(err);
      res.type("html").send(html);
    });
  });

  const indexHtmlPath = path.join(publicDir, "index.html");
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api")) return next();
    // Read + send manually instead of res.sendFile: Express 5's send() rejects
    // absolute paths containing spaces (the repo can live under ".../Artificial
    // Inteligence/...") with a spurious NotFoundError — same workaround as the
    // video stream in routes/projects.ts.
    fs.readFile(indexHtmlPath, (err, html) => {
      if (err) return next(err);
      res.type("html").send(html);
    });
  });
}

export default app;
