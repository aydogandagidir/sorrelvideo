/**
 * Validate the brand-kit `logoUrl` at SAVE time.
 *
 * The logo URL is later substituted into the logo-outro composition as
 * `<img class="brand-logo" src="{{brand.logoUrl}}">`. `renderCompositionTemplate`
 * markup-escapes `brand.*` values (`& < >`) but deliberately leaves QUOTES intact
 * (so CSS like `font-family: 'Inter'` survives) — which means a hostile logoUrl
 * containing a `"` could close the `src="…"` attribute and inject arbitrary HTML
 * attributes/markup. Rather than globally quote-escape every brand value (which
 * would break the single-quoted fontFamily), we validate the logoUrl up front and
 * reject anything that isn't a clean, plain http(s) URL.
 *
 * This is a syntactic / injection check, NOT an SSRF check: we never fetch this
 * URL server-side (the browser loads it when rendering the composition), so the
 * concern is attribute breakout, not internal network access. An empty / unset
 * value is allowed — the composition falls back to its abstract logo shape.
 */

// Characters that could break out of a double-quoted HTML attribute or inject
// markup once the value lands in `src="…"`: quotes, angle brackets and the
// backtick are the breakout vectors. Whitespace (spaces, tabs, newlines) has no
// place in a URL and is a common obfuscation trick, so it is rejected too.
const UNSAFE_URL_CHARS = /["'<>`\s]/;

/**
 * True when `value` is a safe, plain http(s) URL suitable for injection into an
 * HTML `src` attribute. Empty / nullish is treated as "no logo" and is allowed.
 */
export function isSafeLogoUrl(value: string | null | undefined): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (UNSAFE_URL_CHARS.test(value)) return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  // Embedded credentials (user:pass@host) have no business in a logo URL and are
  // a phishing / obfuscation vector — reject them.
  if (url.username || url.password) return false;
  return true;
}
