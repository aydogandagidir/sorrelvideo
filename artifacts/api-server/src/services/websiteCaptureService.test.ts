import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock puppeteer BEFORE importing the service so the service's
// `import puppeteer from "puppeteer"` binds to the mock. `launch` is a spy we can
// assert against (most importantly: that the SSRF guard short-circuits BEFORE a
// browser is ever launched). `vi.mock` is hoisted above the imports, so the spy
// must be created in `vi.hoisted` to be defined when the factory runs.
const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("puppeteer", () => ({
  default: { launch },
}));

import { captureWebsite, SsrfError } from "./websiteCaptureService";

/** A minimal page stub covering exactly the surface captureWebsite drives. */
function makePage(buf: Buffer) {
  return {
    setViewport: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    setRequestInterception: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue({ ok: () => true, status: () => 200 }),
    title: vi.fn().mockResolvedValue("Example Domain"),
    $eval: vi.fn().mockResolvedValue("#123456"),
    evaluate: vi.fn().mockResolvedValue(2400),
    screenshot: vi.fn().mockResolvedValue(buf),
  };
}

let outDir: string;

beforeEach(() => {
  launch.mockReset();
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-test-"));
});

afterEach(() => {
  fs.rmSync(outDir, { recursive: true, force: true });
});

describe("captureWebsite — SSRF guard", () => {
  it("throws SsrfError for a non-http(s) scheme BEFORE launching a browser", async () => {
    await expect(captureWebsite("file:///etc/passwd", outDir)).rejects.toThrow(
      SsrfError,
    );
    expect(launch).not.toHaveBeenCalled();
  });

  it("throws SsrfError for the cloud metadata IP before launch", async () => {
    await expect(
      captureWebsite("http://169.254.169.254/latest/meta-data/", outDir),
    ).rejects.toBeInstanceOf(SsrfError);
    expect(launch).not.toHaveBeenCalled();
  });

  it("throws SsrfError for localhost before launch", async () => {
    await expect(
      captureWebsite("http://localhost:8080/", outDir),
    ).rejects.toBeInstanceOf(SsrfError);
    expect(launch).not.toHaveBeenCalled();
  });
});

describe("captureWebsite — happy path", () => {
  it("launches Chrome, writes the screenshot, and returns title + dims", async () => {
    // A 1x1 PNG so the written file is a real (if tiny) image.
    const pngBuf = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
      "hex",
    );
    const page = makePage(pngBuf);
    const browser = {
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    launch.mockResolvedValue(browser);

    // A public IP literal so assertSafeUrl passes WITHOUT a real DNS lookup
    // (1.1.1.1 is not in any blocked range) — keeps the unit test hermetic.
    const result = await captureWebsite("https://1.1.1.1/", outDir);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(browser.newPage).toHaveBeenCalledTimes(1);
    expect(page.screenshot).toHaveBeenCalledTimes(1);
    // The browser is always closed (finally block).
    expect(browser.close).toHaveBeenCalledTimes(1);

    // The PNG was written to <outDir>/capture.png with the mocked bytes.
    expect(result.screenshotPath).toBe(path.join(outDir, "capture.png"));
    expect(fs.existsSync(result.screenshotPath)).toBe(true);
    expect(fs.readFileSync(result.screenshotPath).equals(pngBuf)).toBe(true);

    expect(result.title).toBe("Example Domain");
    expect(result.width).toBe(1280);
    // captureHeight = clamp(VIEWPORT.height .. min(scrollHeight=2400, maxHeight)).
    expect(result.height).toBe(2400);
    expect(result.themeColor).toBe("#123456");
  });

  it("honors the maxHeight cap when the page is taller", async () => {
    const pngBuf = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
      "hex",
    );
    const page = makePage(pngBuf);
    page.evaluate = vi.fn().mockResolvedValue(10_000); // taller than the cap
    const browser = {
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    launch.mockResolvedValue(browser);

    const result = await captureWebsite("https://1.1.1.1/", outDir, {
      maxHeight: 2800,
    });

    expect(result.height).toBe(2800);
  });
});
