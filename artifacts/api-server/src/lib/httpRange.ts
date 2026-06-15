/**
 * Parse a single HTTP `Range: bytes=...` header against a known total size and
 * return the inclusive `{ start, end }` byte offsets to serve, or `null` when the
 * range is unsatisfiable / malformed (the caller responds `416` with
 * `Content-Range: bytes *\/<total>`).
 *
 * Replaces a hand-rolled parser in the video route that had two bugs:
 *   - a SUFFIX range (`bytes=-N`, meaning "the last N bytes") served the FIRST N
 *     bytes under a false `206`, because an empty first capture group defaulted
 *     `start` to 0;
 *   - an INVERTED range (`bytes=500-100`) produced a negative Content-Length and
 *     threw inside `createReadStream` (a 500) instead of a clean `416`.
 *
 * Supported forms:
 *   - `bytes=START-END`  explicit, inclusive (END past EOF is clamped to total-1)
 *   - `bytes=START-`     open-ended, to EOF
 *   - `bytes=-N`         suffix, the last N bytes (N >= total → whole resource)
 * Multi-range (`bytes=0-9,20-29`) is intentionally NOT supported → `null`.
 */
export function resolveByteRange(
  rangeHeader: string,
  total: number,
): { start: number; end: number } | null {
  if (!Number.isFinite(total) || total <= 0) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;

  const startStr = match[1];
  const endStr = match[2];
  if (!startStr && !endStr) return null; // "bytes=-" is malformed

  let start: number;
  let end: number;

  if (!startStr) {
    // Suffix range: the LAST N bytes.
    const suffix = parseInt(endStr, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr ? parseInt(endStr, 10) : total - 1;
    // A client may request past EOF; clamp the end to the last byte (RFC 7233).
    if (end >= total) end = total - 1;
  }

  // Unsatisfiable: start past EOF, or an inverted range (start > end).
  if (start < 0 || start >= total || start > end) return null;

  return { start, end };
}
