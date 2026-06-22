import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  buildTransitionsInjection,
  copyTemplateAssets,
  injectFitScript,
  injectWatermark,
  inlineVendorScripts,
  isContentCustomizable,
  outputPathFor,
  renderCompositionTemplate,
  renderDirFor,
  renderFailureMessage,
  resolveEntryFile,
  resolveVoiceoverTag,
  RENDERS_DIR,
  VOICEOVER_FILENAME,
  VoiceoverUnavailableError,
} from "./renderService";
import { assetsForModule } from "./registryTemplates";
import { TRANSITION_SHADERS } from "./renderSettingsService";

describe("inlineVendorScripts", () => {
  const VENDORED = [
    "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js",
    "https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js",
    "https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/dist/topojson-client.min.js",
    "https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie.min.js",
  ];

  it("inlines each vendored CDN lib and drops the external src (no CDN dependency left)", () => {
    for (const url of VENDORED) {
      const out = inlineVendorScripts(`<head><script src="${url}"></script></head>`);
      expect(out).not.toContain(url);
      expect(out).toContain("<script>");
      // The real minified lib (>1KB) is now inline, not an empty stub.
      expect(out.length).toBeGreaterThan(1000);
    }
  });

  it("inlines the GSAP lib used by 69/74 compositions (the timeline dependency)", () => {
    const out = inlineVendorScripts(
      '<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>',
    );
    expect(out).toMatch(/GSAP 3\.14\.2/);
    expect(out).not.toContain("src=");
  });

  it("leaves an unknown external script untouched (graceful CDN fallback)", () => {
    const html = '<script src="https://example.com/whatever.js"></script>';
    expect(inlineVendorScripts(html)).toBe(html);
  });

  it("leaves non-script externals (e.g. Google Fonts CSS) alone", () => {
    const html =
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">';
    expect(inlineVendorScripts(html)).toBe(html);
  });

  it("inlines repeated occurrences and is a no-op on script-less HTML", () => {
    const tag =
      '<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>';
    expect(inlineVendorScripts(tag + tag)).not.toContain("jsdelivr");
    expect(inlineVendorScripts("<div>no scripts</div>")).toBe(
      "<div>no scripts</div>",
    );
  });
});

describe("injectFitScript", () => {
  it("injects the auto-fit script just before </body> (after the elements exist)", () => {
    const out = injectFitScript(
      '<html><body><h1 class="headline">x</h1></body></html>',
    );
    expect(out).toContain("data-sorrel-fit");
    expect(out.indexOf("data-sorrel-fit")).toBeLessThan(out.indexOf("</body>"));
    // the original composition content is untouched
    expect(out).toContain('<h1 class="headline">x</h1>');
  });

  it("targets the conventional copy classes, guards on overflow, waits for fonts", () => {
    const out = injectFitScript("<body></body>");
    expect(out).toContain(".headline");
    expect(out).toContain(".cta");
    expect(out).toContain("scrollHeight"); // only shrinks on real overflow
    expect(out).toContain("fonts.ready"); // runs after web fonts settle (deterministic)
  });

  it("still injects when there is no closing body tag (never silently dropped)", () => {
    expect(injectFitScript("<div>no body</div>")).toContain("data-sorrel-fit");
  });
});

describe("isContentCustomizable", () => {
  it("is true for templates that consume brand/user content or declare variables", () => {
    // Hand-authored content templates carry {{brand.*}}/{{user.*}} placeholders…
    expect(isContentCustomizable("studio")).toBe(true);
    expect(isContentCustomizable("brand-story")).toBe(true);
    expect(isContentCustomizable("video-spotlight")).toBe(true);
    expect(isContentCustomizable("website-showcase")).toBe(true);
    // …and data-chart is customizable via its typed parametric variables.
    expect(isContentCustomizable("data-chart")).toBe(true);
  });

  it("is false for pure-demo registry compositions (no placeholders, no variables)", () => {
    expect(isContentCustomizable("app-showcase")).toBe(false);
    expect(isContentCustomizable("us-map")).toBe(false);
  });

  it("memoizes — a repeat call returns the same verdict", () => {
    expect(isContentCustomizable("studio")).toBe(
      isContentCustomizable("studio"),
    );
    expect(isContentCustomizable("app-showcase")).toBe(
      isContentCustomizable("app-showcase"),
    );
  });
});

