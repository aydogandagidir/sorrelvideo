import { describe, expect, it } from "vitest";
import { resolveByteRange } from "./httpRange";

describe("resolveByteRange", () => {
  const TOTAL = 1000; // a 1000-byte resource (bytes 0..999)

  it("parses an explicit inclusive range", () => {
    expect(resolveByteRange("bytes=0-499", TOTAL)).toEqual({
      start: 0,
      end: 499,
    });
    expect(resolveByteRange("bytes=200-299", TOTAL)).toEqual({
      start: 200,
      end: 299,
    });
  });

  it("parses an open-ended range to EOF", () => {
    expect(resolveByteRange("bytes=500-", TOTAL)).toEqual({
      start: 500,
      end: 999,
    });
  });

  it("serves the LAST N bytes for a suffix range (the bug: was serving the first N)", () => {
    expect(resolveByteRange("bytes=-500", TOTAL)).toEqual({
      start: 500,
      end: 999,
    });
    expect(resolveByteRange("bytes=-1", TOTAL)).toEqual({
      start: 999,
      end: 999,
    });
  });

  it("treats a suffix >= total as the whole resource", () => {
    expect(resolveByteRange("bytes=-5000", TOTAL)).toEqual({
      start: 0,
      end: 999,
    });
  });

  it("clamps an end past EOF to the last byte", () => {
    expect(resolveByteRange("bytes=900-100000", TOTAL)).toEqual({
      start: 900,
      end: 999,
    });
  });

  it("rejects an inverted range (the bug: was a 500, must be 416)", () => {
    expect(resolveByteRange("bytes=500-100", TOTAL)).toBeNull();
  });

  it("rejects a start at/after EOF", () => {
    expect(resolveByteRange("bytes=1000-", TOTAL)).toBeNull();
    expect(resolveByteRange("bytes=1500-1600", TOTAL)).toBeNull();
  });

  it("rejects malformed, multi-range, and empty inputs", () => {
    expect(resolveByteRange("bytes=-", TOTAL)).toBeNull();
    expect(resolveByteRange("bytes=-0", TOTAL)).toBeNull();
    expect(resolveByteRange("bytes=abc-def", TOTAL)).toBeNull();
    expect(resolveByteRange("bytes=0-9,20-29", TOTAL)).toBeNull();
    expect(resolveByteRange("items=0-9", TOTAL)).toBeNull();
    expect(resolveByteRange("", TOTAL)).toBeNull();
  });

  it("rejects any range against an empty resource", () => {
    expect(resolveByteRange("bytes=0-0", 0)).toBeNull();
  });
});
