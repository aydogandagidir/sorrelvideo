/**
 * Validate a project's `compositionVars` at SAVE time — the companion to the
 * brand-kit `isSafeLogoUrl` guard, extended to every write path that can set
 * `compositionVars` (POST /projects, PATCH /projects/:id, the website→video
 * service).
 *
 * WHY: `renderService.buildVarMap` overlays `project.compositionVars` over the
 * brand kit with no validation, and `renderCompositionTemplate`'s `escapeMarkup`
 * only escapes `& < >` — it deliberately leaves QUOTES intact so CSS like
 * `font-family: 'Inter'` survives. That escaping contract is safe for values
 * rendered as HTML *text content*, but several composition placeholders land in
 * dangerous syntactic contexts where an attacker-controlled value can break out:
 *
 *   - `brand.logoUrl` → `<img src="{{brand.logoUrl}}">` (logo-outro.html). A `"`
 *     closes the attribute and the rest becomes live markup (`onerror=…`).
 *   - `capture.image`  → `<img src="{{capture.image}}">` (website-showcase.html).
 *     Same attribute-breakout vector; legitimately a `data:image/*;base64,…` URI.
 *   - `brand.{primary,secondary,accent}Color` → injected UNQUOTED into `<style>`
 *     and SVG `fill`/`stroke` (data-chart, product-launch, website-showcase, …).
 *     A crafted value can inject a CSS `url(…)` (exfiltration) or extra
 *     declarations.
 *   - numeric keys (`duration`, `capture.height`, `capture.crop{X,Y,W,H}`,
 *     `layout.{width,height}`, `sorrel.transitionsActive`) → substituted into JS
 *     `parseInt("{{…}}")` / `parseFloat("{{…}}")` (website-showcase.html) and
 *     double-quoted attributes (`data-duration="{{…}}"` in talking-host,
 *     video-spotlight, website-showcase). A `"` breaks out of the JS string
 *     literal / attribute → arbitrary script in the app origin, with NO angle
 *     brackets needed (so `escapeMarkup`'s `< > &` escaping is irrelevant).
 *   - `layout.aspect` → a bare enum token (`portrait|landscape|square`) in the
 *     same JS-string / attribute contexts.
 *   - `brand.fontFamily` → injected UNQUOTED into a CSS `font-family:` declaration
 *     (`font-family: {{brand.fontFamily}}, "Segoe UI"`). The brand-WRITE path
 *     validates it (brandKitService `SAFE_FONT`), but a `compositionVars` override
 *     replaces the brand-snapshot value in `buildVarMap`, bypassing that gate —
 *     so the same shape is enforced here.
 *
 * This is owner-scoped today, but it voids the escaping contract and becomes a
 * stored-XSS the moment any shared/public preview lands. So we validate at the
 * write point — BEFORE the value can ever reach a render — and 400 on violation,
 * mirroring the brand-kit logoUrl rejection.
 *
 * Like `isSafeLogoUrl`, this is a SYNTACTIC / injection check, not an SSRF check
 * (the browser, not the server, loads these URLs when rendering the composition).
 *
 * Keys NOT listed here are left to the template layer's `escapeMarkup`, which
 * neutralizes the `< > &` markup-breakout vectors for text/CSS-text content.
 */
import { isSafeLogoUrl } from "./logoUrl";

/**
 * compositionVars keys whose value is injected into an HTML attribute that
 * expects a URL/`src` (`<img src="{{key}}">`). The value must be safe to drop
 * between the double quotes verbatim.
 *
 * - `"http"`  → only a clean http(s) URL is allowed (via `isSafeLogoUrl`).
 * - `"image"` → an http(s) URL OR an inline image `data:` URI (the website→video
 *   capture embeds the screenshot as `data:image/png;base64,…`). Either way it
 *   must contain no attribute-breakout characters.
 */
const URL_ATTRIBUTE_KEYS: Readonly<Record<string, "http" | "image">> = {
  "brand.logoUrl": "http",
  "capture.image": "image",
};

