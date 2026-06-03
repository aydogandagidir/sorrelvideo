import { promises as dns } from "node:dns";
import net from "node:net";

/**
 * SSRF guard for user-supplied URLs (the website→video capture loads an
 * arbitrary URL server-side — a classic Server-Side Request Forgery vector).
 *
 * We reject anything that isn't a plain http(s) URL pointing at a PUBLIC IP:
 * non-http(s) schemes (file:, gopher:, …), embedded credentials, and any
 * hostname that resolves to a loopback / private / link-local / reserved range
 * — most importantly the cloud metadata address 169.254.169.254, the #1 SSRF
 * target. The hostname is resolved and EVERY returned address is checked, so a
 * DNS name pointing at an internal IP is caught too.
 *
 * Residual risk — DNS rebinding (TOCTOU): the name could resolve to a safe IP
 * here and a private IP when the browser later connects. The robust fix is
 * network egress restriction at the infra layer (the render box should not be
 * able to reach internal services at all); this app-level guard is the first
 * line. Documented in DEPLOYMENT.md.
 */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

/** IP ranges that must never be reachable from a user-supplied URL. */
const blocked = new net.BlockList();
// IPv4
blocked.addSubnet("0.0.0.0", 8); // "this" network / unspecified
blocked.addSubnet("10.0.0.0", 8); // RFC1918 private
blocked.addSubnet("100.64.0.0", 10); // CGNAT
blocked.addSubnet("127.0.0.0", 8); // loopback
blocked.addSubnet("169.254.0.0", 16); // link-local (incl. 169.254.169.254 metadata)
blocked.addSubnet("172.16.0.0", 12); // RFC1918 private
blocked.addSubnet("192.0.0.0", 24); // IETF protocol assignments
blocked.addSubnet("192.168.0.0", 16); // RFC1918 private
blocked.addSubnet("198.18.0.0", 15); // benchmarking
blocked.addSubnet("224.0.0.0", 4); // multicast
blocked.addSubnet("240.0.0.0", 4); // reserved
// IPv6
blocked.addAddress("::", "ipv6"); // unspecified
blocked.addAddress("::1", "ipv6"); // loopback
blocked.addSubnet("fc00::", 7, "ipv6"); // unique local (private)
blocked.addSubnet("fe80::", 10, "ipv6"); // link-local
blocked.addSubnet("ff00::", 8, "ipv6"); // multicast
// NOTE: do NOT add ::ffff:0:0/96 here — net.BlockList checks IPv4 addresses
// against IPv4-mapped rules, so that subnet would block ALL IPv4. Explicit
// IPv4-mapped literals (::ffff:127.0.0.1) are handled in isBlockedIp() instead.

/** Hostnames that must never be loaded even before DNS resolution. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "instance-data",
]);

/**
 * Canonicalize a non-canonical / packed IPv4 host to dotted-quad form.
 *
 * `net.isIP()` only recognizes the canonical dotted-decimal notation, so packed
 * forms — decimal (`2130706433`), hex (`0x7f000001`), octal (`0177.0.0.1`), and
 * the 1–3 "part" shorthands `inet_aton` accepts — return 0 and would otherwise
 * skip the IP BlockList and fall through to `dns.lookup`, whose expansion of
 * these forms is platform/libc-dependent (some resolvers happily reach
 * loopback / 169.254.169.254). We reproduce the classic `inet_aton` grammar
 * here so the result is checked against `blocked` deterministically, on every
 * platform, before any DNS happens.
 *
 * Grammar: 1–4 dot-separated parts. Each part is hex (`0x`/`0X` prefix),
 * octal (leading `0`), or decimal. The final part absorbs the remaining
 * low-order bytes (e.g. `127.1` → `127.0.0.1`, `2130706433` → `127.0.0.1`).
 *
 * Returns the dotted-quad string; `null` when the host is plainly not a numeric
 * IPv4 candidate (caller proceeds to hostname/DNS handling); or the
 * `INVALID_NUMERIC_IPV4` sentinel when the host *is* numeric but out of range —
 * the caller rejects that rather than letting a bogus packed integer reach DNS.
 */
const INVALID_NUMERIC_IPV4 = Symbol("invalid-numeric-ipv4");

