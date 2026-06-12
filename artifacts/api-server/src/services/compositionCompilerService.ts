/**
 * Composition lint: a thin, pure adapter over `@hyperframes/core`'s
 * `lintHyperframeHtml`.
 *
 * This is the SAFE/ADDITIVE half of a future pre-render lint gate. It does NOT
 * touch the live render path (`renderService.executeRender` /
 * `renderCompositionTemplate`) — nothing here is wired into a route yet. The
 * intent is to give the route layer a single, DB-less helper that turns the
 * engine's lint findings into a stable, app-shaped `LintMessage[]` and a
 * throw-on-error guard, so a render endpoint can reject obviously-broken
 * composition HTML before spinning up Chrome + FFmpeg.
 *
 * IMPORTANT: importing the runtime value `lintHyperframeHtml` from core is why
 * `vitest.config.ts` carries `server.deps.inline: [/@hyperframes\/core/]` —
 * core's ESM `dist` uses extensionless relative imports that Node's native ESM
 * loader can't resolve. See the comment there.
 */
import {
  lintHyperframeHtml,
  type HyperframeLintFinding,
  type HyperframeLintSeverity,
} from "@hyperframes/core";

/**
 * App-shaped lint finding. Mirrors the engine's `HyperframeLintFinding` but
 * keeps only the fields the app needs and renames `code` → `rule`.
 *
 * `line` is carried for forward-compatibility: core 0.6.91 findings still do
 * not include a line number, so it is currently always `undefined`. If a future
 * core version adds positional data, map it here without a contract change.
 */
export interface LintMessage {
  severity: "error" | "warning" | "info";
  message: string;
  line?: number;
  rule?: string;
}

/**
 * The engine severity vocabulary already matches ours
 * (`"error" | "warning" | "info"`). Keep an explicit, exhaustive mapping so a
 * future divergence in core's union surfaces as a compile error here rather
 * than silently passing an unexpected string through.
 */
function mapSeverity(severity: HyperframeLintSeverity): LintMessage["severity"] {
  switch (severity) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "info":
      return "info";
  }
}

function toLintMessage(finding: HyperframeLintFinding): LintMessage {
  return {
    severity: mapSeverity(finding.severity),
    message: finding.message,
    rule: finding.code,
  };
}

/**
 * Lint a composition's HTML and return the findings as `LintMessage[]`.
 *
 * Pure + deterministic: only runs core's static rule set (`lintHyperframeHtml`),
 * never the URL-reachability pass (`lintMediaUrls`), so it makes no network
 * calls. Async because core 0.6.91 made `lintHyperframeHtml` async (rules may
 * return promises) — the default rule set still does no I/O. An empty array
 * means the linter found nothing to report.
 */
export async function lintComposition(html: string): Promise<LintMessage[]> {
  const result = await lintHyperframeHtml(html);
  return result.findings.map(toLintMessage);
}

/**
 * Throw if a composition has any `severity: "error"` lint finding; no-op
 * otherwise (warnings and info are non-fatal and ignored here).
 *
 * The thrown `Error` carries `.status = 400` so a route can surface it as a
 * Bad Request, byte-compatible with how other services attach a status to
 * their domain errors.
 */
export async function assertNoLintErrors(html: string): Promise<void> {
  const errors = (await lintComposition(html)).filter(
    (message) => message.severity === "error",
  );
  if (errors.length === 0) return;

  const detail = errors
    .map((e) => (e.rule ? `${e.rule}: ${e.message}` : e.message))
    .join("; ");
  const error: Error & { status?: number } = new Error(
    `Composition has ${errors.length} lint error(s): ${detail}`,
  );
  error.status = 400;
  throw error;
}
