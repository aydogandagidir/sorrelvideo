#!/usr/bin/env node
// @ts-check
/**
 * Vendor curated Hyperframes registry BLOCKS (Apache-2.0) into Sorrel as
 * platform templates. Dev/build-time tool — run once, commit the result:
 *
 *     pnpm --filter @workspace/api-server exec node scripts/import-registry-templates.mjs
 *
 * For each curated slug it fetches the block's `registry-item.json` (metadata)
 * and `<slug>.html` (the composition) from the Apache-2.0 hyperframes repo, then:
 *   1. SKIPS any block that references LOCAL relative assets (./foo.png, assets/…)
 *      — Sorrel renders a single composition.html with no co-located assets, so
 *      an asset-bearing block would render broken. (CDN https refs are fine: the
 *      Hyperframes compiler inlines them at render time — verified in the spike.)
 *   2. Writes the composition to src/compositions/<slug>.html with an attribution
 *      header (Apache-2.0 requires preserving notices).
 *   3. Emits src/compositions/registry-templates.generated.json — the manifest the
 *      hand-written loader (registryTemplates.ts) types + exposes to renderService
 *      (COMPOSITION_MAP) and the seed-templates script (platform template rows).
 *   4. Refreshes src/compositions/REGISTRY-NOTICE.md (license + per-template source).
 *
 * Network is needed ONLY when running this importer; the vendored output is
 * committed, so dev/CI/prod renders never reach out to GitHub.
 */
import fs from "node:fs";
import path from "node:path";

const REPO = "heygen-com/hyperframes";
// Pinned to the audited commit (tag model-assets-v1, @hyperframes 0.6.91) so a
// re-run vendors EXACTLY what was render-verified, not a moving `main` that
// could drift mid-PR. Bump deliberately alongside an engine bump.
const REF = "c52165d1b63cf11955ceb4e2265cbe34b0718852";
const RAW = (p) => `https://raw.githubusercontent.com/${REPO}/${REF}/${p}`;
const SOURCE_URL = (slug) =>
  `https://github.com/${REPO}/tree/${REF}/registry/blocks/${slug}`;
// Self-hosted poster path. Each template's gallery thumbnail is a first-frame
// PNG rendered FROM ITS OWN composition (scripts/generate-thumbnails.mjs →
// src/compositions/thumbnails/<slug>.png) and served by the api-server at this
// static route (see app.ts). This replaces the registry's `static.heygen.ai`
// CDN URL as the canonical `thumbnailUrl`; the CDN URL is retained per-template
// as `cdnThumbnailUrl` (a documented fallback — never fetched at runtime).
const THUMBNAIL_URL = (slug) => `/api/templates/thumbnails/${slug}.png`;

const CWD = process.cwd(); // artifacts/api-server when run via pnpm exec
const COMPOSITIONS_DIR = path.join(CWD, "src", "compositions");
const MANIFEST_PATH = path.join(
  COMPOSITIONS_DIR,
  "registry-templates.generated.json",
);
const NOTICE_PATH = path.join(COMPOSITIONS_DIR, "REGISTRY-NOTICE.md");

/**
 * data-chart's NATIVE typed composition variables (Hyperframes
 * `data-composition-variables`). These are the editorial scalars a user tweaks;
 * each `default` is byte-identical to the block's hardcoded value, so a render
 * with NO variables passed is unchanged. Declared on `<html>` (see the inject
 * rule below) AND emitted into the manifest's `variables` field so a future
 * Studio form can render the right control per `type`.
 *
 * NOTE on the chart series (months / revenueData / conversionData): the engine's
 * typed-variable schema only supports scalar types (string|number|color|boolean
 * |enum) — there is no array/number-list type. The series therefore are NOT
 * declared here; instead the composition script reads them from getVariables()
 * with the original arrays as code-side defaults, so they are still overridable
 * at render time via `config.variables` (jsonb `compositionVars`) while the
 * typed defaults above stay valid. See the inject rule for the script rewrite.
 *
 * @type {import("@hyperframes/core").CompositionVariable[]}
 */
