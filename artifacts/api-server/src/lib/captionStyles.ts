/**
 * Caption overlay builders (Track E). Each style turns word-timed captions into
 * an injected fragment: a `[data-sorrel-captions]` stage + a script that appends
 * opacity/transform tweens to the composition's ROOT timeline (the engine only
 * seeks the root + element-matched sub-timelines, so a standalone timeline would
 * never play — appending to the root, grabbed by `data-composition-id`, is the
 * verified approach). All sizing is viewport-relative (vh/vw/%) so a style lays
 * out at portrait, landscape, and square. Word text only ever reaches the DOM
 * HTML-escaped; the time-window JSON is `<`-escaped for the script context.
 *
 * `classic` is byte-identical to the original renderService implementation (a
 * pinned regression test guards that); the three presets are richer but share
 * the same root-timeline word-window mechanism (no canvas measureText / grouping
 * — Sorrel's proven single-active-word model, restyled per preset).
 */
import type {
  RenderCaptionStyle,
  RenderCaptionWord,
} from "@workspace/db";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `<`-escaped JSON for a `<script>` context (prevents `</script>` breakout). */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

type Word = RenderCaptionWord;

/**
 * CLASSIC — the original overlay, moved here CHARACTER-FOR-CHARACTER. Do not
 * touch without updating the byte-identical regression test.
 */
function classic(words: Word[]): string {
  const spans = words
    .map(
      (w) =>
        `<span class="__cap" style="position:absolute;left:0;right:0;text-align:center;opacity:0;">${escapeHtml(
          w.text,
        )}</span>`,
    )
    .join("");
  const windows = JSON.stringify(words.map((w) => [w.start, w.end]));
  return (
    `<div data-sorrel-captions style="position:fixed;left:0;right:0;bottom:9%;z-index:2147483646;pointer-events:none;padding:0 6%;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-weight:800;font-size:5.2vh;line-height:1.15;color:#fff;text-shadow:0 4px 18px rgba(0,0,0,0.85);">${spans}</div>` +
    `<script>(function(){var C=document.querySelector('[data-sorrel-captions]');if(!C)return;var r=document.querySelector('[data-composition-id]');var id=r&&r.getAttribute('data-composition-id');var tl=(window.__timelines||{})[id];if(!tl||!tl.to)return;var W=${windows};var s=C.querySelectorAll('.__cap');for(var i=0;i<s.length&&i<W.length;i++){tl.to(s[i],{opacity:1,duration:0.08,ease:'none'},W[i][0]);tl.to(s[i],{opacity:0,duration:0.08,ease:'none'},W[i][1]);}})();</script>`
  );
}

/** Shared: the absolutely-stacked word spans + the time-window array literal. */
function stackedSpans(words: Word[], spanStyle: string): string {
  return words
    .map(
      (w) =>
        `<span class="__cap" style="${spanStyle}">${escapeHtml(w.text)}</span>`,
    )
    .join("");
}

/**
 * PILL-KARAOKE — the active word sits in a rounded accent "pill" (dark text on
 * the brand lime), scaling up as it lands. Reads `--sorrel-accent` for the pill
 * color, falling back to lime.
 */
function pillKaraoke(words: Word[]): string {
  const spans = stackedSpans(
    words,
    "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(0.7);opacity:0;white-space:nowrap;padding:0.35em 0.7em;border-radius:9999px;background:var(--sorrel-accent,#a3e635);color:#0b0b0f;font-weight:800;",
  );
  const windows = scriptJson(words.map((w) => [w.start, w.end]));
  return (
    `<div data-sorrel-captions style="position:fixed;left:0;right:0;bottom:12%;z-index:2147483646;pointer-events:none;text-align:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:4.6vh;line-height:1;height:8vh;">${spans}</div>` +
    `<script>(function(){var C=document.querySelector('[data-sorrel-captions]');if(!C)return;var r=document.querySelector('[data-composition-id]');var id=r&&r.getAttribute('data-composition-id');var tl=(window.__timelines||{})[id];if(!tl||!tl.fromTo)return;var W=${windows};var s=C.querySelectorAll('.__cap');for(var i=0;i<s.length&&i<W.length;i++){tl.fromTo(s[i],{opacity:0,scale:0.7},{opacity:1,scale:1,transformOrigin:'50% 50%',duration:0.18,ease:'back.out(2)'},W[i][0]);tl.to(s[i],{opacity:0,duration:0.1,ease:'none'},W[i][1]);}})();</script>`
  );
}

