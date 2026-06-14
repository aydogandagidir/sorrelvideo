import { rateLimit, type Options, type Store } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import IORedis, { type Redis } from "ioredis";
import type { Request } from "express";
import { logger } from "../lib/logger";

/**
 * Per-IP+email rate limiter factory. Falls back to IP only when no email is
 * present in the request body.
 *
 * Store selection mirrors lib/renderQueue.ts's REDIS_URL gate: when REDIS_URL is
 * set, all limiters share ONE ioredis connection backing a RedisStore so the
 * counters stay correct across MORE THAN ONE instance (the in-memory store is
 * per-process — behind >1 replica each node keeps its own tally, multiplying the
 * effective limit). When REDIS_URL is unset (typical local dev) — or under tests
 * — each limiter uses express-rate-limit's built-in in-memory store, so behaviour
 * is byte-identical to before and no Redis is required.
 *
 * Always returns 429 with a JSON body and a `Retry-After` header so clients can
 * back off gracefully.
 */

// One shared ioredis client for ALL limiter stores, created on first limiter
// construction and ONLY when REDIS_URL is set (and not under tests). Reuses the
// same ioredis dependency as the BullMQ render queue, on its own connection so
// rate limiting never contends on the queue's command pipeline.
let limiterRedis: Redis | null | undefined;

function getLimiterRedis(): Redis | null {
  if (limiterRedis !== undefined) return limiterRedis;
  const url = process.env.REDIS_URL;
  // Skip Redis under tests: a leaked REDIS_URL pointing at a non-existent broker
  // must not make the limiters error (the suites run with no reachable Redis, so
  // the in-memory store is the correct + only working choice there).
  if (!url || process.env.NODE_ENV === "test") {
    limiterRedis = null;
    return null;
  }
  const client = new IORedis(url, { maxRetriesPerRequest: null });
  client.on("error", (err: Error) =>
    logger.error({ err }, "Rate-limit Redis connection error"),
  );
  limiterRedis = client;
  return client;
}

/**
 * The express-rate-limit store: a RedisStore over the shared ioredis client when
 * REDIS_URL is set, else `undefined` so the library uses its built-in in-memory
 * store. A distinct `prefix` per limiter namespaces the keys so the
 * login/signup/etc. windows never collide in Redis.
 */
function buildStore(name: string): Store | undefined {
  const client = getLimiterRedis();
  if (!client) return undefined;
  return new RedisStore({
    prefix: `rl:${name}:`,
    // ioredis exposes the raw command API via `.call(...)`; the cast to a
    // non-empty tuple satisfies its (command, ...args) signature.
    sendCommand: (...args: string[]) =>
      client.call(...(args as [string, ...string[]])) as Promise<never>,
  });
}

function createLimiter(opts: {
  windowMs: number;
  max: number;
  keyByEmail?: boolean;
  /** Redis key namespace — unique per limiter. */
  name: string;
}): ReturnType<typeof rateLimit> {
  const config: Partial<Options> = {
    windowMs: opts.windowMs,
    limit: opts.max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
    store: buildStore(opts.name),
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
  name: "login",
});

export const signupLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 3,
  name: "signup",
});

export const forgotPasswordLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyByEmail: true,
  name: "forgot-password",
});

export const verifyEmailLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  name: "verify-email",
});

// Password-reset consumption. The token is 256-bit so guessing is infeasible,
// but cap volume per IP as defence-in-depth against token-guessing floods and DB
// pressure (mirrors verifyEmailLimiter: 10 / hour per IP).
export const resetPasswordLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  name: "reset-password",
});

// Authenticated AI suggest endpoint. Quota (FREE_AI_LIMIT) is enforced
// separately in billingService — this limiter is just to keep a single
// authenticated user from hammering the LLM provider faster than is sane.
export const aiSuggestLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  name: "ai-suggest",
});

// Authenticated website→video capture. Each call launches headless Chrome to
// screenshot an arbitrary URL — expensive — so cap a single client to a handful
// per window (defence-in-depth alongside the SSRF guard).
export const websiteCaptureLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  name: "website-capture",
});

// Authenticated brand-from-URL extraction. Also launches headless Chrome (and
// optionally an LLM refine), so rate-limit it like the capture endpoint.
export const brandExtractLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  name: "brand-extract",
});
