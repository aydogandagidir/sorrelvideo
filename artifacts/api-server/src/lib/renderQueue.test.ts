import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Shared mock fns (hoisted so the vi.mock factories below can reference them).
const h = vi.hoisted(() => ({
  executeRender: vi.fn(),
  queueAdd: vi.fn(),
  queueRemove: vi.fn(),
  getJobState: vi.fn(),
  dispatchLambdaRender: vi.fn(),
  getJobById: vi.fn(),
}));

// Mock the execution half so the queue trigger can be tested without pulling in
// Hyperframes/Chrome or the DB.
vi.mock("../services/renderService", () => ({
  executeRender: h.executeRender,
}));

// Mock the distributed backend so the lambda branch can be asserted without the
// (uninstalled) @hyperframes/aws-lambda package, AWS, or the composition build.
// `LambdaDispatchError` must be a real class — enqueueRender uses `instanceof`.
class LambdaDispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LambdaDispatchError";
  }
}
vi.mock("./renderBackends/lambdaBackend", () => ({
  dispatchLambdaRender: h.dispatchLambdaRender,
  LambdaDispatchError,
}));

// Mock just the one render-jobs read enqueueRender uses on the lambda path, so
// the lambda branch doesn't need a live DB. (resolveSettings is pure — left real.)
vi.mock("../services/renderJobsService", () => ({
  getJobById: h.getJobById,
}));

// Mock BullMQ + ioredis so no real broker is needed (tests stay Redis-free).
vi.mock("bullmq", () => ({
  Queue: vi.fn(() => ({
    add: h.queueAdd,
    remove: h.queueRemove,
    getJobState: h.getJobState,
    close: vi.fn(),
  })),
  Worker: vi.fn(() => ({ on: vi.fn(), close: vi.fn() })),
}));

