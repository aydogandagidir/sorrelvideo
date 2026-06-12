import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import {
  assertNoLintErrors,
  lintComposition,
  type LintMessage,
} from "./compositionCompilerService";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Read a real shipped composition (src/compositions/<name>) from disk. */
function readComposition(name: string): string {
  return readFileSync(
    path.resolve(__dirname, "..", "compositions", name),
    "utf-8",
  );
}

/**
 * A minimal, lint-clean Hyperframes composition. It satisfies every
 * error-severity rule core 0.6.91 enforces: a root element carrying
 * `data-composition-id` + `data-width`/`data-height`, and a `window.__timelines`
 * registry whose key matches that id, with syntactically valid inline JS.
 *
 * No real Sorrel composition is clean — they drive rendering through a bespoke
 * `window.__hf.seek` bridge rather than the Studio `__timelines` registry, and
 * omit `data-width`/`data-height` — so this hand-built fixture is the only way
 * to exercise the "no errors" path of `assertNoLintErrors`.
 */
const CLEAN_COMPOSITION = `<!doctype html>
<html>
  <head><meta charset="UTF-8" /></head>
  <body>
    <div data-composition-id="clean" data-width="1080" data-height="1920" data-start="0">
      <h1>Hello</h1>
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      window.__timelines["clean"] = { duration: 5 };
    </script>
  </body>
</html>`;

/** Bare fragment: no composition root, no timeline registry — guaranteed errors. */
const BROKEN_COMPOSITION = "<div>just a fragment, not a composition</div>";

const errorsOf = (messages: LintMessage[]): LintMessage[] =>
  messages.filter((m) => m.severity === "error");

describe("lintComposition", () => {
  // Importing core's runtime `lintHyperframeHtml` is the reason vitest needs
  // `server.deps.inline: [/@hyperframes\/core/]`. Linting a real composition
  // here proves that wiring resolves at runtime (no extensionless-import crash).
  it("lints a real shipped composition without throwing and returns an array", async () => {
    const html = readComposition("studio-default.html");
    const messages = await lintComposition(html);
    expect(Array.isArray(messages)).toBe(true);
    // Every finding is well-formed: a known severity and a non-empty message.
    for (const m of messages) {
      expect(["error", "warning", "info"]).toContain(m.severity);
      expect(typeof m.message).toBe("string");
      expect(m.message.length).toBeGreaterThan(0);
    }
  });

  it("returns no error-severity findings for a lint-clean composition", async () => {
    expect(errorsOf(await lintComposition(CLEAN_COMPOSITION))).toHaveLength(0);
  });

  it("reports findings for an obviously-broken composition", async () => {
    const messages = await lintComposition(BROKEN_COMPOSITION);
    expect(messages.length).toBeGreaterThan(0);
    // A bare fragment has no composition root and no timeline registry, so the
    // linter must flag at least one error.
    expect(errorsOf(messages).length).toBeGreaterThan(0);
    // Findings carry the engine rule code through as `rule`.
    expect(messages.every((m) => typeof m.rule === "string")).toBe(true);
  });
});

describe("assertNoLintErrors", () => {
  it("rejects with a 400 error listing the lint errors for broken HTML", async () => {
    let thrown: unknown;
    try {
      await assertNoLintErrors(BROKEN_COMPOSITION);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error & { status?: number }).status).toBe(400);
    expect((thrown as Error).message).toContain("lint error");
  });

  it("does not reject for a lint-clean composition", async () => {
    await expect(assertNoLintErrors(CLEAN_COMPOSITION)).resolves.toBeUndefined();
  });
});
