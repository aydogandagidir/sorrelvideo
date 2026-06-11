/**
 * Pure color/font utilities for brand extraction. Deliberately dependency-free
 * and side-effect-free so they unit-test without a browser: the Puppeteer
 * scraper returns RAW computed color strings (`rgb(...)`, `#hex`) and these
 * functions parse, normalise, score and pick from them in Node. They are also
 * the deterministic FALLBACK picker used when the AI refine step is unavailable
 * or over quota — so a brand kit is always produced, AI or not.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A scraped color candidate: a normalised #rrggbb hex, where it came from, and a 0–1 prominence weight. */
export interface ColorCandidate {
  hex: string;
  source: string;
  weight: number;
}

const NAMED: Record<string, string> = {
  transparent: "rgba(0,0,0,0)",
  white: "#ffffff",
  black: "#000000",
};

/** Parse a CSS color string the browser produced (rgb/rgba/#hex/a few names) → RGBA, or null. */
export function parseCssColor(input: string | null | undefined): Rgb | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  if (s in NAMED) s = NAMED[s];

  const rgbMatch = s.match(
    /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/,
  );
  if (rgbMatch) {
    const r = clampByte(Number(rgbMatch[1]));
    const g = clampByte(Number(rgbMatch[2]));
    const b = clampByte(Number(rgbMatch[3]));
    let a = 1;
    if (rgbMatch[4] !== undefined) {
      a = rgbMatch[4].endsWith("%")
        ? Number(rgbMatch[4].slice(0, -1)) / 100
        : Number(rgbMatch[4]);
    }
    if ([r, g, b, a].some((n) => Number.isNaN(n))) return null;
    return { r, g, b, a };
  }

  const hex = s.startsWith("#") ? s.slice(1) : null;
  if (hex && /^[0-9a-f]+$/.test(hex)) {
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
        a: 1,
      };
    }
    if (hex.length === 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: 1,
      };
    }
    if (hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: parseInt(hex.slice(6, 8), 16) / 255,
      };
    }
  }
  return null;
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

