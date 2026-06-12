/**
 * Font listing/serving for the embedded Studio editor's font picker
 * (studio 0.6.91 `propertyPanelFont.tsx` calls `/api/fonts`, `/api/fonts/google`
 * and `/api/fonts/file?family=…`, repointed to `/api/studio/fonts*`).
 *
 * The heavy lifting — walking OS font directories and parsing font binaries for
 * family names — is core's `systemFontLocator`, which core SHIPS in `dist/` but
 * does not re-export from its `exports` map (and Node forbids `imports` targets
 * that reach into node_modules), so the module is VENDORED at
 * `lib/vendor/systemFontLocator.ts` with attribution — the registry-compositions
 * precedent. Re-sync it on engine bumps.
 *
 * Deviations from upstream's `studio-api/routes/fonts.ts` (deliberate):
 * - the macOS `system_profiler` enumeration is omitted — Sorrel's API server
 *   runs on Linux (Docker) or the Windows dev box, where `fontDirectories()`
 *   covers everything;
 * - route plumbing is Express (this module is transport-agnostic; the routes
 *   live in `routes/studio.ts`).
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import {
  collectFontFileEntries,
  fontDirectories,
  locateSystemFont,
  SYSTEM_FONT_SIZE_LIMIT,
} from "../lib/vendor/systemFontLocator";

const MAX_FONT_RESULTS = 2000;
const GOOGLE_FONTS_METADATA_URL = "https://fonts.google.com/metadata/fonts";
const GOOGLE_FONTS_FETCH_TIMEOUT_MS = 3000;

let cachedFonts: string[] | null = null;
let cachedGoogleFonts: string[] | null = null;

/**
 * Served when the Google Fonts metadata endpoint is unreachable (offline dev,
 * egress-restricted prod) — the picker stays useful instead of empty. Mirrors
 * upstream's fallback list.
 */
const GOOGLE_FONT_FALLBACKS = [
  "Inter",
  "Roboto",
  "Open Sans",
  "Montserrat",
  "Poppins",
  "Lato",
  "Oswald",
  "Raleway",
  "Nunito",
  "Playfair Display",
  "Merriweather",
  "Source Sans 3",
  "Source Serif 4",
  "Source Code Pro",
  "DM Sans",
  "Space Grotesk",
  "Space Mono",
  "Bebas Neue",
  "Outfit",
  "JetBrains Mono",
];

/**
 * Families of every font installed on the host, sorted, capped at
 * MAX_FONT_RESULTS, cached for the process lifetime (the host font set doesn't
 * change under a running server; restart to refresh).
 */
export function listInstalledFontFamilies(): string[] {
  if (cachedFonts) return cachedFonts;
  const families = new Set<string>();

  for (const dir of fontDirectories()) {
    for (const entry of collectFontFileEntries(dir)) {
      families.add(entry.family);
      if (families.size >= MAX_FONT_RESULTS) break;
    }
    if (families.size >= MAX_FONT_RESULTS) break;
  }

  cachedFonts = Array.from(families).sort((a, b) => a.localeCompare(b));
  return cachedFonts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseGoogleFontMetadata(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.familyMetadataList)) return [];
  const families: string[] = [];
  for (const entry of value.familyMetadataList) {
    if (!isRecord(entry) || typeof entry.family !== "string") continue;
    families.push(entry.family);
  }
  return families;
}

/** Google's JSON endpoints prefix responses with an anti-XSSI guard — strip it. */
function stripGoogleJsonGuard(raw: string): string {
  const prefix = ")]}'";
  if (!raw.startsWith(prefix)) return raw;
  let index = prefix.length;
  while (index < raw.length && /[\s]/.test(raw[index] ?? "")) index += 1;
  return raw.slice(index);
}

/**
 * Family names from the Google Fonts metadata feed, with a hard 3s timeout and
 * the static fallback list on ANY failure (network, parse, non-200). Cached for
 * the process lifetime — including a fallback result, deliberately: a flapping
 * egress shouldn't re-fetch on every picker open.
 */
export async function listGoogleFontFamilies(): Promise<string[]> {
  if (cachedGoogleFonts) return cachedGoogleFonts;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    GOOGLE_FONTS_FETCH_TIMEOUT_MS,
  );

  try {
    const response = await fetch(GOOGLE_FONTS_METADATA_URL, {
      signal: controller.signal,
    });
    if (!response.ok) {
      cachedGoogleFonts = GOOGLE_FONT_FALLBACKS;
      return cachedGoogleFonts;
    }
    const raw = await response.text();
    const families = parseGoogleFontMetadata(
      JSON.parse(stripGoogleJsonGuard(raw)),
    );
    cachedGoogleFonts = families.length > 0 ? families : GOOGLE_FONT_FALLBACKS;
  } catch {
    cachedGoogleFonts = GOOGLE_FONT_FALLBACKS;
  } finally {
    clearTimeout(timer);
  }

  return cachedGoogleFonts;
}

export interface FontFilePayload {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}

export interface FontFileError {
  status: 404 | 413 | 500;
  error: string;
}

/**
 * Read a system font file for `family`, enforcing upstream's two safety rails:
 * `O_NOFOLLOW` (a symlinked "font" can't escape the font dirs) and the 5MB
 * `SYSTEM_FONT_SIZE_LIMIT`. Returns the bytes + mime + a sanitized download
 * name, or a status-shaped error the route maps 1:1.
 */
export function readSystemFontFile(
  family: string,
): FontFilePayload | FontFileError {
  const located = locateSystemFont(family);
  if (!located) return { status: 404, error: "font not found" };

  let fd: number;
  try {
    fd = openSync(located.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { status: 404, error: "font file not accessible" };
  }
  try {
    const stat = fstatSync(fd);
    if (stat.size > SYSTEM_FONT_SIZE_LIMIT) {
      return { status: 413, error: "font file too large" };
    }
    const buffer = Buffer.alloc(stat.size);
    readSync(fd, buffer, 0, stat.size, 0);
    const mimeType =
      located.format === "otf"
        ? "font/otf"
        : located.format === "woff2"
          ? "font/woff2"
          : located.format === "woff"
            ? "font/woff"
            : located.format === "ttc"
              ? "font/collection"
              : "font/ttf";
    const fileName = `${family.replace(/[^a-zA-Z0-9 -]/g, "")}.${located.format}`;
    return { buffer, mimeType, fileName };
  } catch {
    return { status: 500, error: "failed to read font file" };
  } finally {
    closeSync(fd);
  }
}

/** Test-only: reset the process-lifetime caches. */
export function __resetFontCachesForTest(): void {
  cachedFonts = null;
  cachedGoogleFonts = null;
}
