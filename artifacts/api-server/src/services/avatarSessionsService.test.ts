import { afterEach, describe, expect, it } from "vitest";
import { resolveAvatarSessionLimit } from "./avatarSessionsService";

describe("resolveAvatarSessionLimit", () => {
  const saved = process.env.AVATAR_MONTHLY_SESSION_LIMIT;
  afterEach(() => {
    if (saved === undefined) delete process.env.AVATAR_MONTHLY_SESSION_LIMIT;
    else process.env.AVATAR_MONTHLY_SESSION_LIMIT = saved;
  });

  it("defaults to 30 when unset", () => {
    delete process.env.AVATAR_MONTHLY_SESSION_LIMIT;
    expect(resolveAvatarSessionLimit()).toBe(30);
  });

  it("honors a valid override", () => {
    process.env.AVATAR_MONTHLY_SESSION_LIMIT = "5";
    expect(resolveAvatarSessionLimit()).toBe(5);
  });

  it("ignores junk / negative (falls back to the default)", () => {
    process.env.AVATAR_MONTHLY_SESSION_LIMIT = "nope";
    expect(resolveAvatarSessionLimit()).toBe(30);
    process.env.AVATAR_MONTHLY_SESSION_LIMIT = "-3";
    expect(resolveAvatarSessionLimit()).toBe(30);
  });

  it("allows 0 as a hard off-switch for live sessions", () => {
    process.env.AVATAR_MONTHLY_SESSION_LIMIT = "0";
    expect(resolveAvatarSessionLimit()).toBe(0);
  });
});
