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

function isBlockedIp(ip: string): boolean {
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) — check the embedded IPv4 too.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped && blocked.check(mapped[1], "ipv4")) return true;
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

  let addresses: string[];
  if (net.isIP(host)) {
    addresses = [host];
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
