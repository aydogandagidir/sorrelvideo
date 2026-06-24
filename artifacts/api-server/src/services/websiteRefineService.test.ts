import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Unit test for the website→video prompt-refine mapping. The provider (LLM) and
 * the billing quota are mocked, so this runs DB-free and proves the SERVER-side
 * logic: clamp the duration, map the region enum to a server-computed crop,
 * return ONLY the changed vars, charge quota after success, and reject
 * non-applicable projects before spending the model call.
 */

const refineWebsiteVideo = vi.fn();
const checkAndIncrementAiCount = vi.fn();

vi.mock("@workspace/ai", () => ({
  getProvider: () => ({ name: "anthropic" as const, refineWebsiteVideo }),
}));
vi.mock("./billingService", () => ({ checkAndIncrementAiCount }));

const { refineWebsiteVideoVars, RefineNotApplicableError } = await import(
  "./websiteRefineService"
);

const usage = { inputTokens: 1, outputTokens: 1 };
const showcase = (vars: Record<string, string>) => ({
  module: "website-showcase",
  compositionVars: vars,
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("refineWebsiteVideoVars", () => {
  it("maps duration + region to changed vars and charges quota once", async () => {
    refineWebsiteVideo.mockResolvedValue({
      duration: 20,
      region: "hero",
      note: "Süreyi 20 saniyeye indirdim ve hero'ya odakladım.",
      usage,
    });
    checkAndIncrementAiCount.mockResolvedValue(undefined);

    const res = await refineWebsiteVideoVars(
      "u1",
      showcase({
        duration: "38",
        "capture.height": "4000",
        "capture.image": "data:image/jpeg;base64,AAAA",
      }),
      "kısalt ve hero'ya odakla",
    );

    expect(res.note).toContain("hero");
    expect(res.vars["duration"]).toBe("20");
    // heroCrop(4000) = { x:0, y:0, w:1, h:0.2 }
    expect(res.vars["capture.cropX"]).toBe("0");
    expect(res.vars["capture.cropY"]).toBe("0");
    expect(res.vars["capture.cropW"]).toBe("1");
    expect(res.vars["capture.cropH"]).toBe("0.2");
    // The big saved capture.image must NOT be echoed back into the delta.
    expect(res.vars["capture.image"]).toBeUndefined();
    expect(checkAndIncrementAiCount).toHaveBeenCalledTimes(1);
    expect(checkAndIncrementAiCount).toHaveBeenCalledWith("u1");
  });

  it("clamps an out-of-range duration to the showcase ceiling", async () => {
    refineWebsiteVideo.mockResolvedValue({
      duration: 999,
      region: "keep",
      note: "Uzattım.",
      usage,
    });
    const res = await refineWebsiteVideoVars(
      "u1",
      showcase({ duration: "9", "capture.height": "2000" }),
      "uzat",
    );
    expect(res.vars["duration"]).toBe("60");
    // region "keep" leaves the framing untouched.
    expect(res.vars["capture.cropX"]).toBeUndefined();
  });

  it("treats duration 0 + region keep as no change", async () => {
    refineWebsiteVideo.mockResolvedValue({
      duration: 0,
      region: "keep",
      note: "Değişiklik gerekmedi.",
      usage,
    });
    const res = await refineWebsiteVideoVars(
      "u1",
      showcase({ duration: "9", "capture.height": "2000" }),
      "iyi görünüyor",
    );
    expect(res.vars).toEqual({});
    expect(res.note).toBe("Değişiklik gerekmedi.");
  });

  it("resets the crop to the full page for region whole", async () => {
    refineWebsiteVideo.mockResolvedValue({
      duration: 0,
      region: "whole",
      note: "Tüm sayfayı gösterdim.",
      usage,
    });
    const res = await refineWebsiteVideoVars(
      "u1",
      showcase({ "capture.height": "5000", "capture.cropY": "0.4" }),
      "tüm sayfayı göster",
    );
    expect(res.vars).toEqual({
      "capture.cropX": "0",
      "capture.cropY": "0",
      "capture.cropW": "1",
      "capture.cropH": "1",
    });
  });

  it("rejects a non-website-showcase project before calling the model", async () => {
    await expect(
      refineWebsiteVideoVars(
        "u1",
        { module: "studio", compositionVars: {} },
        "kısalt",
      ),
    ).rejects.toBeInstanceOf(RefineNotApplicableError);
    expect(refineWebsiteVideo).not.toHaveBeenCalled();
    expect(checkAndIncrementAiCount).not.toHaveBeenCalled();
  });

  it("rejects an AI-tour project (tour editing comes later)", async () => {
    await expect(
      refineWebsiteVideoVars(
        "u1",
        showcase({ "capture.tour": "eyJ4Ijoxf", "capture.height": "4000" }),
        "kısalt",
      ),
    ).rejects.toBeInstanceOf(RefineNotApplicableError);
    expect(refineWebsiteVideo).not.toHaveBeenCalled();
  });

  it("propagates a quota upgrade_required error", async () => {
    refineWebsiteVideo.mockResolvedValue({
      duration: 20,
      region: "keep",
      note: "x",
      usage,
    });
    checkAndIncrementAiCount.mockRejectedValue(
      Object.assign(new Error("AI suggestion limit reached"), {
        reason: "upgrade_required",
      }),
    );
    await expect(
      refineWebsiteVideoVars(
        "u1",
        showcase({ duration: "9", "capture.height": "2000" }),
        "kısalt",
      ),
    ).rejects.toMatchObject({ reason: "upgrade_required" });
  });
});