/** RGB → #rrggbb (lower-case, alpha dropped). */
export function toHex({ r, g, b }: Rgb): string {
  const h = (n: number) => clampByte(n).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Parse any browser color string straight to a #rrggbb hex (null if unparseable or fully transparent). */
export function parseToHex(input: string | null | undefined): string | null {
  const rgb = parseCssColor(input);
  if (!rgb || rgb.a < 0.05) return null;
  return toHex(rgb);
}

/** HSL saturation (0–1) of a hex; greys are ~0. */
export function saturation(hex: string): number {
  const rgb = parseCssColor(hex);
  if (!rgb) return 0;
  const r = rgb.r / 255,
    g = rgb.g / 255,
    b = rgb.b / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  if (max === min) return 0;
  const l = (max + min) / 2;
  const d = max - min;
  return l > 0.5 ? d / (2 - max - min) : d / (max + min);
}

/** Relative luminance (0 = black, 1 = white) via sRGB perceptual weights. */
export function luminance(hex: string): number {
  const rgb = parseCssColor(hex);
  if (!rgb) return 0;
  return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
}

/**
 * A "neutral" is a grey / near-white / near-black: unsuited to be the brand
 * color (every site has white backgrounds and dark text). Low saturation, OR
 * extreme luminance with only mild saturation.
 */
export function isNeutral(hex: string): boolean {
  const sat = saturation(hex);
  const lum = luminance(hex);
  if (sat < 0.15) return true;
  if ((lum > 0.93 || lum < 0.06) && sat < 0.4) return true;
  return false;
}

/** Hue (0–360) of a hex; used to keep secondary/accent visibly distinct from primary. */
export function hue(hex: string): number {
  const rgb = parseCssColor(hex);
  if (!rgb) return 0;
  const r = rgb.r / 255,
    g = rgb.g / 255,
    b = rgb.b / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = Math.round(h * 60);
  return h < 0 ? h + 360 : h;
}

function hueDistance(a: string, b: string): number {
  const d = Math.abs(hue(a) - hue(b));
  return Math.min(d, 360 - d);
}

/** Darken a hex toward black by `amount` (0–1) — used to derive a secondary from the primary. */
export function darken(hex: string, amount: number): string {
  const rgb = parseCssColor(hex);
  if (!rgb) return hex;
  const f = 1 - Math.max(0, Math.min(1, amount));
  return toHex({ r: rgb.r * f, g: rgb.g * f, b: rgb.b * f, a: 1 });
}

const SOURCE_BOOST: Record<string, number> = {
  "theme-color": 0.4,
  cta: 0.5,
  link: 0.3,
  logo: 0.25,
};

function sourceBoost(source: string): number {
  if (source.startsWith("var(")) return 0.45;
  return SOURCE_BOOST[source] ?? 0;
}

/**
 * Merge raw candidates by hex (summing weights, keeping the strongest source),
 * dropping unparseable entries. Returns a clean, deduped, weight-sorted list.
 */
export function mergeCandidates(
  raw: { hex: string; source: string; weight?: number }[],
): ColorCandidate[] {
  const byHex = new Map<string, ColorCandidate>();
  for (const c of raw) {
    const hex = parseToHex(c.hex);
    if (!hex) continue;
    const existing = byHex.get(hex);
    const weight = c.weight ?? 0;
    if (existing) {
      existing.weight += weight;
      if (sourceBoost(c.source) > sourceBoost(existing.source))
        existing.source = c.source;
    } else {
      byHex.set(hex, { hex, source: c.source, weight });
    }
  }
  return [...byHex.values()].sort(
    (a, b) =>
      b.weight + sourceBoost(b.source) - (a.weight + sourceBoost(a.source)),
  );
}

export interface PickedBrandColors {
  primaryColor: string;
  secondaryColor: string;
  accentColor: string | null;
}

const DEFAULT_PRIMARY = "#6366f1";

/**
 * Deterministic brand-color pick from scraped candidates — the fallback when AI
 * refine is off. Primary = the most prominent SATURATED color (the brand color);
 * secondary = a distinct dark/strong color (for the gradient's far stop), else a
 * darkened primary; accent = a third, hue-distinct saturated color, else null.
 */
export function pickBrandColors(
  candidates: ColorCandidate[],
  themeColor?: string | null,
): PickedBrandColors {
  const scored = mergeCandidates(
    themeColor
      ? [{ hex: themeColor, source: "theme-color", weight: 0.5 }, ...candidates]
      : candidates,
  );
  const vivid = scored.filter((c) => !isNeutral(c.hex));

  const primaryColor = vivid[0]?.hex ?? themeColorOr(themeColor) ?? DEFAULT_PRIMARY;
  const primaryWeight = vivid[0]?.weight ?? 0;

  // A vivid runner-up must carry MEANINGFUL page presence before it can claim a
  // brand role. Without this floor a stray illustration/background swatch (e.g.
  // a 0.006-weight dark green on an otherwise blue site — the bluedev.dev case)
  // out-ranks the page's true dark base purely by being hue-distant, and the
  // whole gradient/accent reads off-brand.
  const significant = (c: ColorCandidate) =>
    c.weight >= Math.max(0.05, primaryWeight * 0.1);

  // Secondary: the next SIGNIFICANT vivid color that's a clearly different hue;
  // else a significant DARK vivid (a monochrome brand's saturated dark base —
  // e.g. bluedev.dev's #0f172a slate, which is "blue" by hue so the distance
  // rule skips it and isNeutral() rightly calls it vivid); else the darkest
  // neutral present; else a darkened primary.
  const secondaryColor =
    vivid.find(
      (c) =>
        c.hex !== primaryColor &&
        hueDistance(c.hex, primaryColor) > 25 &&
        significant(c),
    )?.hex ??
    vivid.find(
      (c) => c.hex !== primaryColor && significant(c) && luminance(c.hex) < 0.25,
    )?.hex ??
    darkestNeutral(scored) ??
    darken(primaryColor, 0.55);

  const accentColor =
    vivid.find(
      (c) =>
        c.hex !== primaryColor &&
        c.hex !== secondaryColor &&
        hueDistance(c.hex, primaryColor) > 40 &&
        significant(c),
    )?.hex ?? null;

  return { primaryColor, secondaryColor, accentColor };
}

function themeColorOr(theme?: string | null): string | null {
  const hex = parseToHex(theme);
  return hex && !isNeutral(hex) ? hex : null;
}

function darkestNeutral(candidates: ColorCandidate[]): string | null {
  const neutrals = candidates
    .filter((c) => isNeutral(c.hex) && luminance(c.hex) < 0.4)
    .sort((a, b) => luminance(a.hex) - luminance(b.hex));
  return neutrals[0]?.hex ?? null;
}

const GENERIC_FONTS = new Set([
  "sans-serif",
  "serif",
  "monospace",
  "system-ui",
  "-apple-system",
  "blinkmacsystemfont",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "inherit",
  "initial",
]);

/**
 * Clean a raw font-family token (e.g. `"Inter", sans-serif` → `Inter`) into a
 * single family name safe to store and inject into CSS. Strips quotes, rejects
 * generic families and anything with CSS-breakout characters, caps length.
 */
export function sanitizeFontFamily(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const first = raw.split(",")[0]?.replace(/["']/g, "").trim();
  if (!first) return null;
  if (GENERIC_FONTS.has(first.toLowerCase())) return null;
  // Family names are letters/digits/spaces/hyphens — reject anything that could
  // break out of the single-quoted `font-family: '...'` CSS context.
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}$/.test(first)) return null;
  return first;
}
