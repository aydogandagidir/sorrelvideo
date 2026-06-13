/**
 * Server-side validation for a project's `compositionVars` against the typed
 * variable declarations its template exposes (the engine's native
 * `data-composition-variables`). The render path forwards `compositionVars` to
 * `config.variables`, and a `color`-typed variable lands UNQUOTED in composition
 * CSS — but it is NOT one of `lib/compositionVars`'s fixed COLOR_KEYS, so without
 * this check a typed color would reach the render unvalidated. This closes that
 * gap at the write path (POST/PATCH project), per-declared-type:
 *   - color   → reuse `isSafeCssColor`
 *   - number  → finite numeric string within [min, max]
 *   - boolean → exactly "true" | "false"
 *   - enum    → value ∈ declared options
 *   - string  → within maxLength (if declared)
 * Keys with no matching declaration are left untouched (the existing
 * `escapeMarkup` contract + `findUnsafeCompositionVar` already cover the
 * brand/URL/attribute contexts).
 */
import type { CompositionVariable } from "@hyperframes/core";
import { isSafeCssColor } from "./compositionVars";

export interface InvalidTypedVar {
  key: string;
  reason: string;
}

/**
 * Returns the first invalid `{ key, reason }` among `vars` that violates its
 * declared type, or `null` when every declared var is valid. Unknown keys (no
 * matching declaration) are ignored.
 */
export function findInvalidTypedVar(
  vars: Record<string, string>,
  variables: CompositionVariable[],
): InvalidTypedVar | null {
  const byId = new Map(variables.map((v) => [v.id, v]));

  for (const [key, raw] of Object.entries(vars)) {
    const decl = byId.get(key);
    if (!decl) continue; // not a typed variable — other guards own it
    const value = String(raw);

    switch (decl.type) {
      case "color":
        if (!isSafeCssColor(value)) {
          return { key, reason: `"${key}" must be a safe CSS color` };
        }
        break;
      case "number": {
        const n = Number(value);
        if (!Number.isFinite(n)) {
          return { key, reason: `"${key}" must be a number` };
        }
        if (decl.min !== undefined && n < decl.min) {
          return { key, reason: `"${key}" must be >= ${decl.min}` };
        }
        if (decl.max !== undefined && n > decl.max) {
          return { key, reason: `"${key}" must be <= ${decl.max}` };
        }
        break;
      }
      case "boolean":
        if (value !== "true" && value !== "false") {
          return { key, reason: `"${key}" must be "true" or "false"` };
        }
        break;
      case "enum":
        if (!decl.options.some((o) => o.value === value)) {
          return { key, reason: `"${key}" must be one of the allowed options` };
        }
        break;
      case "string":
        if (decl.maxLength !== undefined && value.length > decl.maxLength) {
          return {
            key,
            reason: `"${key}" must be at most ${decl.maxLength} characters`,
          };
        }
        break;
    }
  }

  return null;
}
