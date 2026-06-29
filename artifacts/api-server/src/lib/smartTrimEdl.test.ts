import { describe, expect, it } from "vitest";
import {
  computeKeepSegments,
  remapWordsToTrimmed,
  totalKeptDuration,
  DEFAULT_FILLER_WORDS,
  type TimedWord,
  type Segment,
} from "./smartTrimEdl";

/**
 * A talking-head clip (duration 10s):
 *   Hello world ··· [2s silence] ··· um this is [0.3s pause] great ··· [trailing silence]
 * Exercises all three trim triggers — filler ("um"), an over-long pause, and
 * leading/trailing dead air — while preserving the short in-sentence pause.
 */
const WORDS: TimedWord[] = [
  { text: "Hello", start: 0.0, end: 0.5 },
  { text: "world", start: 0.5, end: 1.0 },
  { text: "um", start: 3.0, end: 3.3 }, // filler, after a 2s gap
  { text: "this", start: 3.3, end: 3.7 },
  { text: "is", start: 3.7, end: 3.9 },
  { text: "great", start: 4.2, end: 4.8 }, // 0.3s short pause kept
];
const DURATION = 10;

function approx(segs: Segment[]): [number, number][] {
  return segs.map((s) => [
    Math.round(s.start * 1000) / 1000,
    Math.round(s.end * 1000) / 1000,
  ]);
}

describe("computeKeepSegments", () => {
  it("drops fillers, long pauses, and leading/trailing dead air (defaults)", () => {
    const keep = computeKeepSegments(WORDS, DURATION);
    // [0,1.08] (Hello world + tail pad), then [3.3,4.88] (this is great + tail
    // pad). The 2s silence, the "um" filler, the 0.08 pad-sliver before it, and
    // the 5.2s trailing silence are all gone.
    expect(approx(keep)).toEqual([
      [0, 1.08],
      [3.3, 4.88],
    ]);
  });

  it("keeps a short in-sentence pause (≤ threshold) intact", () => {
    const keep = computeKeepSegments(WORDS, DURATION);
    // The 0.3s gap between 'is' (3.9) and 'great' (4.2) is below the 0.6 default,
    // so 'is…great' stays one continuous span — no cut at 3.9.
    const spanning = keep.find((s) => s.start <= 3.9 && s.end >= 4.2);
    expect(spanning).toBeTruthy();
  });

  it("removeSilences:false keeps the long pause but still cuts the filler", () => {
    const keep = computeKeepSegments(WORDS, DURATION, { removeSilences: false });
    // The 2s gap survives, so Hello…this is bridged; only the "um" span [3.0,3.3]
    // is cut → [0,3.0] then [3.3,10].
    expect(approx(keep)).toEqual([
      [0, 3.0],
      [3.3, 10],
    ]);
  });

  it("removeFillers:false keeps the filler word", () => {
    const keep = computeKeepSegments(WORDS, DURATION, { removeFillers: false });
    // No filler cut, so the 2s silence is the only mid cut: [0,1.08] then
    // [2.92,4.88] (um…great, with lead pad before um), trailing silence gone.
    expect(approx(keep)).toEqual([
      [0, 1.08],
      [2.92, 4.88],
    ]);
  });

  it("both toggles off → keep the whole clip (re-encode passthrough)", () => {
    const keep = computeKeepSegments(WORDS, DURATION, {
      removeFillers: false,
      removeSilences: false,
    });
    expect(approx(keep)).toEqual([[0, 10]]);
  });

  it("respects a custom silence threshold", () => {
    // Lower the threshold to 0.2 → the 0.3s in-sentence pause now also gets cut.
    const keep = computeKeepSegments(WORDS, DURATION, {
      silenceThresholdSec: 0.2,
    });
    const cutAtPause = keep.some((s) => Math.abs(s.end - 3.98) < 0.001);
    expect(cutAtPause).toBe(true);
  });

  it("returns the whole clip for an empty transcript", () => {
    expect(computeKeepSegments([], DURATION)).toEqual([{ start: 0, end: 10 }]);
  });

  it("returns the whole clip when every word is a filler", () => {
    const allFiller: TimedWord[] = [
      { text: "um", start: 0.2, end: 0.6 },
      { text: "uh", start: 1.0, end: 1.4 },
    ];
    expect(computeKeepSegments(allFiller, 5)).toEqual([{ start: 0, end: 5 }]);
  });

  it("falls back to the last word end when duration is missing", () => {
    const keep = computeKeepSegments(
      [{ text: "hi", start: 0, end: 2 }],
      0, // unknown duration
    );
    expect(keep).toEqual([{ start: 0, end: 2 }]);
  });

  it("normalizes filler punctuation/case ('Um,' / 'UHH!')", () => {
    const words: TimedWord[] = [
      { text: "Um,", start: 0.0, end: 0.3 },
      { text: "okay", start: 0.3, end: 0.8 },
    ];
    const keep = computeKeepSegments(words, 5, { removeSilences: false });
    // Leading "Um," is dropped (normalized to "um"); "okay" onward survives.
    expect(approx(keep)).toEqual([[0.3, 5]]);
  });

  it("merges an adjacent filler + silence into a single clean cut", () => {
    // "uh" sits right before a long pause; the filler span, the 0.08 pad-sliver,
    // and the silence middle collapse into one contiguous cut (0.5 → 2.92) with
    // no surviving blip between them.
    const words: TimedWord[] = [
      { text: "okay", start: 0.0, end: 0.5 },
      { text: "uh", start: 0.5, end: 0.9 },
      { text: "next", start: 3.0, end: 3.5 },
    ];
    const keep = computeKeepSegments(words, 4);
    expect(approx(keep)).toEqual([
      [0, 0.5],
      [2.92, 4],
    ]);
  });

  it("never returns a sub-minSegment sliver", () => {
    const keep = computeKeepSegments(WORDS, DURATION);
    for (const s of keep) expect(s.end - s.start).toBeGreaterThanOrEqual(0.12);
  });
});

