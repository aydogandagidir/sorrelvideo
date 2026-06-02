// Typed loader for the vendored Hyperframes registry templates. The data lives
// in compositions/registry-templates.generated.json (emitted by
// scripts/import-registry-templates.mjs, Apache-2.0 — see
// compositions/REGISTRY-NOTICE.md); esbuild inlines that JSON into the bundle at
// build time, so there is no runtime file read. Both renderService (composition
// map) and the platform-template seed read from here, making the manifest the
// single source of truth.
import manifest from "../compositions/registry-templates.generated.json";

export interface RegistryTemplate {
  /** Stable slug — also the project `module` and the `<slug>.html` basename. */
  slug: string;
  name: string;
  description: string;
  category: string;
  isPremium: boolean;
  /** Authored duration in seconds (approximate; the engine probes the real one). */
  duration: number;
  width: number;
  height: number;
  tags: string[];
  thumbnailUrl: string;
  /** Upstream registry block URL, for attribution. */
  source: string;
}

export const REGISTRY_TEMPLATES: RegistryTemplate[] =
  manifest as RegistryTemplate[];

/**
 * slug → composition filename, merged into renderService's COMPOSITION_MAP so a
 * project whose `module` is a registry slug resolves to the vendored
 * `<slug>.html` (which sits in the compositions dir alongside the hand-authored
 * templates).
 */
export const REGISTRY_COMPOSITION_MAP: Record<string, string> =
  Object.fromEntries(REGISTRY_TEMPLATES.map((t) => [t.slug, `${t.slug}.html`]));
