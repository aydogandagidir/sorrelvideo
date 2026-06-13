import { describe, expect, it } from "vitest";
import type { CompositionVariable } from "@hyperframes/core";
import { findInvalidTypedVar } from "./typedVars";

const VARS: CompositionVariable[] = [
  { id: "title", type: "string", label: "Title", default: "x", maxLength: 5 },
  {
    id: "max",
    type: "number",
    label: "Max",
    default: 10,
    min: 1,
    max: 100,
  },
  { id: "accent", type: "color", label: "Accent", default: "#fff" },
  { id: "loop", type: "boolean", label: "Loop", default: false },
  {
    id: "mode",
    type: "enum",
    label: "Mode",
    default: "a",
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ],
  },
];

describe("findInvalidTypedVar", () => {
  it("returns null when every declared var is valid", () => {
    expect(
      findInvalidTypedVar(
        { title: "hello", max: "50", accent: "#abcdef", loop: "true", mode: "b" },
        VARS,
      ),
    ).toBeNull();
  });

  it("ignores keys with no matching declaration (other guards own them)", () => {
    expect(
      findInvalidTypedVar({ "user.headline": "anything at all" }, VARS),
    ).toBeNull();
  });

  it("rejects a non-numeric number", () => {
    expect(findInvalidTypedVar({ max: "abc" }, VARS)?.key).toBe("max");
  });

  it("enforces number min/max bounds", () => {
    expect(findInvalidTypedVar({ max: "0" }, VARS)?.key).toBe("max");
    expect(findInvalidTypedVar({ max: "101" }, VARS)?.key).toBe("max");
    expect(findInvalidTypedVar({ max: "1" }, VARS)).toBeNull();
    expect(findInvalidTypedVar({ max: "100" }, VARS)).toBeNull();
  });

  it("rejects an unsafe color but accepts a hex", () => {
    expect(findInvalidTypedVar({ accent: "red; url(x)" }, VARS)?.key).toBe(
      "accent",
    );
    expect(findInvalidTypedVar({ accent: "#112233" }, VARS)).toBeNull();
  });

  it("requires a boolean to be exactly true/false", () => {
    expect(findInvalidTypedVar({ loop: "yes" }, VARS)?.key).toBe("loop");
    expect(findInvalidTypedVar({ loop: "false" }, VARS)).toBeNull();
  });

  it("enforces enum membership", () => {
    expect(findInvalidTypedVar({ mode: "c" }, VARS)?.key).toBe("mode");
    expect(findInvalidTypedVar({ mode: "a" }, VARS)).toBeNull();
  });

  it("enforces string maxLength", () => {
    expect(findInvalidTypedVar({ title: "way too long" }, VARS)?.key).toBe(
      "title",
    );
    expect(findInvalidTypedVar({ title: "ok" }, VARS)).toBeNull();
  });
});