const DATA_CHART_VARIABLES = [
  {
    id: "title",
    type: "string",
    label: "Title",
    default: "Monthly Revenue vs. Conversion Rate",
  },
  {
    id: "subtitle",
    type: "string",
    label: "Subtitle",
    default: "Jan–Jun 2024, in thousands",
  },
  {
    id: "source",
    type: "string",
    label: "Source line",
    default: "Source: Internal analytics",
  },
  {
    id: "maxRevenue",
    type: "number",
    label: "Revenue axis max ($K)",
    default: 25,
    min: 1,
  },
  {
    id: "maxConversion",
    type: "number",
    label: "Conversion axis max (%)",
    default: 5,
    min: 1,
  },
];

/**
 * Every apple-terminal variant uses gsap's TextPlugin syntax
 * (`tl.set(el,{text:""})`) to clear the typed line, but only gsap core is
 * bundled, so each render logs "Missing plugin? TextPlugin". The typing itself
 * is driven by direct textContent writes, so this set is a no-op — replace it
 * with a plain DOM write to silence the log without loading the heavier plugin.
 * Shared across all 12 terminal entries (the original `-pro` + the 11 themes).
 * @type {{find:string|RegExp,replace:string}[]}
 */
const APPLE_TERMINAL_INJECT = [
  { find: 'tl.set(typedEl, { text: "" }, 0);', replace: 'typedEl.textContent = "";' },
];

/**
 * Curated first batch. `category` + `isPremium` are Sorrel product decisions
 * (the registry has neither). name/description/duration/dimensions/tags/thumbnail
 * come from each block's registry-item.json. Slugs that turn out to need local
 * assets are skipped automatically (logged), so this list can be generous.
 * @type {{slug:string, category:string, isPremium:boolean, inject?:{find:string|RegExp,replace:string}[], variables?:import("@hyperframes/core").CompositionVariable[]}[]}
 */