function canonicalizeNumericIpv4(host: string): string | typeof INVALID_NUMERIC_IPV4 | null {
  const rawParts = host.split(".");
  if (rawParts.length === 0 || rawParts.length > 4) return null;

  // Parse each part per the inet_aton grammar (hex / octal / decimal). Track
  // whether any part is non-canonical-decimal (hex prefix, leading-zero octal)
  // so a plain dotted-decimal quad can be left untouched for net.isIP().
  let looksNumeric = false;
  const values: number[] = [];
  for (const part of rawParts) {
    if (part === "") return null; // empty label (e.g. trailing dot) → not our case
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
      looksNumeric = true;
      value = parseInt(part.slice(2), 16);
    } else if (/^0[0-7]+$/.test(part)) {
      looksNumeric = true;
      value = parseInt(part.slice(1), 8);
    } else if (/^[0-9]+$/.test(part)) {
      value = parseInt(part, 10);
    } else {
      return null; // contains a letter / hostname char → not a numeric IPv4
    }
    if (!Number.isSafeInteger(value) || value < 0) return INVALID_NUMERIC_IPV4;
    values.push(value);
  }

  // A plain dotted-decimal quad with every octet in range is already canonical;
  // defer to net.isIP() so this helper only ever *adds* coverage. Everything
  // else (any hex/octal part, or any <4-part shorthand) is packed below.
  if (!looksNumeric && rawParts.length === 4 && values.every((v) => v <= 255)) {
    return null;
  }

  // inet_aton packing: the last part fills the remaining low-order bytes; each
  // earlier part is exactly one byte.
  const n = values.length;
  const octets = [0, 0, 0, 0];
  for (let i = 0; i < n - 1; i++) {
    if (values[i] > 255) return INVALID_NUMERIC_IPV4;
    octets[i] = values[i];
  }
  const last = values[n - 1];
  const remainingBytes = 4 - (n - 1);
  const maxLast = remainingBytes === 4 ? 0xffffffff : Math.pow(256, remainingBytes) - 1;
  if (last > maxLast) return INVALID_NUMERIC_IPV4;
  for (let b = 0; b < remainingBytes; b++) {
    octets[3 - b] = (last >>> (8 * b)) & 0xff;
  }
  return octets.join(".");
}

function isBlockedIp(ip: string): boolean {
  // IPv4-mapped / -compatible IPv6 — check the embedded IPv4 too. Covers both
  // the dotted form (::ffff:127.0.0.1) and the all-hex form (::ffff:7f00:1).
  const mappedDotted = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mappedDotted && blocked.check(mappedDotted[1], "ipv4")) return true;
  const mappedHex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    const dotted = [(hi >>> 8) & 0xff, hi & 0xff, (lo >>> 8) & 0xff, lo & 0xff].join(".");
    if (blocked.check(dotted, "ipv4")) return true;
  }
  const family = net.isIPv6(ip) ? "ipv6" : "ipv4";
  return blocked.check(ip, family);
}

/**
 * Validate a user-supplied URL for safe server-side fetching. Resolves the host
 * and rejects any private/reserved address. Returns the parsed URL on success;
 * throws SsrfError otherwise.
 */
export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError("Invalid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError("Only http(s) URLs are allowed");
  }
  if (url.username || url.password) {
    throw new SsrfError("URLs with embedded credentials are not allowed");
  }

  const host = url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!host) throw new SsrfError("Missing host");
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new SsrfError(`Host not allowed: ${host}`);
  }

  // Canonicalize packed / non-canonical IPv4 (decimal, hex, octal, shorthand)
  // BEFORE the BlockList check. net.isIP() returns 0 for these, so without this
  // they would skip the IP checks and fall through to DNS — whose expansion is
  // platform-dependent and may reach loopback / 169.254.169.254. After this,
  // such a host is a dotted-quad caught deterministically by isBlockedIp().
  const numericIpv4 = canonicalizeNumericIpv4(host);
  if (numericIpv4 === INVALID_NUMERIC_IPV4) {
    throw new SsrfError(`Host not allowed: ${host}`);
  }
  const effectiveHost = numericIpv4 ?? host;

  let addresses: string[];
  if (net.isIP(effectiveHost)) {
    addresses = [effectiveHost];
  } else {
    try {
      addresses = (await dns.lookup(host, { all: true })).map((a) => a.address);
    } catch {
      throw new SsrfError(`Host does not resolve: ${host}`);
    }
  }
  if (addresses.length === 0) {
    throw new SsrfError(`Host does not resolve: ${host}`);
  }
  for (const ip of addresses) {
    if (isBlockedIp(ip)) {
      throw new SsrfError(`Host resolves to a blocked address (${ip})`);
    }
  }

  return url;
}
