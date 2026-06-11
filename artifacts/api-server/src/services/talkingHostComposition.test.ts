import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Structural contract of the talking-host composition. These assertions pin the
 * conventions the render pipeline depends on (placeholder names, the payload
 * channel, the root-timeline registration) so a refactor of the HTML can't
 * silently detach it from talkingHostService / renderService.
 */
describe("talking-host composition", () => {
  const file = path.resolve(__dirname, "../compositions/talking-host.html");
  const html = fs.readFileSync(file, "utf-8");

  it("exists next to the other hand-authored compositions", () => {
    expect(fs.existsSync(file)).toBe(true);
  });

  it("declares the engine metadata with a substitutable duration", () => {
    expect(html).toContain('data-composition-id="talking-host"');
    expect(html).toContain('data-duration="{{duration}}"');
    expect(html).toContain('data-width="{{layout.width}}"');
    expect(html).toContain('data-height="{{layout.height}}"');
    expect(html).toContain('data-aspect="{{layout.aspect}}"');
  });

  it("carries the base64 payload channel with a JSON script tag", () => {
    expect(html).toContain('<script type="application/json" id="host-payload">{{host.payload}}</script>');
  });

  it("registers its single paused timeline on the engine's root registry", () => {
    expect(html).toContain('window.__timelines["talking-host"] = tl');
    expect(html).toContain("gsap.timeline({ paused: true })");
  });

  it("is branded via the standard brand.* placeholders", () => {
    expect(html).toContain("{{brand.companyName}}");
    expect(html).toContain("{{brand.primaryColor}}");
    expect(html).toContain("{{brand.accentColor}}");
  });

  it("does not reference the narration audio itself (renderService injects it)", () => {
    expect(html).not.toContain("<audio");
    expect(html).not.toContain("voice.mp3");
  });

  it("builds caption DOM via textContent only (script words are user content)", () => {
    expect(html).toContain("span.textContent");
    expect(html).not.toContain("innerHTML");
  });

  it("never uses an unbounded repeat (the engine seeks a FINITE timeline)", () => {
    expect(html).not.toMatch(/repeat:\s*-1/);
  });

  it("avoids CSS animations — all motion must live on the seekable timeline", () => {
    expect(html).not.toContain("@keyframes");
    expect(html).not.toMatch(/animation\s*:/);
  });
});
