import { describe, expect, it } from "vitest";
import {
  heroCrop,
  bboxToCrop,
  buildCropVars,
  clamp01,
  HERO_PX,
  MIN_CROP_SIZE,
} from "./websiteCrop";

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
