import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above imports, so the shared spy comes from vi.hoisted
// (mirrors anthropic.test.ts). The mock applies to the dynamic re-imports below.
const { generateMock } = vi.hoisted(() => ({ generateMock: vi.fn() }));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    images = { generate: generateMock };
  },
}));

// imageGen caches the OpenAI client in a module singleton, so each test
// re-imports a fresh module (resetModules) to test key resolution cleanly.
async function loadImageGen() {
  vi.resetModules();
  return import("./imageGen");
}

const IMG_ENV = [
  "IMAGE_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_IMAGE_MODEL",
  "OPENAI_IMAGE_FORMAT",
  "OPENAI_IMAGE_QUALITY",
] as const;

beforeEach(() => {
  generateMock.mockReset();
  for (const k of IMG_ENV) delete process.env[k];
});

describe("generateBrandImage — key + config resolution", () => {
  it("throws (without calling the provider) when no key is set", async () => {
    const { generateBrandImage } = await loadImageGen();
    await expect(generateBrandImage({ prompt: "neon skyline" })).rejects.toThrow(
      /IMAGE_API_KEY/,
    );
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("defaults to gpt-image-1 / jpeg / medium and maps portrait → 1024x1536", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const b64 = Buffer.from("x".repeat(120)).toString("base64");
    generateMock.mockResolvedValue({ data: [{ b64_json: b64 }] });

    const { generateBrandImage } = await loadImageGen();
    const res = await generateBrandImage({
      prompt: "calm gradient",
      aspect: "portrait",
    });

    expect(res.dataUri.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(res.dataUri.endsWith(b64)).toBe(true);
    expect(res.model).toBe("gpt-image-1");
    expect(res.bytes).toBeGreaterThan(0);

    const args = generateMock.mock.calls[0][0];
    expect(args.model).toBe("gpt-image-1");
    expect(args.size).toBe("1024x1536");
    expect(args.output_format).toBe("jpeg");
    expect(args.quality).toBe("medium");
    expect(args.prompt).toContain("calm gradient");
  });

  it("honors IMAGE_API_KEY + model/format/quality overrides and landscape size", async () => {
    process.env.IMAGE_API_KEY = "img-key";
    process.env.OPENAI_IMAGE_MODEL = "gpt-image-1-mini";
    process.env.OPENAI_IMAGE_FORMAT = "webp";
    process.env.OPENAI_IMAGE_QUALITY = "high";
    generateMock.mockResolvedValue({ data: [{ b64_json: "AAAA" }] });

    const { generateBrandImage } = await loadImageGen();
    const res = await generateBrandImage({
      prompt: "wide rolling hills",
      aspect: "landscape",
    });

    expect(res.dataUri.startsWith("data:image/webp;base64,")).toBe(true);
    expect(res.model).toBe("gpt-image-1-mini");

    const args = generateMock.mock.calls[0][0];
    expect(args.size).toBe("1536x1024");
    expect(args.output_format).toBe("webp");
    expect(args.quality).toBe("high");
  });
});

describe("generateBrandImage — prompt + errors", () => {
  it("weaves brand DNA (palette/style/themes) and the no-text guardrail into the prompt", async () => {
    process.env.OPENAI_API_KEY = "k";
    generateMock.mockResolvedValue({ data: [{ b64_json: "AAAA" }] });

    const { generateBrandImage } = await loadImageGen();
    await generateBrandImage({
      prompt: "abstract energy",
      brand: {
        primaryColor: "#ff0066",
        imageStyle: "moody film grain",
        keywords: ["fintech", "trust"],
      },
    });

    const prompt = generateMock.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("#ff0066");
    expect(prompt).toContain("moody film grain");
    expect(prompt).toContain("fintech");
    expect(prompt).toContain("no text"); // background guardrail always present
    expect(prompt).toContain("abstract energy"); // user brief, last
  });

  it("throws when the provider returns no image data", async () => {
    process.env.OPENAI_API_KEY = "k";
    generateMock.mockResolvedValue({ data: [] });

    const { generateBrandImage } = await loadImageGen();
    await expect(generateBrandImage({ prompt: "anything works" })).rejects.toThrow(
      /no image data/,
    );
  });
});
