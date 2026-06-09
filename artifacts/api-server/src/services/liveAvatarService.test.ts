import { afterEach, describe, expect, it } from "vitest";
import { isLiveAvatarConfigured } from "./liveAvatarService";

describe("isLiveAvatarConfigured", () => {
  const saved = process.env.LIVEAVATAR_API_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.LIVEAVATAR_API_KEY;
    else process.env.LIVEAVATAR_API_KEY = saved;
  });

  it("is false without a key (endpoint 503s, UI hides the feature)", () => {
    delete process.env.LIVEAVATAR_API_KEY;
    expect(isLiveAvatarConfigured()).toBe(false);
  });

  it("is true with a key", () => {
    process.env.LIVEAVATAR_API_KEY = "la-test";
    expect(isLiveAvatarConfigured()).toBe(true);
  });
});
