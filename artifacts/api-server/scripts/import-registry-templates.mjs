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
const REF = "main";
const RAW = (p) => `https://raw.githubusercontent.com/${REPO}/${REF}/${p}`;
const SOURCE_URL = (slug) =>
  `https://github.com/${REPO}/tree/${REF}/registry/blocks/${slug}`;

const CWD = process.cwd(); // artifacts/api-server when run via pnpm exec
const COMPOSITIONS_DIR = path.join(CWD, "src", "compositions");
const MANIFEST_PATH = path.join(
  COMPOSITIONS_DIR,
  "registry-templates.generated.json",
);
const NOTICE_PATH = path.join(COMPOSITIONS_DIR, "REGISTRY-NOTICE.md");

/**
 * Curated first batch. `category` + `isPremium` are Sorrel product decisions
 * (the registry has neither). name/description/duration/dimensions/tags/thumbnail
 * come from each block's registry-item.json. Slugs that turn out to need local
 * assets are skipped automatically (logged), so this list can be generous.
 * @type {{slug:string, category:string, isPremium:boolean}[]}
 */
const CURATION = [
  { slug: "apple-money-count", category: "Data", isPremium: false },
  { slug: "data-chart", category: "Data", isPremium: false },
  { slug: "world-map", category: "Data", isPremium: false },
  { slug: "us-map-bubble", category: "Data", isPremium: true },
  {
    slug: "logo-outro",
    category: "Branding",
    isPremium: false,
    // Brand injection: recolor the assembly logo with the brand palette and make
    // the brand NAME the hero wordmark — the outro becomes the USER's brand while
    // keeping the signature piece-by-piece animation. Existing brand-kit fields
    // only (colors + companyName) and no extra assets, so it renders for every
    // user (STUDIO_FALLBACKS cover blanks at render; PREVIEW_FALLBACKS in the
    // gallery preview). The Hyperframes compiler still inlines the GSAP CDN dep.
    inject: [
      { find: 'fill="#F24E1E"', replace: 'fill="{{brand.primaryColor}}"' },
      { find: 'fill="#A259FF"', replace: 'fill="{{brand.secondaryColor}}"' },
      { find: 'fill="#FF7262"', replace: 'fill="{{brand.accentColor}}"' },
      { find: 'fill="#1ABCFE"', replace: 'fill="{{brand.primaryColor}}"' },
      { find: 'fill="#0ACF83"', replace: 'fill="{{brand.accentColor}}"' },
      { find: "Nothing great is made alone.", replace: "{{brand.companyName}}" },
      // Drop the placeholder vanity URL — no website field in the brand kit yet.
      { find: /<div class="url-pill">[\s\S]*?<\/div>/, replace: "" },
    ],
  },
  { slug: "code-snippet-dark-modern", category: "Code", isPremium: false },
  { slug: "code-snippet-light-modern", category: "Code", isPremium: false },
  { slug: "code-snippet-apple-terminal-pro", category: "Code", isPremium: true },
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

  for (const { slug, category, isPremium, inject } of CURATION) {
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
        thumbnailUrl: item.preview?.poster ?? item.preview?.video ?? "",
        source: SOURCE_URL(slug),
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
