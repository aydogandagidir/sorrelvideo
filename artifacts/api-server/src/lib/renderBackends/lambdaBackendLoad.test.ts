import { describe, expect, it } from "vitest";

/**
 * Loadability guard for `@hyperframes/aws-lambda` — the package is now a real
 * dependency (the ambient `hyperframes-aws-lambda.d.ts` was deleted, so
 * lambdaBackend.ts compiles against the REAL types). This asserts the dynamic
 * import the backend uses actually resolves and exposes the SDK surface the
 * dispatch/reconcile code calls. If a future engine bump renames or drops one
 * of these, this fails fast instead of at first lambda dispatch in prod.
 *
 * The import is heavy (it pulls @sparticuz/chromium etc.), so it's a single
 * test with a generous timeout — the package never loads on the normal hot path
 * (the backend gates it behind the lambda env).
 */
describe("@hyperframes/aws-lambda loadability", () => {
  it("resolves and exposes the SDK functions the backend calls", async () => {
    const m = await import("@hyperframes/aws-lambda");
    expect(typeof m.renderToLambda).toBe("function");
    expect(typeof m.getRenderProgress).toBe("function");
    expect(typeof m.validateDistributedRenderConfig).toBe("function");
    expect(typeof m.computeRenderCost).toBe("function");
  }, 60_000);
});
