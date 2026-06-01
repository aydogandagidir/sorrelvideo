import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Silence (and allow asserting) the degrade warnings without real log noise.
const h = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock("./logger", () => ({ logger: h }));

/**
 * Snapshot + restore the four env vars selectBackend reads so each case is
 * hermetic regardless of the ambient environment.
 */
const ENV_KEYS = [
  "RENDER_BACKEND",
  "REDIS_URL",
  "AWS_REGION",
  "HYPERFRAMES_S3_BUCKET",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

type Env = {
  RENDER_BACKEND?: string;
  REDIS_URL?: string;
  AWS_REGION?: string;
  HYPERFRAMES_S3_BUCKET?: string;
};

function applyEnv(env: Env): void {
  if (env.RENDER_BACKEND !== undefined)
    process.env.RENDER_BACKEND = env.RENDER_BACKEND;
  if (env.REDIS_URL !== undefined) process.env.REDIS_URL = env.REDIS_URL;
  if (env.AWS_REGION !== undefined) process.env.AWS_REGION = env.AWS_REGION;
  if (env.HYPERFRAMES_S3_BUCKET !== undefined)
    process.env.HYPERFRAMES_S3_BUCKET = env.HYPERFRAMES_S3_BUCKET;
}

const REDIS = "redis://localhost:6379";
const AWS: Env = { AWS_REGION: "us-east-1", HYPERFRAMES_S3_BUCKET: "b" };

describe("selectBackend", () => {
  // Exhaustive (preference × plan × env) table. `want` is the expected backend.
  const cases: Array<{
    name: string;
    env: Env;
    plan: "free" | "pro";
    want: "inline" | "bullmq" | "lambda";
  }> = [
    // ---- default (RENDER_BACKEND unset → "inline") ----------------------------
    {
      name: "default unset → inline (free, no redis)",
      env: {},
      plan: "free",
      want: "inline",
    },
    {
      name: "default unset → inline (pro, no redis)",
      env: {},
      plan: "pro",
      want: "inline",
    },
    {
      name: "default unset → inline even with redis (inline is explicit)",
      env: { REDIS_URL: REDIS },
      plan: "pro",
      want: "inline",
    },
    {
      name: "default unset → inline even with redis + AWS (pro)",
      env: { REDIS_URL: REDIS, ...AWS },
      plan: "pro",
      want: "inline",
    },

    // ---- explicit inline ------------------------------------------------------
    {
      name: "inline stays inline even with redis + AWS + pro",
      env: { RENDER_BACKEND: "inline", REDIS_URL: REDIS, ...AWS },
      plan: "pro",
      want: "inline",
    },

    // ---- explicit bullmq ------------------------------------------------------
    {
      name: "bullmq with redis → bullmq",
      env: { RENDER_BACKEND: "bullmq", REDIS_URL: REDIS },
      plan: "free",
      want: "bullmq",
    },
    {
      name: "bullmq without redis → degrade to inline",
      env: { RENDER_BACKEND: "bullmq" },
      plan: "pro",
      want: "inline",
    },
    {
      name: "bullmq never escalates to lambda even with AWS + pro",
      env: { RENDER_BACKEND: "bullmq", REDIS_URL: REDIS, ...AWS },
      plan: "pro",
      want: "bullmq",
    },

    // ---- explicit lambda ------------------------------------------------------
    {
      name: "lambda + pro + AWS → lambda",
      env: { RENDER_BACKEND: "lambda", ...AWS },
      plan: "pro",
      want: "lambda",
    },
    {
      name: "lambda + FREE + AWS → degrade (never lambda for free)",
      env: { RENDER_BACKEND: "lambda", ...AWS },
      plan: "free",
      want: "inline",
    },
    {
      name: "lambda + FREE + AWS + redis → degrade to bullmq (not lambda)",
      env: { RENDER_BACKEND: "lambda", REDIS_URL: REDIS, ...AWS },
      plan: "free",
      want: "bullmq",
    },
    {
      name: "lambda + pro but NO AWS → degrade to inline",
      env: { RENDER_BACKEND: "lambda" },
      plan: "pro",
      want: "inline",
    },
    {
      name: "lambda + pro but NO AWS, redis present → degrade to bullmq",
      env: { RENDER_BACKEND: "lambda", REDIS_URL: REDIS },
      plan: "pro",
      want: "bullmq",
    },
    {
      name: "lambda + pro + only AWS_REGION (no bucket) → degrade (incomplete env)",
      env: { RENDER_BACKEND: "lambda", AWS_REGION: "us-east-1" },
      plan: "pro",
      want: "inline",
    },
    {
      name: "lambda + pro + only bucket (no region) → degrade (incomplete env)",
      env: { RENDER_BACKEND: "lambda", HYPERFRAMES_S3_BUCKET: "b" },
      plan: "pro",
      want: "inline",
    },

    // ---- auto -----------------------------------------------------------------
    {
      name: "auto + pro + AWS → lambda (richest available)",
      env: { RENDER_BACKEND: "auto", ...AWS },
      plan: "pro",
      want: "lambda",
    },
    {
      name: "auto + FREE + AWS → bullmq if redis (never lambda for free)",
      env: { RENDER_BACKEND: "auto", REDIS_URL: REDIS, ...AWS },
      plan: "free",
      want: "bullmq",
    },
    {
      name: "auto + FREE + AWS, no redis → inline (never lambda for free)",
      env: { RENDER_BACKEND: "auto", ...AWS },
      plan: "free",
      want: "inline",
    },
    {
      name: "auto + pro, no AWS, redis → bullmq",
      env: { RENDER_BACKEND: "auto", REDIS_URL: REDIS },
      plan: "pro",
      want: "bullmq",
    },
    {
      name: "auto + pro, nothing → inline",
      env: { RENDER_BACKEND: "auto" },
      plan: "pro",
      want: "inline",
    },

    // ---- unknown value --------------------------------------------------------
    {
      name: "garbage RENDER_BACKEND → inline fallback",
      env: { RENDER_BACKEND: "wat", REDIS_URL: REDIS, ...AWS },
      plan: "pro",
      want: "inline",
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      applyEnv(c.env);
      const { selectBackend } = await import("./renderBackend");
      expect(selectBackend(c.plan)).toBe(c.want);
    });
  }

  it("INVARIANT: lambda is never selected for a free plan across the matrix", async () => {
    const { selectBackend } = await import("./renderBackend");
    for (const pref of ["inline", "bullmq", "lambda", "auto", "garbage"]) {
      for (const withRedis of [false, true]) {
        for (const withAws of [false, true]) {
          for (const k of ENV_KEYS) delete process.env[k];
          process.env.RENDER_BACKEND = pref;
          if (withRedis) process.env.REDIS_URL = REDIS;
          if (withAws) {
            process.env.AWS_REGION = "us-east-1";
            process.env.HYPERFRAMES_S3_BUCKET = "b";
          }
          expect(selectBackend("free")).not.toBe("lambda");
        }
      }
    }
  });

  it("INVARIANT: lambda is never selected without BOTH AWS_REGION and bucket", async () => {
    const { selectBackend } = await import("./renderBackend");
    const awsCombos: Env[] = [
      {},
      { AWS_REGION: "us-east-1" },
      { HYPERFRAMES_S3_BUCKET: "b" },
    ];
    for (const pref of ["lambda", "auto"]) {
      for (const aws of awsCombos) {
        for (const k of ENV_KEYS) delete process.env[k];
        process.env.RENDER_BACKEND = pref;
        applyEnv(aws);
        expect(selectBackend("pro")).not.toBe("lambda");
      }
    }
  });
});

describe("isLambdaBackendActive", () => {
  it("is false unless RENDER_BACKEND is lambda|auto AND AWS env is complete", async () => {
    const { isLambdaBackendActive } = await import("./renderBackend");

    // Wrong preference → false even with full AWS env.
    process.env.RENDER_BACKEND = "inline";
    process.env.AWS_REGION = "us-east-1";
    process.env.HYPERFRAMES_S3_BUCKET = "b";
    expect(isLambdaBackendActive()).toBe(false);

    // lambda preference but incomplete env → false.
    process.env.RENDER_BACKEND = "lambda";
    delete process.env.HYPERFRAMES_S3_BUCKET;
    expect(isLambdaBackendActive()).toBe(false);

    // lambda + full env → true.
    process.env.HYPERFRAMES_S3_BUCKET = "b";
    expect(isLambdaBackendActive()).toBe(true);

    // auto + full env → true.
    process.env.RENDER_BACKEND = "auto";
    expect(isLambdaBackendActive()).toBe(true);
  });
});