describe("totalKeptDuration", () => {
  it("sums kept spans", () => {
    const keep = computeKeepSegments(WORDS, DURATION);
    expect(totalKeptDuration(keep)).toBeCloseTo(1.08 + 1.58, 6);
  });

  it("is 0 for no segments", () => {
    expect(totalKeptDuration([])).toBe(0);
  });
});

describe("remapWordsToTrimmed", () => {
  const keep = computeKeepSegments(WORDS, DURATION); // [0,1.08], [3.3,4.88]

  it("shifts word times onto the tightened timeline and drops fillers", () => {
    const caps = remapWordsToTrimmed(WORDS, keep);
    expect(caps.map((c) => c.text)).toEqual([
      "Hello",
      "world",
      "this",
      "is",
      "great",
    ]);
    // seg0 maps 1:1; seg1 [3.3,4.88] starts at trimmed 1.08.
    const byText = Object.fromEntries(caps.map((c) => [c.text, c]));
    expect(byText.Hello.start).toBeCloseTo(0.0, 6);
    expect(byText.world.end).toBeCloseTo(1.0, 6);
    expect(byText.this.start).toBeCloseTo(1.08, 6);
    expect(byText.this.end).toBeCloseTo(1.48, 6);
    expect(byText.great.start).toBeCloseTo(1.98, 6);
    expect(byText.great.end).toBeCloseTo(2.58, 6);
  });

  it("drops words that fall entirely inside a cut", () => {
    const segs: Segment[] = [
      { start: 0, end: 1.0 },
      { start: 2.0, end: 3.0 },
    ];
    const words: TimedWord[] = [
      { text: "keep", start: 0.1, end: 0.5 },
      { text: "gone", start: 1.2, end: 1.6 }, // inside the [1.0,2.0] cut
      { text: "after", start: 2.1, end: 2.5 },
    ];
    const caps = remapWordsToTrimmed(words, segs, { removeFillers: false });
    expect(caps.map((c) => c.text)).toEqual(["keep", "after"]);
    // 'after' (2.1) sits 0.1 into seg1, which starts at trimmed 1.0.
    expect(caps[1].start).toBeCloseTo(1.1, 6);
  });

  it("clamps a word straddling a cut to its surviving portion", () => {
    const segs: Segment[] = [{ start: 0, end: 1.0 }];
    const words: TimedWord[] = [{ text: "edge", start: 0.8, end: 1.4 }];
    const caps = remapWordsToTrimmed(words, segs, { removeFillers: false });
    expect(caps).toEqual([{ text: "edge", start: 0.8, end: 1.0 }]);
  });

  it("returns nothing when there are no segments", () => {
    expect(remapWordsToTrimmed(WORDS, [])).toEqual([]);
  });
});

describe("DEFAULT_FILLER_WORDS", () => {
  it("covers the common non-lexical fillers and excludes real vocabulary", () => {
    expect(DEFAULT_FILLER_WORDS).toContain("um");
    expect(DEFAULT_FILLER_WORDS).toContain("uh");
    expect(DEFAULT_FILLER_WORDS).not.toContain("like");
    expect(DEFAULT_FILLER_WORDS).not.toContain("so");
  });
});
