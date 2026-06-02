import { beforeEach, describe, expect, it, vi } from "vitest";

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
  h.executeRender.mockResolvedValue(undefined);
  h.queueAdd.mockResolvedValue(undefined);
  h.queueRemove.mockResolvedValue(undefined);
  h.dispatchLambdaRender.mockResolvedValue(undefined);
  // Ledger row the lambda path reads for userId + config snapshot.
  h.getJobById.mockResolvedValue({
    id: "rj-1",
    userId: "user-1",
    config: null,
  });
});

describe("isQueueEnabled", () => {
  it("reflects REDIS_URL presence", async () => {
    const mod = await import("./renderQueue");
    expect(mod.isQueueEnabled()).toBe(false);
    process.env.REDIS_URL = "redis://localhost:6379";
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
    process.env.REDIS_URL = "redis://localhost:6379";
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

  it("ignores a 'pro' plan when RENDER_BACKEND is unset — still inline/bullmq", async () => {
    // Default RENDER_BACKEND ("inline") must win regardless of plan, so the
    // shipped inline/bullmq behavior is byte-identical even for Pro users.
    const { enqueueRender } = await import("./renderQueue");
    await enqueueRender(8, "studio", null, "rj-8", "pro");
    expect(h.executeRender).toHaveBeenCalledWith(8, "studio", null, "rj-8");
    expect(h.dispatchLambdaRender).not.toHaveBeenCalled();
  });

  it("routes to the lambda backend when RENDER_BACKEND=lambda, plan=pro, AWS env present", async () => {
    process.env.RENDER_BACKEND = "lambda";
    process.env.AWS_REGION = "us-east-1";
    process.env.HYPERFRAMES_S3_BUCKET = "sorrel-render-dev";
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
    process.env.RENDER_BACKEND = "lambda";
    process.env.AWS_REGION = "us-east-1";
    process.env.HYPERFRAMES_S3_BUCKET = "sorrel-render-dev";
    const { enqueueRender } = await import("./renderQueue");

    await enqueueRender(5, "studio", null, "rj-5", "free");

    // Degrades to inline (no Redis) — lambda is Pro-only.
    expect(h.dispatchLambdaRender).not.toHaveBeenCalled();
    expect(h.executeRender).toHaveBeenCalledWith(5, "studio", null, "rj-5");
  });

  it("re-throws a LambdaDispatchError so the route can release the claim", async () => {
    process.env.RENDER_BACKEND = "lambda";
    process.env.AWS_REGION = "us-east-1";
    process.env.HYPERFRAMES_S3_BUCKET = "sorrel-render-dev";
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
    process.env.REDIS_URL = "redis://localhost:6379";
    const { hasPendingJob } = await import("./renderQueue");

    h.getJobState.mockResolvedValueOnce("active");
    expect(await hasPendingJob(1)).toBe(true);

    h.getJobState.mockResolvedValueOnce("completed");
    expect(await hasPendingJob(1)).toBe(false);
  });
});