/**
 * NEON-ACCENT — bright text with a colored neon glow; words longer than 6 chars
 * (or punctuation-terminated) get the brand accent + a stronger glow, the rest
 * stay white. Reads `--sorrel-accent`.
 */
function neonAccent(words: Word[]): string {
  // Deterministic "keyword" heuristic (no transcript-specific list): emphasize
  // longer / punctuation-terminated words. Computed server-side, baked per span.
  const emph = words.map((w) => w.text.replace(/[^\p{L}\p{N}]/gu, "").length > 6 || /[.!?,]$/.test(w.text));
  const spans = words
    .map((w, i) => {
      const accent = emph[i];
      const color = accent ? "var(--sorrel-accent,#a3e635)" : "#fff";
      const glow = accent
        ? "0 0 8px var(--sorrel-accent,#a3e635),0 0 22px var(--sorrel-accent,#a3e635)"
        : "0 0 6px rgba(255,255,255,0.55)";
      return `<span class="__cap" style="position:absolute;left:0;right:0;text-align:center;opacity:0;color:${color};text-shadow:${glow};">${escapeHtml(
        w.text,
      )}</span>`;
    })
    .join("");
  const windows = scriptJson(words.map((w) => [w.start, w.end]));
  return (
    `<div data-sorrel-captions style="position:fixed;left:0;right:0;bottom:10%;z-index:2147483646;pointer-events:none;padding:0 6%;text-align:center;font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif;font-weight:800;font-size:5.4vh;line-height:1.1;letter-spacing:0.01em;">${spans}</div>` +
    `<script>(function(){var C=document.querySelector('[data-sorrel-captions]');if(!C)return;var r=document.querySelector('[data-composition-id]');var id=r&&r.getAttribute('data-composition-id');var tl=(window.__timelines||{})[id];if(!tl||!tl.fromTo)return;var W=${windows};var s=C.querySelectorAll('.__cap');for(var i=0;i<s.length&&i<W.length;i++){tl.fromTo(s[i],{opacity:0,y:'0.4em'},{opacity:1,y:0,duration:0.14,ease:'power2.out'},W[i][0]);tl.to(s[i],{opacity:0,duration:0.1,ease:'none'},W[i][1]);}})();</script>`
  );
}

/**
 * KINETIC-SLAM — one big word fills the safe area, slamming in with a
 * scale+rotate entrance. Bold, attention-grabbing; centered.
 */
function kineticSlam(words: Word[]): string {
  const spans = stackedSpans(
    words,
    "position:absolute;left:0;right:0;text-align:center;opacity:0;transform:scale(1.6);text-transform:uppercase;",
  );
  const windows = scriptJson(words.map((w) => [w.start, w.end]));
  return (
    `<div data-sorrel-captions style="position:fixed;left:0;right:0;top:50%;transform:translateY(-50%);z-index:2147483646;pointer-events:none;padding:0 8%;text-align:center;font-family:'Arial Black',Impact,-apple-system,sans-serif;font-weight:900;font-size:9vh;line-height:1;color:#fff;text-shadow:0 6px 24px rgba(0,0,0,0.9);">${spans}</div>` +
    `<script>(function(){var C=document.querySelector('[data-sorrel-captions]');if(!C)return;var r=document.querySelector('[data-composition-id]');var id=r&&r.getAttribute('data-composition-id');var tl=(window.__timelines||{})[id];if(!tl||!tl.fromTo)return;var W=${windows};var s=C.querySelectorAll('.__cap');for(var i=0;i<s.length&&i<W.length;i++){tl.fromTo(s[i],{opacity:0,scale:1.6,rotation:(i%2?-4:4)},{opacity:1,scale:1,rotation:0,transformOrigin:'50% 50%',duration:0.16,ease:'expo.out'},W[i][0]);tl.to(s[i],{opacity:0,duration:0.08,ease:'none'},W[i][1]);}})();</script>`
  );
}

/**
 * Build the caption overlay for the given words + style. `classic` (or any
 * absent/unknown style) returns the byte-identical legacy overlay; "" when
 * there are no words.
 */
export function buildCaptionOverlay(
  words: Word[],
  style?: RenderCaptionStyle,
): string {
  if (words.length === 0) return "";
  switch (style) {
    case "pill-karaoke":
      return pillKaraoke(words);
    case "neon-accent":
      return neonAccent(words);
    case "kinetic-slam":
      return kineticSlam(words);
    default:
      return classic(words);
  }
}
