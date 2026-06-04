import { beforeEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_CORE } from "../prompt";

// vi.mock is hoisted above imports, so the shared spy must come from vi.hoisted
// (a bare top-level const would be in the temporal dead zone when the factory
// runs). Mirrors the puppeteer mock in websiteCaptureService.test.ts.
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: createMock };
  },
}));

// Import AFTER the mock is registered.
import { anthropicProvider } from "./anthropic";

type MockUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

/** A well-formed Anthropic messages.create result with controllable usage. */
function reply(usage: Partial<MockUsage> = {}) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          headline: "Make it move",
          bodyText: "Branded video in minutes.",
          ctaText: "Try it free",
        }),
      },
    ],
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      ...usage,
    },
  };
}

const BRAND = {
  companyName: "Acme",
  voice: "bold" as const,
  voiceDescription: "No exclamation marks.",
};
const NO_BRAND = { companyName: null, voice: null, voiceDescription: null };

/** The system param passed to the SDK on the most recent call. */
function lastSystem(): Array<{ type: string; text: string; cache_control?: unknown }> {
  return createMock.mock.calls.at(-1)?.[0].system;
}

beforeEach(() => {
  createMock.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

describe("anthropicProvider — prompt-cache structure", () => {
  it("sends the stable core as the first cache-controlled system block", async () => {
    createMock.mockResolvedValue(reply());

    await anthropicProvider.suggest({ prompt: "launch our app", brand: NO_BRAND });

    expect(createMock).toHaveBeenCalledTimes(1);
    const args = createMock.mock.calls[0][0];
    expect(Array.isArray(args.system)).toBe(true);
    expect(args.system[0]).toMatchObject({
      type: "text",
      text: SYSTEM_CORE,
      cache_control: { type: "ephemeral" },
    });
    // No brand info → exactly one block (no empty second block).
    expect(args.system).toHaveLength(1);
    // The variable brief rides in the user message, NOT the cached system.
    expect(args.messages[0]).toMatchObject({ role: "user" });
    expect(args.messages[0].content).toContain("launch our app");
  });

  it("adds a second cache-controlled block for the per-brand context", async () => {
    createMock.mockResolvedValue(reply());

    await anthropicProvider.suggest({ prompt: "spring sale", brand: BRAND });

    const system = lastSystem();
    expect(system).toHaveLength(2);
    expect(system[1]).toMatchObject({ cache_control: { type: "ephemeral" } });
    expect(system[1].text).toContain("The brand is Acme.");
    expect(system[1].text).toContain("Voice:");
    // The core must stay brand-free so it stays shareable across users.
    expect(system[0].text).not.toContain("Acme");
  });
});

describe("anthropicProvider — cache usage surfacing", () => {
  it("surfaces cache read + creation tokens from the response usage", async () => {
    createMock.mockResolvedValue(
      reply({ cache_creation_input_tokens: 110, cache_read_input_tokens: 90 }),
    );

    const result = await anthropicProvider.suggest({
      prompt: "hello world",
      brand: BRAND,
    });

    expect(result.usage.inputTokens).toBe(120);
    expect(result.usage.outputTokens).toBe(30);
    expect(result.usage.cacheCreationInputTokens).toBe(110);
    expect(result.usage.cacheReadInputTokens).toBe(90);
    // Still returns the parsed copy fields.
    expect(result.headline).toBe("Make it move");
    expect(result.ctaText).toBe("Try it free");
  });

  it("leaves cache fields undefined when the model reports none (null)", async () => {
    createMock.mockResolvedValue(
      reply({ cache_creation_input_tokens: null, cache_read_input_tokens: null }),
    );

    const result = await anthropicProvider.suggest({
      prompt: "hello world",
      brand: NO_BRAND,
    });

    expect(result.usage.cacheCreationInputTokens).toBeUndefined();
    expect(result.usage.cacheReadInputTokens).toBeUndefined();
  });
});
