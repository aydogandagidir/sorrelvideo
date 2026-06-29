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
 * `social-teaser` + `product-launch` join `studio`/`brand-promo` here — all are
 * single-scene copy templates with one `position:relative` `.scene`, so the same
 * z-index:-1 full-bleed layer drops in cleanly.
 *
 * `brand-story` is included too, but as the TRANSITION-CAPABLE case it carries the
 * layer PER SCENE: each of its two `position:absolute` opaque-background scenes
 * (`#scene-intro`/`#scene-outro`) gets its own `.ai-bg-layer` at `z-index:-1`
 * (above the scene's secondaryColor fill, below content). The scene-collection
 * the shader bootstrap does (`querySelectorAll('.scene[id]')`) is unaffected (the
 * layer is `.ai-bg-layer`, not `.scene[id]`), and the per-scene image rides each
 * scene's html2canvas snapshot, so it composites correctly across the boundary;
 * in hard-cut mode the scene's `autoAlpha` toggle carries the layer with it.
 */
export const AI_BACKGROUND_MODULES: ReadonlySet<string> = new Set([
  "studio",
  "brand-promo",
  "social-teaser",
  "product-launch",
  "brand-story",
]);

export function supportsAiBackground(module: string): boolean {
  return AI_BACKGROUND_MODULES.has(module);
}
