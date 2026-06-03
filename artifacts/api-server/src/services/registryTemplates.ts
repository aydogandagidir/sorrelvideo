// Typed loader for the vendored Hyperframes registry templates. The data lives
// in compositions/registry-templates.generated.json (emitted by
// scripts/import-registry-templates.mjs, Apache-2.0 — see
// compositions/REGISTRY-NOTICE.md); esbuild inlines that JSON into the bundle at
// build time, so there is no runtime file read. Both renderService (composition
// map) and the platform-template seed read from here, making the manifest the
// single source of truth.
import type { RenderResolution } from "@workspace/db";
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
  /**
   * Self-hosted gallery poster: a first-frame PNG rendered FROM this
   * composition (scripts/generate-thumbnails.mjs) and served by the api-server
   * at `/api/templates/thumbnails/<slug>.png`. seedPlatformTemplates persists
   * this onto the template row. Replaces the dependency on HeyGen's CDN.
   */
  thumbnailUrl: string;
  /**
   * The original `static.heygen.ai` CDN poster URL from the registry, kept as a
   * documented fallback. NOT fetched at runtime — `thumbnailUrl` (self-hosted)
   * is authoritative; this only records provenance / a manual recovery path.
   */
  cdnThumbnailUrl?: string;
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

/**
 * The resolution preset matching a registry template's authored canvas, so a
 * project created from it renders at the template's NATIVE aspect ratio instead
 * of the portrait default (which would letterbox/distort a 1920×1080 block).
 * Returns null for non-registry modules — the hand-authored templates are
 * responsive and keep the existing portrait-first default.
 */
export function resolutionForModule(module: string): RenderResolution | null {
  const t = REGISTRY_TEMPLATES.find((x) => x.slug === module);
  if (!t) return null;
  if (t.width > t.height) return "landscape";
  if (t.height > t.width) return "portrait";
  return "square";
}
