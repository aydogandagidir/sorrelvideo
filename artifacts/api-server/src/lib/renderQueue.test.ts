import { beforeEach, describe, expect, it, vi } from "vitest";

// Shared mock fns (hoisted so the vi.mock factories below can reference them).
const h = vi.hoisted(() => ({
  executeRender: vi.fn(),
  queueAdd: vi.fn(),
  queueRemove: vi.fn(),
  getJobState: vi.fn(),
}));

// Mock the execution half so the queue trigger can be tested without pulling in
// Hyperframes/Chrome or the DB.
vi.mock("../services/renderService", () => ({
  executeRender: h.executeRender,
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
  h.executeRender.mockResolvedValue(undefined);
  h.queueAdd.mockResolvedValue(undefined);
  h.queueRemove.mockResolvedValue(undefined);
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
    await enqueueRender(7, "studio", null);
    expect(h.executeRender).toHaveBeenCalledWith(7, "studio", null);
    expect(h.queueAdd).not.toHaveBeenCalled();
  });

  it("enqueues with jobId=projectId and does not run inline when REDIS_URL is set", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const { enqueueRender } = await import("./renderQueue");
    await enqueueRender(42, "studio", 3);

    expect(h.executeRender).not.toHaveBeenCalled();
    expect(h.queueAdd).toHaveBeenCalledTimes(1);
    const [, data, opts] = h.queueAdd.mock.calls[0];
    expect(data).toEqual({ projectId: 42, module: "studio", templateId: 3 });
    // Must NOT be a bare number — BullMQ rejects purely-numeric custom job ids.
    expect(opts.jobId).toBe("render-42");
    expect(opts.jobId).not.toMatch(/^\d+$/);
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
