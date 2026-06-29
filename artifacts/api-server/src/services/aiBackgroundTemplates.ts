/**
 * Which template modules can host an AI-generated BACKGROUND image.
 *
 * A capable composition declares a full-bleed `<img class="ai-bg"
 * src="{{ai.backgroundImage}}">` behind its content, with the empty/broken-src
 * collapse (`img.ai-bg[src=""]{display:none}` + `onerror`) so a no-image render
 * stays byte-identical (see studio-default.html / brand-promo.html).
 *
 * Kept as a code-side set (mirrors `transitionCapableTemplates.ts`): the
 * capability is a property OF THE SHIPPED COMPOSITION FILE, `seedPlatformTemplates`
 * never clobbers existing rows, and the templates route derives
 * `supportsAiBackground` from this set at read time — never persisted, so an
 * already-seeded environment can't go stale.
 *
 * NOTE: `studio-default.html`'s module is `studio` (see renderService's
 * COMPOSITION_MAP), not `studio-default`.
 *
 * `social-teaser` + `product-launch` join `studio`/`brand-promo` here — all four
 * are single-scene copy templates with one `position:relative` `.scene`, so the
 * same z-index:-1 full-bleed layer drops in cleanly. `brand-story` is
 * deliberately EXCLUDED for now: it is transition-capable (two `position:absolute`
 * opaque-background scenes composited by the shader-transitions bootstrap), so an
 * AI background interacts with the shader's scene compositing and needs a
 * render-verified per-scene design — tracked as a follow-up.
 */
export const AI_BACKGROUND_MODULES: ReadonlySet<string> = new Set([
  "studio",
  "brand-promo",
  "social-teaser",
  "product-launch",
]);

export function supportsAiBackground(module: string): boolean {
  return AI_BACKGROUND_MODULES.has(module);
}