const CURATION = [
  { slug: "apple-money-count", category: "Data", isPremium: false },
  {
    slug: "data-chart",
    category: "Data",
    isPremium: false,
    // Native typed variables (title/subtitle/source/maxRevenue/maxConversion):
    // declared on <html> AND surfaced in the manifest for a future Studio form.
    variables: DATA_CHART_VARIABLES,
    inject: [
      // Brand injection: the two NYT-style data series (grey bars, blue line)
      // adopt the brand palette while the editorial cream background + grid stay.
      { find: "#5c5c5c", replace: "{{brand.primaryColor}}" },
      { find: "#326fa8", replace: "{{brand.accentColor}}" },
      { find: "#326FA8", replace: "{{brand.accentColor}}" },
      // Declare the typed variables on the root <html> element. The engine's
      // getVariables() reads these defaults from document.documentElement and
      // merges window.__hfVariables (config.variables / `compositionVars`) over
      // them, so a render with no variables uses the byte-identical defaults.
      // Single-quoted attribute → the JSON's double quotes need no escaping; the
      // declared defaults contain no single quotes.
      {
        find: '<html lang="en">',
        replace: `<html lang="en" data-composition-variables='${JSON.stringify(
          DATA_CHART_VARIABLES,
        )}'>`,
      },
      // Rewrite the hardcoded data + axis literals to read getVariables(). Each
      // read keeps the original literal as the fallback, so an unset variable is
      // identical to today. window.__hyperframes.getVariables is the runtime
      // global the engine installs (see @hyperframes/core runtime IIFE). title /
      // subtitle / source overwrite their (still-present) static markup as the
      // single source of truth; months/revenueData/conversionData are read here
      // because the typed schema has no array type (see DATA_CHART_VARIABLES).
      {
        find: [
          "          // Data",
          '          const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"];',
          "          const revenueData = [8, 12, 15, 11, 18, 22];",
          "          const conversionData = [2.1, 2.8, 3.2, 2.9, 3.8, 4.2];",
        ].join("\n"),
        replace: [
          "          // Variables (native Hyperframes typed-variable pipeline).",
          "          // Defaults below match the original literals so a render with no",
          "          // variables is byte-identical; config.variables overrides them.",
          "          const vars =",
          '            (window.__hyperframes && window.__hyperframes.getVariables()) || {};',
          "",
          "          const headlineEl = document.querySelector(",
          "            '[data-composition-id=\"data-chart\"] .headline',",
          "          );",
          "          const subtitleEl = document.querySelector(",
          "            '[data-composition-id=\"data-chart\"] .subtitle',",
          "          );",
          "          const sourceEl = document.querySelector(",
          "            '[data-composition-id=\"data-chart\"] .source',",
          "          );",
          "          if (headlineEl && vars.title != null) headlineEl.textContent = vars.title;",
          "          if (subtitleEl && vars.subtitle != null) subtitleEl.textContent = vars.subtitle;",
          "          if (sourceEl && vars.source != null) sourceEl.textContent = vars.source;",
          "",
          "          // Data",
          '          const months = vars.months ?? ["Jan", "Feb", "Mar", "Apr", "May", "Jun"];',
          "          const revenueData = vars.revenueData ?? [8, 12, 15, 11, 18, 22];",
          "          const conversionData = vars.conversionData ?? [2.1, 2.8, 3.2, 2.9, 3.8, 4.2];",
        ].join("\n"),
      },
      // Axis scales: read the typed number variables, default to the literals.
      {
        find: [
          "          // Scales",
          "          const maxRevenue = 25;",
          "          const maxConversion = 5;",
        ].join("\n"),
        replace: [
          "          // Scales (typed number variables; default to the originals).",
          "          const maxRevenue = vars.maxRevenue ?? 25;",
          "          const maxConversion = vars.maxConversion ?? 5;",
        ].join("\n"),
      },
    ],
  },
  // NOTE: brand injection was evaluated for world-map + us-map-bubble and
  // reverted — a choropleth's sequential color scale is a perceptual data
  // encoding, and recoloring only the CSS legend (not the D3 fill scale) left the
  // legend and map inconsistent. Data-viz palettes are kept as-authored.
  { slug: "world-map", category: "Data", isPremium: false },
  { slug: "us-map-bubble", category: "Data", isPremium: true },
  {
    slug: "logo-outro",
    category: "Branding",
    isPremium: false,
    // Brand injection: show the USER'S real uploaded logo when brand.logoUrl is
    // set, and otherwise fall back to the registry's abstract 5-piece shape
    // (recolored with the brand palette). The brand NAME becomes the hero
    // wordmark. Existing brand-kit fields only — no extra assets — so it renders
    // for every user (STUDIO_FALLBACKS cover blanks at render: brand.logoUrl
    // defaults to "" → the fallback shape; PREVIEW_FALLBACKS in the gallery
    // preview). The Hyperframes compiler still inlines the GSAP CDN dep.
    //
    // The fallback is driven purely by CSS attribute selectors so a single
    // composition handles both states with no JS branching:
    //   - <img class="brand-logo" src="{{brand.logoUrl}}"> — `[src=""]` (the
    //     empty default) is hidden, a set URL is shown (max ~420px, centered on
    //     the SVG's spot).
    //   - When the img has a non-empty src it hides the sibling .logo-container
    //     (the abstract SVG), so only one mark shows at a time.
    // brand.logoUrl is validated as a safe http(s) URL when the brand kit is
    // saved (routes/brand.ts → isSafeLogoUrl), so it can't break out of the
    // src="…" attribute at render time.
    inject: [
      { find: 'fill="#F24E1E"', replace: 'fill="{{brand.primaryColor}}"' },
      { find: 'fill="#A259FF"', replace: 'fill="{{brand.secondaryColor}}"' },
      { find: 'fill="#FF7262"', replace: 'fill="{{brand.accentColor}}"' },
      { find: 'fill="#1ABCFE"', replace: 'fill="{{brand.primaryColor}}"' },
      { find: 'fill="#0ACF83"', replace: 'fill="{{brand.accentColor}}"' },
      { find: "Nothing great is made alone.", replace: "{{brand.companyName}}" },
      // Drop the placeholder vanity URL — no website field in the brand kit yet.
      { find: /<div class="url-pill">[\s\S]*?<\/div>/, replace: "" },
      // Inject the real-logo <img> as a sibling BEFORE the abstract-shape SVG
      // container (so the `~` sibling selector below can hide the SVG).
      {
        find: '<div class="logo-container">',
        replace:
          '<img class="brand-logo" src="{{brand.logoUrl}}" alt="" />\n        <div class="logo-container">',
      },
      // CSS for the real-logo img + the show/hide fallback, injected ahead of the
      // existing .logo-piece rule (a unique anchor in the upstream <style>).
      {
        find: '[data-composition-id="logo-outro"] .logo-piece {',
        replace: [
          '[data-composition-id="logo-outro"] .brand-logo {',
          "          position: absolute;",
          "          left: 960px;", // canvas-centered (1920/2)
          "          top: 500px;", // matches the SVG logo's vertical center
          "          transform: translate(-50%, -50%);",
          "          max-width: 420px;",
          "          max-height: 420px;",
          "          object-fit: contain;",
          "          z-index: 2;",
          "        }",
          "",
          "        /* Empty default (no logo uploaded) → fall back to the SVG shape. */",
          '        [data-composition-id="logo-outro"] .brand-logo[src=""] {',
          "          display: none;",
          "        }",
          "",
          "        /* A real logo is set → hide the abstract-shape SVG container. */",
          '        [data-composition-id="logo-outro"] .brand-logo:not([src=""]) ~ .logo-container {',
          "          display: none;",
          "        }",
          "",
          '        [data-composition-id="logo-outro"] .logo-piece {',
        ].join("\n"),
      },
    ],
  },
  { slug: "code-snippet-dark-modern", category: "Code", isPremium: false },
  { slug: "code-snippet-light-modern", category: "Code", isPremium: false },
  {
    slug: "code-snippet-apple-terminal-pro",
    category: "Code",
    isPremium: true,
    inject: APPLE_TERMINAL_INJECT,
  },
  { slug: "x-post", category: "Social", isPremium: false },
  { slug: "reddit-post", category: "Social", isPremium: false },
  { slug: "instagram-follow", category: "Social", isPremium: false },
  { slug: "tiktok-follow", category: "Social", isPremium: true },
  { slug: "yt-lower-third", category: "Social", isPremium: false },
  { slug: "spotify-card", category: "Social", isPremium: true },
  { slug: "cinematic-zoom", category: "Motion", isPremium: false },
  { slug: "glitch", category: "Motion", isPremium: false },
  { slug: "light-leak", category: "Motion", isPremium: true },
  { slug: "swirl-vortex", category: "Motion", isPremium: true },

  // ── Batch 2 (×51): every importable single-file block not yet vendored. ──
  // Categories + premium splits are Sorrel product calls; NO brand injection
  // for any of these groups (maps are perceptual data encodings; shader/vfx/
  // transition demos are scene content — recoloring them is neither cheap nor
  // obvious; the macos/showcase blocks would each need bespoke anchors — a
  // later pass). The 12 apple-terminal variants share the TextPlugin-silencing
  // inject below.

  // Data / Diagram / Showcase / Social (9)
  { slug: "us-map", category: "Data", isPremium: false },
  { slug: "us-map-hex", category: "Data", isPremium: true },
  { slug: "us-map-flow", category: "Data", isPremium: true },
  { slug: "spain-map", category: "Data", isPremium: true },
  { slug: "flowchart", category: "Diagram", isPremium: false },
  { slug: "flowchart-vertical", category: "Diagram", isPremium: false },
  { slug: "macos-notification", category: "Social", isPremium: false },
  { slug: "app-showcase", category: "Showcase", isPremium: false },
  { slug: "ui-3d-reveal", category: "Showcase", isPremium: true },

  // Named shader transitions (10) — 4s two-scene demos, premium Effects shelf.
  { slug: "chromatic-radial-split", category: "Effects", isPremium: true },
  { slug: "cross-warp-morph", category: "Effects", isPremium: true },
  { slug: "domain-warp-dissolve", category: "Effects", isPremium: true },
  { slug: "flash-through-white", category: "Effects", isPremium: true },
  { slug: "gravitational-lens", category: "Effects", isPremium: true },
  { slug: "ridged-burn", category: "Effects", isPremium: true },
  { slug: "ripple-waves", category: "Effects", isPremium: true },
  { slug: "sdf-iris", category: "Effects", isPremium: true },
  { slug: "thermal-distortion", category: "Effects", isPremium: true },
  { slug: "whip-pan", category: "Effects", isPremium: true },

  // transitions-* showcase reels (13) — premium Effects.
  { slug: "transitions-3d", category: "Effects", isPremium: true },
  { slug: "transitions-blur", category: "Effects", isPremium: true },
  { slug: "transitions-cover", category: "Effects", isPremium: true },
  { slug: "transitions-destruction", category: "Effects", isPremium: true },
  { slug: "transitions-dissolve", category: "Effects", isPremium: true },
  { slug: "transitions-distortion", category: "Effects", isPremium: true },
  { slug: "transitions-grid", category: "Effects", isPremium: true },
  { slug: "transitions-light", category: "Effects", isPremium: true },
  { slug: "transitions-mechanical", category: "Effects", isPremium: true },
  { slug: "transitions-other", category: "Effects", isPremium: true },
  { slug: "transitions-push", category: "Effects", isPremium: true },
  { slug: "transitions-radial", category: "Effects", isPremium: true },
  { slug: "transitions-scale", category: "Effects", isPremium: true },

  // VFX (4 kept) — all premium WebGL.
  // DROPPED (verified empirically by isolated render probes on the render box,
  // chrome-headless-shell + software GPU):
  //  - liquid-glass-context-menu / liquid-glass-media-controls (webgpu): no
  //    WebGPU on the render box → ~15-21 KiB near-empty output.
  //  - vfx-text-cursor / vfx-liquid-glass (html-in-canvas drawElementImage):
  //    pinned to 1 worker + screenshot mode, they don't finish a render in 200s
  //    of software-GPU capture → CI-timeout + minutes-long user renders.
  // The 4 kept vfx-* blocks (liquid-background/magnetic/portal/shatter) are
  // WebGL and probe-render in well under the cap. Re-add the dropped four only
  // if the render backend gains a real GPU / WebGPU.
  { slug: "vfx-liquid-background", category: "Effects", isPremium: true },
  { slug: "vfx-magnetic", category: "Effects", isPremium: true },
  { slug: "vfx-portal", category: "Effects", isPremium: true },
  { slug: "vfx-shatter", category: "Effects", isPremium: true },

  // Apple-terminal code themes (11): 3 free + 8 premium theme packs.
  { slug: "code-snippet-apple-terminal-basic", category: "Code", isPremium: false, inject: APPLE_TERMINAL_INJECT },
  { slug: "code-snippet-apple-terminal-clear-dark", category: "Code", isPremium: false, inject: APPLE_TERMINAL_INJECT },
  { slug: "code-snippet-apple-terminal-clear-light", category: "Code", isPremium: false, inject: APPLE_TERMINAL_INJECT },
  { slug: "code-snippet-apple-terminal-grass", category: "Code", isPremium: true, inject: APPLE_TERMINAL_INJECT },
  { slug: "code-snippet-apple-terminal-homebrew", category: "Code", isPremium: true, inject: APPLE_TERMINAL_INJECT },
  { slug: "code-snippet-apple-terminal-man-page", category: "Code", isPremium: true, inject: APPLE_TERMINAL_INJECT },
  { slug: "code-snippet-apple-terminal-novel", category: "Code", isPremium: true, inject: APPLE_TERMINAL_INJECT },
  { slug: "code-snippet-apple-terminal-ocean", category: "Code", isPremium: true, inject: APPLE_TERMINAL_INJECT },
  { slug: "code-snippet-apple-terminal-red-sands", category: "Code", isPremium: true, inject: APPLE_TERMINAL_INJECT },
  { slug: "code-snippet-apple-terminal-silver-aerogel", category: "Code", isPremium: true, inject: APPLE_TERMINAL_INJECT },
  { slug: "code-snippet-apple-terminal-solid-colors", category: "Code", isPremium: true, inject: APPLE_TERMINAL_INJECT },
];

