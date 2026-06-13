/**
 * Which template modules can host scene shader-transitions (M8).
 *
 * A transition-capable composition declares ≥2 `class="scene"` elements with
 * ids and a `data-scene-boundary` on its root, and branches its hard-cut
 * wiring on `{{sorrel.transitionsActive}}` (see brand-story.html — the
 * authoring contract is documented in its header comment).
 *
 * Kept as a code-side set rather than a DB column on purpose: the capability
 * is a property OF THE SHIPPED COMPOSITION FILE, `seedPlatformTemplates` never
 * clobbers existing rows (a column would go stale on already-seeded
 * environments), and the templates route derives `supportsTransitions` from
 * this set at read time — same pattern as the manifest-derived fields.
 */
export const TRANSITION_CAPABLE_MODULES: ReadonlySet<string> = new Set([
  "brand-story",
]);

export function supportsTransitions(module: string): boolean {
  return TRANSITION_CAPABLE_MODULES.has(module);
}
