/**
 * Normalize a user-pasted website URL for the website→video capture.
 *
 * Users routinely paste a bare host ("bluedev.dev") with no scheme. `new URL()`
 * — and therefore `assertSafeUrl` — rejects that as "Invalid URL", which the SPA
 * surfaces as a confusing "make sure the URL is a public, reachable site" error.
 * We default the scheme to https:// when none is present so the common case just
 * works.
 *
 * SECURITY: this is ONLY a convenience normalization. `assertSafeUrl`
 * (in websiteCaptureService) still runs on the result and enforces every SSRF
 * rule — http(s)-only scheme, no embedded credentials, blocked hostnames
 * (localhost, cloud metadata), and no private/reserved/loopback IP. Prefixing
 * `https://` cannot reach anything new: a scheme-less internal target like
 * `localhost` / `169.254.169.254` / `10.0.0.1` was rejected before (unparseable)
 * and is still rejected after (by the hostname/IP block lists). Inputs that are
 * not a plain host (`javascript:alert(1)`, `ftp://x`) become an invalid URL once
 * prefixed and are rejected downstream just the same.
 */
export function normalizeWebsiteUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return trimmed;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