/**
 * compositionVars keys whose value is injected UNQUOTED into a CSS / SVG paint
 * context (`background: {{key}}`, `fill="{{key}}"`, `linear-gradient(…, {{key}})`,
 * and `{{key}}66` hex-alpha concatenation). The value must be a bare color token
 * that cannot introduce a new declaration, a `url(…)`, or markup.
 */
const COLOR_KEYS: readonly string[] = [
  "brand.primaryColor",
  "brand.secondaryColor",
  "brand.accentColor",
];

/**
 * compositionVars keys whose value is substituted into a JS NUMERIC context
 * (`parseInt("{{key}}")` / `parseFloat("{{key}}")`) or a double-quoted HTML
 * attribute (`data-duration="{{key}}"`). Because `escapeMarkup` leaves quotes
 * intact, a `"` here breaks out of the JS string literal / attribute and injects
 * script. Every legitimate producer (website→video capture, `buildCropVars`,
 * talkingHost, render dimensions) emits a plain number, so a bare numeric token
 * is required. `layout.{width,height}` and `sorrel.transitionsActive` are
 * server-managed on the RENDER path (overwritten after the merge) but remain
 * user-overridable on the `?vars=` PREVIEW path, so they are gated here too.
 */
const NUMERIC_KEYS: readonly string[] = [
  "duration",
  "capture.height",
  "capture.cropX",
  "capture.cropY",
  "capture.cropW",
  "capture.cropH",
  "layout.width",
  "layout.height",
  "sorrel.transitionsActive",
];

/**
 * compositionVars keys substituted into a JS string / attribute as a bare ENUM
 * token (`data-aspect="{{layout.aspect}}"`, `"{{layout.aspect}}" === "1"`-style
 * comparisons). Allow only a leading-letter identifier so a quote can't break
 * out. Legit values: `portrait | landscape | square`.
 */
const TOKEN_KEYS: readonly string[] = ["layout.aspect"];

/**
 * compositionVars keys substituted UNQUOTED into a CSS declaration
 * (`font-family: {{brand.fontFamily}}, "Segoe UI"`). A `;` / `}` / `(` / quote
 * would inject a second declaration or an exfiltrating `url(…)`. Mirrors
 * `brandKitService`'s `SAFE_FONT` so a compositionVars override is held to the
 * same shape the brand-write path enforces.
 */
const FONT_KEYS: readonly string[] = ["brand.fontFamily"];

/** A bare number: integer or decimal — no sign, exponent, quote, or whitespace. */
const NUMERIC_TOKEN = /^\d+(\.\d+)?$/;

/** A bare identifier: leading letter, then letters / digits / `_` / `-`. */
const IDENTIFIER_TOKEN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** A safe bare font-family name (mirrors brandKitService `SAFE_FONT`). */
const SAFE_FONT_TOKEN = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}$/;

/**
 * Characters that would break out of a double-quoted HTML attribute or inject
 * markup once a value lands in `src="…"`. Shared shape with `isSafeLogoUrl`'s
 * `UNSAFE_URL_CHARS`; whitespace has no place in a URL/data-URI and is a common
 * obfuscation trick, so it is rejected too.
 */
const ATTRIBUTE_BREAKOUT_CHARS = /["'<>`\s]/;

/**
 * A safe inline IMAGE data URI: `data:image/<type>;base64,<base64>`. The base64
 * alphabet (`A-Za-z0-9+/=`) contains none of the attribute-breakout characters,
 * so a value matching this is safe to inline into `src="…"`. Restricting to a
 * raster `image/*` subtype (no `svg+xml`, which can carry markup) keeps the
 * surface minimal — the only legitimate producer is the website→video capture,
 * which always emits `image/png`.
 */
const IMAGE_DATA_URI =
  /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/]+=*$/;

/**
 * A strict CSS color token: a hex color (`#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa`) or
 * a functional `rgb()/rgba()/hsl()/hsla()` whose arguments are restricted to
 * digits, `.`, `,`, `%`, `/` and whitespace. This deliberately rejects named
 * colors, `var(…)`, and — crucially — anything containing `;`, `(` other than the
 * single function call, `url(`, quotes, or angle brackets, so it cannot inject a
 * second declaration or an exfiltrating `url(…)` into the `<style>` block.
 *
 * Empty / nullish is treated as "unset" (the composition falls back to a default)
 * and is allowed, matching `isSafeLogoUrl`.
 */
