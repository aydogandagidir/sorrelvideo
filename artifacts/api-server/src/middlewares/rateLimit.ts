import { rateLimit, type Options } from "express-rate-limit";
import type { Request } from "express";

/**
 * Per-IP+email rate limiter factory. Falls back to IP only when no email is
 * present in the request body. Uses in-memory store — fine for single-node
 * dev / small production; swap to Redis (rate-limit-redis) when scaling
 * horizontally.
 *
 * Always returns 429 with a JSON body and a `Retry-After` header so clients
 * can back off gracefully.
 */
function createLimiter(opts: {
  windowMs: number;
  max: number;
  keyByEmail?: boolean;
}): ReturnType<typeof rateLimit> {
  const config: Partial<Options> = {
    windowMs: opts.windowMs,
    limit: opts.max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
  };
  if (opts.keyByEmail) {
    config.keyGenerator = (req: Request) => {
      const ip = req.ip ?? "unknown";
      const body = (req.body ?? {}) as { email?: unknown };
      const email =
        typeof body.email === "string" ? body.email.toLowerCase().trim() : "";
      return email ? `${ip}|${email}` : ip;
    };
  }
  return rateLimit(config);
}

export const loginLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyByEmail: true,
});

export const signupLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 3,
});

export const forgotPasswordLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyByEmail: true,
});

export const verifyEmailLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
});

// Authenticated AI suggest endpoint. Quota (FREE_AI_LIMIT) is enforced
// separately in billingService — this limiter is just to keep a single
// authenticated user from hammering the LLM provider faster than is sane.
export const aiSuggestLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
});

// Authenticated website→video capture. Each call launches headless Chrome to
// screenshot an arbitrary URL — expensive — so cap a single client to a handful
// per window (defence-in-depth alongside the SSRF guard).
export const websiteCaptureLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
});

// Authenticated brand-from-URL extraction. Also launches headless Chrome (and
// optionally an LLM refine), so rate-limit it like the capture endpoint.
export const brandExtractLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
});
