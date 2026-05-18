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
            if (!origin || allowedOrigins.includes(origin)) {
              cb(null, true);
            } else {
              cb(new Error(`CORS: origin '${origin}' not allowed`));
            }
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
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(publicDir, "index.html"));
  });
}

export default app;