export function isSafeCssColor(value: string | null | undefined): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (/^#[0-9a-fA-F]{3,8}$/.test(value)) {
    // Only 3/4/6/8 hex digits are real colors; 5/7 are not.
    const len = value.length - 1;
    return len === 3 || len === 4 || len === 6 || len === 8;
  }
  return /^(rgb|rgba|hsl|hsla)\([0-9.,%/\s]+\)$/.test(value);
}

/** True when `value` is safe to inline into an `<img src="…">` attribute. */
function isSafeImageSrc(value: string): boolean {
  if (ATTRIBUTE_BREAKOUT_CHARS.test(value)) return false;
  if (IMAGE_DATA_URI.test(value)) return true;
  return isSafeLogoUrl(value);
}

/** A single offending entry: which key failed and a human-readable reason. */
export interface UnsafeCompositionVar {
  key: string;
  reason: string;
}

/**
 * Scan a `compositionVars` map and return the FIRST entry that would be unsafe to
 * substitute into its composition context, or `null` when every value is safe.
 *
 * Only the known dangerous keys (URL/attribute + color) are constrained; every
 * other key is left to the template layer's markup-escaping. Non-string values
 * are ignored here (the route's Zod layer already constrains values to strings;
 * the render merge also skips non-strings).
 */
export function findUnsafeCompositionVar(
  vars: Record<string, unknown> | null | undefined,
): UnsafeCompositionVar | null {
  if (!vars) return null;

  for (const [key, value] of Object.entries(vars)) {
    if (typeof value !== "string") continue;

    const urlKind = URL_ATTRIBUTE_KEYS[key];
    if (urlKind === "http" && !isSafeLogoUrl(value)) {
      return { key, reason: `${key} must be a valid http(s) URL` };
    }
    if (urlKind === "image" && !isSafeImageSrc(value)) {
      return {
        key,
        reason: `${key} must be a valid http(s) URL or an image data URI`,
      };
    }

    if (COLOR_KEYS.includes(key) && !isSafeCssColor(value)) {
      return {
        key,
        reason: `${key} must be a hex (#rgb/#rrggbb), rgb()/rgba(), or hsl()/hsla() color`,
      };
    }

    // Empty is "unset" (the composition falls back to a default), matching the
    // URL/color checks; `buildVarMap` also skips empty values at merge time.
    if (NUMERIC_KEYS.includes(key) && value !== "" && !NUMERIC_TOKEN.test(value)) {
      return {
        key,
        reason: `${key} must be a plain number (no quotes or other characters)`,
      };
    }

    if (TOKEN_KEYS.includes(key) && value !== "" && !IDENTIFIER_TOKEN.test(value)) {
      return {
        key,
        reason: `${key} must be a bare token (letters, digits, "-", "_")`,
      };
    }

    if (FONT_KEYS.includes(key) && value !== "" && !SAFE_FONT_TOKEN.test(value)) {
      return {
        key,
        reason: `${key} must be a plain font name (letters, digits, spaces, "-", "_")`,
      };
    }
  }

  return null;
}

/** Thrown by `assertSafeCompositionVars` (service layer) on the first violation. */
export class UnsafeCompositionVarError extends Error {
  readonly key: string;
  constructor(violation: UnsafeCompositionVar) {
    super(violation.reason);
    this.name = "UnsafeCompositionVarError";
    this.key = violation.key;
  }
}

/**
 * Throwing wrapper for service-layer callers (e.g. websiteToVideoService) that
 * can't return an HTTP status directly. Routes that already have `res` should
 * prefer `findUnsafeCompositionVar` and emit a 400 themselves.
 */
export function assertSafeCompositionVars(
  vars: Record<string, unknown> | null | undefined,
): void {
  const violation = findUnsafeCompositionVar(vars);
  if (violation) throw new UnsafeCompositionVarError(violation);
}
