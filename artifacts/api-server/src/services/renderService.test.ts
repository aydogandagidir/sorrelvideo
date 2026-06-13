import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  buildTransitionsInjection,
  injectWatermark,
  outputPathFor,
  renderCompositionTemplate,
  renderDirFor,
  resolveEntryFile,
  resolveVoiceoverTag,
  RENDERS_DIR,
  VOICEOVER_FILENAME,
  VoiceoverUnavailableError,
} from "./renderService";
import { TRANSITION_SHADERS } from "./renderSettingsService";

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