describe("renderCompositionTemplate", () => {
  it("substitutes simple {{key}} placeholders", () => {
    const out = renderCompositionTemplate(
      "<p>Hello {{ user.headline }}, brand: {{brand.companyName}}.</p>",
      { "user.headline": "World", "brand.companyName": "Acme" },
    );
    expect(out).toBe("<p>Hello World, brand: Acme.</p>");
  });

  it("HTML-escapes substituted values to prevent XSS", () => {
    const out = renderCompositionTemplate("<p>{{user.headline}}</p>", {
      "user.headline": "<script>alert(1)</script>",
    });
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("turns newlines in user.* values into <br/>", () => {
    const out = renderCompositionTemplate("<h1>{{user.headline}}</h1>", {
      "user.headline": "Line one\nLine two",
    });
    expect(out).toBe("<h1>Line one<br/>Line two</h1>");
  });

  it("does not turn newlines into <br/> for brand.* values", () => {
    const out = renderCompositionTemplate("<p>{{brand.companyName}}</p>", {
      "brand.companyName": "Foo\nBar",
    });
    // Newline survives but no <br/> injection.
    expect(out).toContain("Foo");
    expect(out).toContain("Bar");
    expect(out).not.toContain("<br/>");
  });

  it("leaves unknown placeholders intact (debug-friendly)", () => {
    const out = renderCompositionTemplate("<p>{{user.unknown}}</p>", {
      "brand.companyName": "X",
    });
    expect(out).toBe("<p>{{user.unknown}}</p>");
  });

  it("preserves quotes in brand.* values so CSS font-family survives", () => {
    const out = renderCompositionTemplate(
      "<style>font-family: {{brand.fontFamily}};</style>",
      { "brand.fontFamily": "'Inter'" },
    );
    expect(out).toBe("<style>font-family: 'Inter';</style>");
    expect(out).not.toContain("&#39;");
  });

  it("still markup-escapes brand.* values to prevent style/HTML breakout", () => {
    const out = renderCompositionTemplate("<p>{{brand.companyName}}</p>", {
      "brand.companyName": "</style><script>x</script>",
    });
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });
});

describe("injectWatermark", () => {
  const doc = "<html><body><h1>Hi</h1></body></html>";

  it("injects the badge immediately before </body>", () => {
    const out = injectWatermark(doc);
    expect(out).toContain('data-sorrel-watermark="true"');
    expect(out).toContain("Made with Sorrel");
    // Badge sits inside the body, right before the closing tag.
    expect(out.indexOf("data-sorrel-watermark")).toBeLessThan(
      out.indexOf("</body>"),
    );
    expect(out.indexOf("<h1>Hi</h1>")).toBeLessThan(
      out.indexOf("data-sorrel-watermark"),
    );
  });

  it("is a no-op marker absent until injected (absence is detectable)", () => {
    expect(doc).not.toContain("data-sorrel-watermark");
  });

  it("uses pointer-events:none and a high z-index so it can't be interacted with or buried", () => {
    const out = injectWatermark(doc);
    expect(out).toContain("pointer-events:none");
    expect(out).toContain("z-index:2147483647");
    expect(out).toContain("position:fixed");
  });

  it("uses only inline styles — no external asset/CDN reference", () => {
    const out = injectWatermark(doc);
    expect(out).not.toMatch(/<link\b/i);
    expect(out).not.toMatch(/src=/i);
    expect(out).not.toMatch(/https?:\/\//i);
  });

  it("matches the LAST </body> case-insensitively", () => {
    const upper = "<HTML><BODY>x</BODY></HTML>";
    const out = injectWatermark(upper);
    expect(out).toContain("data-sorrel-watermark");
    expect(out.indexOf("data-sorrel-watermark")).toBeLessThan(
      out.toLowerCase().indexOf("</body>"),
    );
  });

  it("appends (never drops) the badge when there is no closing body tag", () => {
    const out = injectWatermark("<div>no body tag</div>");
    expect(out).toContain("data-sorrel-watermark");
    // Original content stays first; the badge is appended after it.
    expect(out.indexOf("no body tag")).toBeLessThan(
      out.indexOf("data-sorrel-watermark"),
    );
    expect(out).toMatch(/data-sorrel-watermark[^]*<\/div>$/);
  });

  it("injects exactly one badge", () => {
    const out = injectWatermark(doc);
    expect(out.match(/data-sorrel-watermark/g)).toHaveLength(1);
  });
});

describe("resolveEntryFile", () => {
  it("returns the studio composition for the studio module", () => {
    expect(resolveEntryFile("studio")).toBe("studio-default.html");
  });

  it("returns the talking-host composition for the talking-host module", () => {
    expect(resolveEntryFile("talking-host")).toBe("talking-host.html");
  });

  it("returns the default composition for unknown modules", () => {
    expect(resolveEntryFile("does-not-exist")).toBe("product-launch.html");
  });
});

describe("renderDirFor", () => {
  it("resolves the per-project directory under RENDERS_DIR", () => {
    expect(renderDirFor(42)).toBe(path.join(RENDERS_DIR, "42"));
  });
});

describe("outputPathFor", () => {
  const dir = path.join(os.tmpdir(), "out");

  it("maps each single-file format to output.<ext>", () => {
    expect(outputPathFor(dir, "mp4")).toBe(path.join(dir, "output.mp4"));
    expect(outputPathFor(dir, "webm")).toBe(path.join(dir, "output.webm"));
    expect(outputPathFor(dir, "mov")).toBe(path.join(dir, "output.mov"));
    expect(outputPathFor(dir, "gif")).toBe(path.join(dir, "output.gif"));
  });

  it("maps png-sequence to the frames directory", () => {
    expect(outputPathFor(dir, "png-sequence")).toBe(path.join(dir, "frames"));
  });
});

describe("copyTemplateAssets", () => {
  it("copies a multi-file module's vendored assets into <dir>/assets/", () => {
    // Pick a real asset-bearing module from the manifest so this tracks the
    // committed assets dir, not a hardcoded slug.
    const slug = ["instagram-follow", "apple-money-count", "tiktok-follow"].find(
      (s) => assetsForModule(s).length > 0,
    );
    expect(slug, "an asset-bearing module exists").toBeDefined();
    if (!slug) return;

    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "sorrel-assets-"));
    try {
      copyTemplateAssets(slug, dest);
      for (const name of assetsForModule(slug)) {
        const copied = path.join(dest, "assets", name);
        expect(fs.existsSync(copied), copied).toBe(true);
        expect(fs.statSync(copied).size).toBeGreaterThan(0);
      }
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  it("is a no-op for a single-file / non-registry module (no assets dir)", () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "sorrel-noassets-"));
    try {
      copyTemplateAssets("studio", dest);
      expect(fs.existsSync(path.join(dest, "assets"))).toBe(false);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
});

describe("resolveVoiceoverTag", () => {
  const html = '<div data-composition-id="talking-host" data-duration="12.5"></div><body></body>';

  function tmpDirWithVoice(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sorrel-voice-"));
    fs.writeFileSync(path.join(dir, VOICEOVER_FILENAME), "fake-mp3-bytes");
    return dir;
  }

  it("uses the local voice.mp3 sibling and emits a loop-free, track-1 tag", async () => {
    const dir = tmpDirWithVoice();
    const tag = await resolveVoiceoverTag(
      "user-1",
      { objectPath: null, startAt: 0.9, volume: 100 },
      dir,
      html,
    );
    expect(tag).toContain(`src="${VOICEOVER_FILENAME}"`);
    expect(tag).toContain('data-start="0.9"');
    // data-duration mirrors the composition's declared duration (audioPadTrim).
    expect(tag).toContain('data-duration="12.5"');
    // Narration is a distinct mix track from background music (index 0)…
    expect(tag).toContain('data-track-index="1"');
    expect(tag).toContain('data-volume="1.000"');
    // …and must NEVER restart inside a longer composition.
    expect(tag).not.toContain("loop");
  });

  it("defaults volume to full and startAt to 0 when malformed", async () => {
    const dir = tmpDirWithVoice();
    const tag = await resolveVoiceoverTag(
      "user-1",
      { objectPath: null, startAt: Number.NaN },
      dir,
      "<body></body>",
    );
    expect(tag).toContain('data-start="0"');
    expect(tag).toContain('data-volume="1.000"');
    // No data-duration in the doc → the bg-audio fallback of 30s.
    expect(tag).toContain('data-duration="30"');
  });

  it("THROWS when there is no local file and no objectPath (no silent mute)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sorrel-novoice-"));
    await expect(
      resolveVoiceoverTag("user-1", { objectPath: null, startAt: 0 }, dir, html),
    ).rejects.toBeInstanceOf(VoiceoverUnavailableError);
  });

  it("THROWS when the GCS fallback fails (storage unconfigured here)", async () => {
    // No local file; objectPath set but PRIVATE_OBJECT_DIR is unset in unit
    // tests, so the storage lookup throws → must surface as the strict error.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sorrel-novoice-"));
    await expect(
      resolveVoiceoverTag(
        "user-1",
        { objectPath: "/objects/uploads/v", startAt: 0 },
        dir,
        html,
      ),
    ).rejects.toBeInstanceOf(VoiceoverUnavailableError);
  });
});

describe("buildTransitionsInjection (M8)", () => {
  const TWO_SCENES =
    `<html><body><div data-composition-id="x" data-scene-boundary="4">` +
    `<section class="scene" id="a"></section>` +
    `<section class="scene" id="b"></section>` +
    `</div></body></html>`;
  const ONE_SCENE =
    `<html><body><div data-composition-id="x">` +
    `<section class="scene" id="a"></section>` +
    `</div></body></html>`;
  const T = [
    { time: 4, shader: "whip-pan", duration: 0.6, ease: "power2.inOut" },
  ];

  it("returns '' with no transitions or on a single-scene composition", () => {
    expect(buildTransitionsInjection(TWO_SCENES, [])).toBe("");
    expect(buildTransitionsInjection(ONE_SCENE, T)).toBe("");
  });

  it("inlines the HyperShader library + a bootstrap wired to the ROOT timeline", () => {
    const out = buildTransitionsInjection(TWO_SCENES, T);
    expect(out).not.toBe("");
    // The IIFE bundle defines the global; the bootstrap calls into it.
    expect(out).toContain("HyperShader");
    expect(out).toContain("window.HyperShader.init");
    // The root-timeline handoff is mandatory (init() without a timeline would
    // register its own under the composition id, clobbering the real one).
    expect(out).toContain("timeline:tl");
    // Boundary snap + the hard-cut fallback hook are present.
    expect(out).toContain("data-scene-boundary");
    expect(out).toContain("__sorrelWireHardCuts");
    // The sanitized payload rides along verbatim.
    expect(out).toContain('"shader":"whip-pan"');
  });

  it("escapes '<' in the JSON payload (script-context safety)", () => {
    // The sanitizer's whitelists exclude '<' today; this pins the defense in
    // depth at the injection layer regardless.
    const out = buildTransitionsInjection(TWO_SCENES, [
      { time: 1, shader: "glitch", duration: 0.5, ease: "power2.inOut" },
    ]);
    const payloadPart = out.slice(out.indexOf("var specs="));
    expect(payloadPart.includes("</script>")).toBe(true); // closing tags of OUR scripts only
    expect(out.match(/<\/script>/g)?.length).toBe(2); // lib + bootstrap, nothing injected
  });

  it("drift-guard: every real shader name exists in the installed library bundle", () => {
    const out = buildTransitionsInjection(TWO_SCENES, T);
    for (const name of TRANSITION_SHADERS) {
      if (name === "fade-dissolve") continue; // Sorrel-side CSS-crossfade entry
      expect(out, `shader "${name}" missing from @hyperframes/shader-transitions bundle`).toContain(name);
    }
  });
});

describe("renderFailureMessage", () => {
  it("maps killed-encoder / OOM symptoms to a resource-guidance message", () => {
    const raws = [
      "Faststart failed: FFmpeg exited with code 1 ... moov atom not found /data/renders/17/.../video-only.mp4",
      "ffmpeg was killed (signal 9)",
      "Cannot allocate memory",
      "Process exited with code 137",
      "[swscaler @ 0x..] cannot allocate",
      "Render interrupted by a restart",
      "Page crashed",
      "ENOSPC: no space left on device, write",
    ];
    for (const raw of raws) {
      const msg = renderFailureMessage(raw);
      expect(msg).toMatch(/ran out of memory or time|shorter length|lower resolution/i);
      // The scary technical dump must NOT leak into the user-facing message.
      expect(msg.toLowerCase()).not.toContain("ffmpeg");
      expect(msg.toLowerCase()).not.toContain("moov");
      expect(msg.toLowerCase()).not.toContain("swscaler");
    }
  });

  it("maps capture timeouts and headless-Chrome death to the same guidance", () => {
    // These are how a memory-starved / slow box most often fails a HEAVY render:
    // the engine never reaches the encoder, so there's no moov/ffmpeg signature —
    // before, every one of these fell through to the dead-end generic message.
    const raws = [
      "Navigation timeout of 30000 ms exceeded",
      "Render timed out after 300s",
      "Protocol error (Page.captureScreenshot): Target closed",
      "Session closed. Most likely the page has been closed.",
      "Error: Connection closed",
      "Navigation failed because browser has disconnected!",
      "WebSocket is not open: readyState 3 (CLOSED)",
    ];
    for (const raw of raws) {
      const msg = renderFailureMessage(raw);
      expect(msg).toMatch(/shorter length|lower resolution|memory or time/i);
      // No raw Puppeteer/CDP internals leak to the user.
      expect(msg.toLowerCase()).not.toContain("protocol error");
      expect(msg.toLowerCase()).not.toContain("websocket");
    }
  });

  it("falls back to a short try-again message for an unknown error", () => {
    const msg = renderFailureMessage("some unexpected internal failure zqx");
    expect(msg).toMatch(/try again/i);
    expect(msg).not.toContain("zqx");
  });
});
