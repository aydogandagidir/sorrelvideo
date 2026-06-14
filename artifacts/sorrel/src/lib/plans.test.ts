import { describe, expect, it } from "vitest";
import {
  FREE_PLAN_FEATURES,
  PRO_PLAN_FEATURES,
  FREE_RENDER_LIMIT,
  FREE_AI_LIMIT,
} from "./plans";

const free = FREE_PLAN_FEATURES.join(" | ").toLowerCase();
const pro = PRO_PLAN_FEATURES.join(" | ").toLowerCase();

describe("plan marketing copy stays aligned with the capability gate", () => {
  it("advertises Free at 1080p (not 720p) and surfaces the GIF hook", () => {
    expect(free).toContain("1080p");
    expect(free).not.toContain("720p");
    expect(free).toContain("gif");
  });

  it("makes 4K the Pro differentiator (Free must not claim it)", () => {
    expect(pro).toContain("4k");
    expect(free).not.toContain("4k");
  });

  it("states the real Free quotas", () => {
    expect(free).toContain(`${FREE_RENDER_LIMIT} video renders`);
    expect(free).toContain(`${FREE_AI_LIMIT} ai copy drafts`);
  });

  it("does not advertise an unbacked 'priority render queue' (concurrency is global, not plan-tiered)", () => {
    expect(pro).not.toContain("priority render queue");
  });

  it("keeps watermark on Free and its removal on Pro", () => {
    expect(free).toContain("watermark");
    expect(pro).toContain("no watermark");
  });
});
