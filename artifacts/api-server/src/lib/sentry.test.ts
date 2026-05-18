import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initSentry, isSentryEnabled } from "./sentry";

const ORIG_DSN = process.env.SENTRY_DSN;

beforeEach(() => {
  delete process.env.SENTRY_DSN;
});

afterEach(() => {
  if (ORIG_DSN === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = ORIG_DSN;
});

describe("initSentry", () => {
  it("is a no-op when SENTRY_DSN is unset", () => {
    initSentry();
    expect(isSentryEnabled()).toBe(false);
  });

  it("does not throw when called twice", () => {
    expect(() => {
      initSentry();
      initSentry();
    }).not.toThrow();
  });
});
