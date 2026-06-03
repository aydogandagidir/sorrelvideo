import { describe, expect, it } from "vitest";
import { assertSafeUrl, SsrfError } from "./ssrfGuard";

describe("assertSafeUrl", () => {
  it("accepts a public URL (public IP literal — deterministic, no DNS)", async () => {
    const url = await assertSafeUrl("https://8.8.8.8/path?q=1");
    expect(url.hostname).toBe("8.8.8.8");
    expect(url.protocol).toBe("https:");
  });

  it.each([
    "file:///etc/passwd",
    "ftp://example.com/",
    "gopher://example.com/",
    "data:text/html,<h1>x</h1>",
  ])("rejects non-http(s) scheme: %s", async (u) => {
    await expect(assertSafeUrl(u)).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects embedded credentials (no DNS reached)", async () => {
    await expect(assertSafeUrl("http://user:pass@8.8.8.8/")).rejects.toBeInstanceOf(
      SsrfError,
    );
  });

  it.each(["http://localhost/", "http://metadata.google.internal/", "http://metadata/"])(
    "rejects a blocked hostname: %s",
    async (u) => {
      await expect(assertSafeUrl(u)).rejects.toBeInstanceOf(SsrfError);
    },
  );

  it.each([
    "http://127.0.0.1/",
    "http://10.0.0.5/",
    "http://172.16.3.4/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/", // cloud metadata — prime SSRF target
    "http://100.64.0.1/", // CGNAT
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[fe80::1]/",
    "http://[fc00::1]/",
  ])("rejects a private/reserved address: %s", async (u) => {
    await expect(assertSafeUrl(u)).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects a malformed URL", async () => {
    await expect(assertSafeUrl("not a url")).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects an IPv4-mapped IPv6 loopback", async () => {
    await expect(assertSafeUrl("http://[::ffff:127.0.0.1]/")).rejects.toBeInstanceOf(
      SsrfError,
    );
  });

  it.each([
    "http://[::ffff:7f00:1]/", // ::ffff:127.0.0.1 in all-hex form
    "http://[::ffff:a9fe:a9fe]/", // ::ffff:169.254.169.254 (metadata) in all-hex form
  ])("rejects an IPv4-mapped IPv6 in hex form: %s", async (u) => {
    await expect(assertSafeUrl(u)).rejects.toBeInstanceOf(SsrfError);
  });

  // Non-canonical / packed IPv4 encodings must canonicalize to dotted-quad and
  // be caught by the BlockList BEFORE any DNS lookup — net.isIP() returns 0 for
  // these, so otherwise they'd reach dns.lookup, whose libc expansion of packed
  // forms can hit loopback / 169.254.169.254 on some platforms.
  it.each([
    "http://2130706433/", // decimal 127.0.0.1 (loopback)
    "http://0x7f000001/", // hex 127.0.0.1
    "http://0177.0.0.1/", // octal-leading 127.0.0.1
    "http://017700000001/", // single octal packed 127.0.0.1
    "http://127.1/", // inet_aton shorthand → 127.0.0.1
    "http://0/", // → 0.0.0.0 (this-network)
    "http://2852039166/", // decimal 169.254.169.254 (cloud metadata)
    "http://0xa9fea9fe/", // hex 169.254.169.254
    "http://0251.0376.0251.0376/", // octal 169.254.169.254
  ])("rejects a non-canonical/packed IPv4 form: %s", async (u) => {
    await expect(assertSafeUrl(u)).rejects.toBeInstanceOf(SsrfError);
  });

  it("still accepts a canonical public dotted-quad (numeric guard is additive)", async () => {
    const url = await assertSafeUrl("https://1.2.3.4/");
    expect(url.hostname).toBe("1.2.3.4");
  });
});