vi.mock("ioredis", () => ({
  default: vi.fn(() => ({ on: vi.fn(), disconnect: vi.fn() })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules(); // reset renderQueue's module-level singletons between tests
  delete process.env.REDIS_URL;
  delete process.env.RENDER_BACKEND;
  delete process.env.AWS_REGION;
  delete process.env.HYPERFRAMES_S3_BUCKET;
  delete process.env.HYPERFRAMES_STATE_MACHINE_ARN;
  h.executeRender.mockResolvedValue(undefined);
  h.queueAdd.mockResolvedValue(undefined);
  // BullMQ's Queue.remove resolves a numeric code: 1 = removed (or never
  // existed), 0 = the job is locked by a live worker and can't be removed.
  h.queueRemove.mockResolvedValue(1);
  h.dispatchLambdaRender.mockResolvedValue(undefined);
  // Ledger row the lambda path reads for userId + config snapshot.
  h.getJobById.mockResolvedValue({
    id: "rj-1",
    userId: "user-1",
    config: null,
  });
});

afterEach(() => {
  // Restore any env var a test stubbed (REDIS_URL / RENDER_BACKEND / AWS_*) so a
  // value set by the LAST test of this file can't bleed into another suite that
  // shares this worker process. Concretely: app.test.ts's /api/healthz probe
  // pings Redis whenever REDIS_URL is set (routes/health.ts) and 503s against a
  // non-existent local broker — a cross-file leak that fails it only in a full
  // `pnpm test` run. Stubbing via vi.stubEnv (above) + unstub here keeps every
  // case hermetic regardless of test ordering.
  vi.unstubAllEnvs();
});

describe("isQueueEnabled", () => {
  it("reflects REDIS_URL presence", async () => {
    const mod = await import("./renderQueue");
    expect(mod.isQueueEnabled()).toBe(false);
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    expect(mod.isQueueEnabled()).toBe(true);
  });
});

describe("enqueueRender", () => {
  it("runs inline (and never touches the queue) when REDIS_URL is unset", async () => {
    const { enqueueRender } = await import("./renderQueue");
    await enqueueRender(7, "studio", null, "rj-7");
    expect(h.executeRender).toHaveBeenCalledWith(7, "studio", null, "rj-7");
    expect(h.queueAdd).not.toHaveBeenCalled();
    expect(h.dispatchLambdaRender).not.toHaveBeenCalled();
  });

  it("enqueues with jobId=projectId and does not run inline when REDIS_URL is set", async () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    const { enqueueRender } = await import("./renderQueue");
    await enqueueRender(42, "studio", 3, "rj-42");

    expect(h.executeRender).not.toHaveBeenCalled();
    expect(h.dispatchLambdaRender).not.toHaveBeenCalled();
    expect(h.queueAdd).toHaveBeenCalledTimes(1);
    const [, data, opts] = h.queueAdd.mock.calls[0];
    expect(data).toEqual({
      projectId: 42,
      module: "studio",
      templateId: 3,
      renderJobId: "rj-42",
    });
    // Must NOT be a bare number — BullMQ rejects purely-numeric custom job ids.
    expect(opts.jobId).toBe("render-42");
    expect(opts.jobId).not.toMatch(/^\d+$/);
  });

  it("throws RenderAlreadyActiveError (and never re-adds) when the prior job is still locked", async () => {
    // The race: the previous render flipped the project out of "rendering"
    // BEFORE its worker fn returned, so the route's atomic claim wins again
    // while the old BullMQ job still holds its lock. remove() returns 0
    // (locked) and a fresh add() with the same jobId would be silently
    // dedup-dropped → project stuck "rendering". enqueueRender must instead
    // surface the condition so the route releases the claim + 409s.
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    h.queueRemove.mockResolvedValueOnce(0); // job is locked / active
    const { enqueueRender, RenderAlreadyActiveError } =
      await import("./renderQueue");

    await expect(
      enqueueRender(42, "studio", null, "rj-42b"),
    ).rejects.toBeInstanceOf(RenderAlreadyActiveError);

    // Critically: it did NOT silently drop a no-op add onto the queue.
    expect(h.queueAdd).not.toHaveBeenCalled();
  });

  it("still enqueues when remove() resolves a falsy non-zero (job absent)", async () => {
    // Defensive: remove() throwing is swallowed to 1, and any non-0 code means
    // "nothing locked" → the add proceeds. Guards against a future regression
    // where `!removed` (which would wrongly trip on undefined) replaces `=== 0`.
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    h.queueRemove.mockRejectedValueOnce(new Error("connection blip"));
    const { enqueueRender } = await import("./renderQueue");

    await enqueueRender(42, "studio", null, "rj-42c");
    expect(h.queueAdd).toHaveBeenCalledTimes(1);
  });

  it("ignores a 'pro' plan when RENDER_BACKEND is unset — still inline/bullmq", async () => {
    // Default RENDER_BACKEND ("inline") must win regardless of plan, so the
    // shipped inline/bullmq behavior is byte-identical even for Pro users.
    const { enqueueRender } = await import("./renderQueue");
    await enqueueRender(8, "studio", null, "rj-8", "pro");
    expect(h.executeRender).toHaveBeenCalledWith(8, "studio", null, "rj-8");
    expect(h.dispatchLambdaRender).not.toHaveBeenCalled();
  });

  it("routes to the lambda backend when RENDER_BACKEND=lambda, plan=pro, AWS env present", async () => {
    vi.stubEnv("RENDER_BACKEND", "lambda");
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("HYPERFRAMES_S3_BUCKET", "sorrel-render-dev");
    vi.stubEnv("HYPERFRAMES_STATE_MACHINE_ARN", "arn:aws:states:us-east-1:0:stateMachine:hf");
    const { enqueueRender } = await import("./renderQueue");

    await enqueueRender(99, "studio", null, "rj-99", "pro");

    expect(h.dispatchLambdaRender).toHaveBeenCalledTimes(1);
    expect(h.dispatchLambdaRender.mock.calls[0][0]).toMatchObject({
      projectId: 99,
      userId: "user-1",
      module: "studio",
      renderJobId: "rj-99",
    });
    // Did NOT fall through to inline or the queue.
    expect(h.executeRender).not.toHaveBeenCalled();
    expect(h.queueAdd).not.toHaveBeenCalled();
  });

  it("does NOT route a free plan to lambda even with RENDER_BACKEND=lambda + AWS env", async () => {
    vi.stubEnv("RENDER_BACKEND", "lambda");
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("HYPERFRAMES_S3_BUCKET", "sorrel-render-dev");
    vi.stubEnv("HYPERFRAMES_STATE_MACHINE_ARN", "arn:aws:states:us-east-1:0:stateMachine:hf");
    const { enqueueRender } = await import("./renderQueue");

    await enqueueRender(5, "studio", null, "rj-5", "free");

    // Degrades to inline (no Redis) — lambda is Pro-only.
    expect(h.dispatchLambdaRender).not.toHaveBeenCalled();
    expect(h.executeRender).toHaveBeenCalledWith(5, "studio", null, "rj-5");
  });

  it("re-throws a LambdaDispatchError so the route can release the claim", async () => {
    vi.stubEnv("RENDER_BACKEND", "lambda");
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("HYPERFRAMES_S3_BUCKET", "sorrel-render-dev");
    vi.stubEnv("HYPERFRAMES_STATE_MACHINE_ARN", "arn:aws:states:us-east-1:0:stateMachine:hf");
    h.dispatchLambdaRender.mockRejectedValueOnce(
      new LambdaDispatchError("Too many in-flight Lambda renders"),
    );
    const { enqueueRender } = await import("./renderQueue");

    await expect(
      enqueueRender(13, "studio", null, "rj-13", "pro"),
    ).rejects.toBeInstanceOf(LambdaDispatchError);
  });
});

describe("hasPendingJob", () => {
  it("returns false in inline mode", async () => {
    const { hasPendingJob } = await import("./renderQueue");
    expect(await hasPendingJob(1)).toBe(false);
  });

  it("treats active jobs as pending and completed jobs as not", async () => {
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    const { hasPendingJob } = await import("./renderQueue");

    h.getJobState.mockResolvedValueOnce("active");
    expect(await hasPendingJob(1)).toBe(true);

    h.getJobState.mockResolvedValueOnce("completed");
    expect(await hasPendingJob(1)).toBe(false);
  });
});