/** Does the composition reference LOCAL relative assets we can't vendor inline? */
function needsLocalAssets(html) {
  // src/href="./x" or "../x", url(./x), or a bare assets/ path. CDN https:// and
  // data: URIs are fine (compiler inlines / they're self-contained).
  return (
    /(?:src|href)\s*=\s*["'](?:\.\.?\/|assets\/)/i.test(html) ||
    /url\(\s*["']?(?:\.\.?\/|assets\/)/i.test(html)
  );
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

function attributionHeader(slug, item) {
  return [
    "<!--",
    `  Adapted from the Hyperframes registry block "${slug}"`,
    `  (${item.title ?? slug}) — © HeyGen, licensed under Apache-2.0.`,
    `  Source: ${SOURCE_URL(slug)}`,
    "  Vendored into Sorrel by scripts/import-registry-templates.mjs. See",
    "  REGISTRY-NOTICE.md for the full attribution + license.",
    "-->",
    "",
  ].join("\n");
}

async function main() {
  if (!fs.existsSync(COMPOSITIONS_DIR)) {
    console.error(`[import] compositions dir not found: ${COMPOSITIONS_DIR}`);
    process.exit(1);
  }

  const imported = [];
  const skipped = [];

  for (const { slug, category, isPremium, inject, variables } of CURATION) {
    try {
      const item = JSON.parse(
        await fetchText(RAW(`registry/blocks/${slug}/registry-item.json`)),
      );
      const compFile =
        (item.files || []).find((f) => f.type === "hyperframes:composition") ||
        (item.files || [])[0];
      if (!compFile) {
        skipped.push({ slug, reason: "no composition file in registry-item" });
        continue;
      }
      // Only single-file (self-contained) compositions: more files ⇒ assets.
      if ((item.files || []).length > 1) {
        skipped.push({ slug, reason: `${item.files.length} files (needs assets)` });
        continue;
      }

      const html = await fetchText(
        RAW(`registry/blocks/${slug}/${path.basename(compFile.path)}`),
      );
      if (needsLocalAssets(html)) {
        skipped.push({ slug, reason: "references local assets" });
        continue;
      }

      const dims = item.dimensions || {};
      // Apply per-template brand-injection rules (string replaceAll or regex):
      // turn hard-coded brand elements into {{brand.*}} placeholders that
      // renderService substitutes from the user's brand kit at render time.
      let body = html;
      for (const rule of inject ?? []) {
        body =
          typeof rule.find === "string"
            ? body.replaceAll(rule.find, rule.replace)
            : body.replace(rule.find, rule.replace);
      }
      fs.writeFileSync(
        path.join(COMPOSITIONS_DIR, `${slug}.html`),
        attributionHeader(slug, item) + body,
        "utf-8",
      );
      imported.push({
        slug,
        name: item.title || slug,
        description: item.description || "",
        category,
        isPremium,
        duration: Math.max(1, Math.round(item.duration ?? 4)),
        width: dims.width ?? 1920,
        height: dims.height ?? 1080,
        tags: Array.isArray(item.tags) ? item.tags : [],
        // Self-hosted poster (rendered from this composition); the upstream CDN
        // URL is kept alongside as a documented, never-fetched fallback.
        thumbnailUrl: THUMBNAIL_URL(slug),
        cdnThumbnailUrl: item.preview?.poster ?? item.preview?.video ?? "",
        source: SOURCE_URL(slug),
        // Native typed-variable declarations (omitted unless the template
        // declares any — keeps existing manifest rows byte-identical). Mirrors
        // the `data-composition-variables` baked into the HTML; consumed by the
        // typed loader (registryTemplates.ts) for a future Studio form.
        ...(variables && variables.length ? { variables } : {}),
      });
      console.log(`[import] ✓ ${slug} (${imported.at(-1).width}x${imported.at(-1).height}, ${imported.at(-1).duration}s)`);
    } catch (err) {
      skipped.push({ slug, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  // Stable order for a deterministic manifest + gallery.
  imported.sort((a, b) => a.slug.localeCompare(b.slug));
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(imported, null, 2) + "\n", "utf-8");

  const notice = [
    "# Registry template attribution",
    "",
    "The composition files listed below are vendored from the open-source",
    "[Hyperframes registry](https://github.com/heygen-com/hyperframes) and are",
    "licensed by HeyGen under the **Apache License 2.0**. Sorrel adapts them as",
    "platform templates; the original copyright and license are retained.",
    "",
    "| Template | Source |",
    "| --- | --- |",
    ...imported.map((t) => `| \`${t.slug}.html\` | ${t.source} |`),
    "",
    "See https://www.apache.org/licenses/LICENSE-2.0 for the full license text.",
    "",
  ].join("\n");
  fs.writeFileSync(NOTICE_PATH, notice, "utf-8");

  console.log(
    `\n[import] DONE — ${imported.length} imported, ${skipped.length} skipped.`,
  );
  if (skipped.length) {
    console.log("[import] skipped:");
    for (const s of skipped) console.log(`  - ${s.slug}: ${s.reason}`);
  }
  console.log(`[import] manifest: ${MANIFEST_PATH}`);
}

main().catch((err) => {
  console.error(`[import] FAILED: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
