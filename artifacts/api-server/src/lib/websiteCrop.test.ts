import { describe, expect, it } from "vitest";
import {
  heroCrop,
  bboxToCrop,
  buildCropVars,
  regionCrop,
  buildTour,
  clamp01,
  HERO_PX,
  MIN_CROP_SIZE,
  TOUR_INTRO_SECONDS,
  TOUR_OUTRO_SECONDS,
  TOUR_TRANSITION_SECONDS,
  TOUR_MAX_BEATS,
} from "./websiteCrop";

const SECTIONS = [
  { crop: { x: 0, y: 0, w: 1, h: 0.2 } }, // 0: hero
  { crop: { x: 0, y: 0.3, w: 1, h: 0.2 } }, // 1: middle
  { crop: { x: 0, y: 0.7, w: 1, h: 0.2 } }, // 2: contact
];

describe("clamp01", () => {
  it("clamps to [0,1] and treats non-finite as 0", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.4)).toBe(0.4);
    expect(clamp01(Number.NaN)).toBe(0);
  });
});

describe("heroCrop", () => {
  it("features the top viewport-height of a tall page", () => {
    const c = heroCrop(4000);
    expect(c).toEqual({ x: 0, y: 0, w: 1, h: HERO_PX / 4000 });
  });

  it("is the whole page when the page is shorter than the viewport", () => {
    expect(heroCrop(500)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("never divides by zero", () => {
    expect(heroCrop(0)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe("bboxToCrop", () => {
  it("maps a pixel bbox to capture fractions", () => {
    const c = bboxToCrop(
      { x: 128, y: 800, width: 640, height: 400 },
      1280,
      4000,
    );
    expect(c.x).toBeCloseTo(0.1);
    expect(c.y).toBeCloseTo(0.2);
    expect(c.w).toBeCloseTo(0.5);
    expect(c.h).toBeCloseTo(0.1);
  });

  it("clamps out-of-bounds boxes and floors a zero-area element", () => {
    const c = bboxToCrop(
      { x: -50, y: 9999, width: 0, height: 0 },
      1280,
      4000,
    );
    expect(c.x).toBe(0);
    expect(c.y).toBe(1);
    expect(c.w).toBe(MIN_CROP_SIZE);
    expect(c.h).toBe(MIN_CROP_SIZE);
  });

  it("degrades to whole page on a bad capture size", () => {
    expect(bboxToCrop({ x: 0, y: 0, width: 10, height: 10 }, 0, 0)).toEqual({
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    });
  });
});

describe("buildCropVars", () => {
  it("returns no vars for a whole-page render", () => {
    expect(buildCropVars(undefined)).toEqual({});
  });

  it("emits safe numeric strings (digits + dot only)", () => {
    const vars = buildCropVars({ x: 0.25, y: 0.5, w: 0.4, h: 0.3 });
    expect(vars).toEqual({
      "capture.cropX": "0.25",
      "capture.cropY": "0.5",
      "capture.cropW": "0.4",
      "capture.cropH": "0.3",
    });
    for (const v of Object.values(vars)) expect(v).toMatch(/^[0-9.]+$/);
  });

  it("clamps + floors hostile values so nothing breaks the literal", () => {
    const vars = buildCropVars({ x: -5, y: 9, w: 0, h: 0 });
    expect(vars["capture.cropX"]).toBe("0");
    expect(vars["capture.cropY"]).toBe("1");
    expect(vars["capture.cropW"]).toBe(String(MIN_CROP_SIZE));
    expect(vars["capture.cropH"]).toBe(String(MIN_CROP_SIZE));
  });

  it("never emits exponential notation for a sub-1e-6 fraction (the numeric gate would 400 it)", () => {
    // String(1e-7) === "1e-7" — which fails findUnsafeCompositionVar's NUMERIC
    // gate. cropToken must snap such tiny fractions to a plain "0".
    const vars = buildCropVars({ x: 0.0000001, y: 5e-7, w: 0.5, h: 0.5 });
    expect(vars["capture.cropX"]).toBe("0");
    expect(vars["capture.cropY"]).toBe("0");
    for (const v of Object.values(vars)) {
      expect(v).toMatch(/^\d+(\.\d+)?$/); // bare number, never exponential
      expect(v).not.toContain("e");
    }
  });
});

describe("buildTour", () => {
  it("maps ordered picks to beats + matches the composition's duration formula", () => {
    const out = buildTour(
      [
        { index: 0, seconds: 3, caption: "Hero" },
        { index: 2, seconds: 2, caption: "Contact" },
      ],
      SECTIONS,
    );
    expect(out).not.toBeNull();
    expect(out?.beats).toHaveLength(2);
    // Order preserved; crops come from the referenced sections.
    expect(out?.beats[0].cropY).toBe(0);
    expect(out?.beats[1].cropY).toBe(0.7);
    expect(out?.beats[0].caption).toBe("Hero");
    // duration = intro + holds(3+2) + (2-1)*transition + outro
    const expected =
      Math.round(
        (TOUR_INTRO_SECONDS +
          5 +
          1 * TOUR_TRANSITION_SECONDS +
          TOUR_OUTRO_SECONDS) *
          10,
      ) / 10;
    expect(out?.duration).toBe(expected);
  });

  it("drops out-of-range + duplicate indexes (order kept)", () => {
    const out = buildTour(
      [
        { index: 0, seconds: 2 },
        { index: 9, seconds: 2 }, // out of range → dropped
        { index: 0, seconds: 2 }, // duplicate → dropped
        { index: 1, seconds: 2 },
      ],
      SECTIONS,
    );
    expect(out?.beats.map((b) => b.cropY)).toEqual([0, 0.3]);
  });

  it("clamps the hold seconds into [1.5, 6]", () => {
    const out = buildTour(
      [
        { index: 0, seconds: 99 },
        { index: 1, seconds: 0.1 },
      ],
      SECTIONS,
    );
    expect(out?.beats[0].seconds).toBe(6);
    expect(out?.beats[1].seconds).toBe(1.5);
  });

  it("caps the beat count at TOUR_MAX_BEATS", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      crop: { x: 0, y: i / 10, w: 1, h: 0.1 },
    }));
    const out = buildTour(
      many.map((_, i) => ({ index: i, seconds: 2 })),
      many,
    );
    expect(out?.beats.length).toBe(TOUR_MAX_BEATS);
  });

  it("returns null when no pick is valid (caller falls back to scroll)", () => {
    expect(buildTour([{ index: 99, seconds: 2 }], SECTIONS)).toBeNull();
    expect(buildTour([], SECTIONS)).toBeNull();
  });

  it("floors a zero-size crop so a beat can't zoom to infinity", () => {
    const out = buildTour(
      [{ index: 0, seconds: 2 }],
      [{ crop: { x: 0, y: 0, w: 0, h: 0 } }],
    );
    expect(out?.beats[0].cropW).toBe(MIN_CROP_SIZE);
    expect(out?.beats[0].cropH).toBe(MIN_CROP_SIZE);
  });
});

describe("regionCrop", () => {
  it("whole = the full page (explicit 0,0,1,1 so it RESETS a prior crop)", () => {
    expect(regionCrop("whole", 5000)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("hero = the top viewport (matches heroCrop)", () => {
    expect(regionCrop("hero", 4000)).toEqual(heroCrop(4000));
    // HERO_PX / 4000 = 0.2
    expect(regionCrop("hero", 4000).h).toBeCloseTo(HERO_PX / 4000, 6);
  });

  it("top / bottom = the upper / lower half", () => {
    expect(regionCrop("top", 3000)).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(regionCrop("bottom", 3000)).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
  });
});
