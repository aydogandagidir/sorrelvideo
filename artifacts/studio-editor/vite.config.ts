import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import replace from "@rollup/plugin-replace";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

/**
 * Builds @hyperframes/studio (a single-tenant Vite SPA shipped as raw `src/`)
 * for embedding in Sorrel under /editor/ (same-origin, so the `sid` cookie
 * flows). Two transforms are essential:
 *
 *  1. `base: "/editor/"` so every asset URL is emitted under /editor/ (the
 *     studio is served from a sub-path, not the app root).
 *  2. A string-replace that REPOINTS the studio's hardcoded `/api/*` calls to
 *     the Sorrel `/api/studio/*` namespace — otherwise they collide with
 *     Sorrel's own `/api/projects` entity API. Quote-agnostic keys (no quote
 *     prefix) so single/double/backtick literals are all caught; every
 *     `/api/projects|events|render/` in the studio is a file-server call that
 *     must be repointed, so blanket replacement is correct. A post-build
 *     assertion (scripts/assert-repoint.mjs) fails the build if any un-repointed
 *     `/api/projects` or `/api/events` survives.
 */
const nodeRequire = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
// Resolves the "." export (./src/index.ts) → dirname is the studio `src/` dir.
const studioSrc = path.dirname(nodeRequire.resolve("@hyperframes/studio"));

export default defineConfig({
  base: "/editor/",
  server: {
    // Dev only: the editor's own Vite dev server proxies /api → the api-server
    // so its repointed /api/studio/* calls reach Sorrel. In production the
    // editor is served by express under /editor/ (same origin — no proxy).
    proxy: {
      "/api": { target: "http://localhost:8080", changeOrigin: true },
    },
  },
  resolve: {
    alias: {
      // studio's `exports` map doesn't expose the css; alias the real file so
      // main.tsx can pull the @tailwind layers + studio's global dark theme.
      "@studio/studio.css": path.join(studioSrc, "styles", "studio.css"),
      // @hyperframes/core@0.6.6 declares this subpath in `exports` but doesn't
      // ship the file (packaging bug); redirect to a local stub. See the stub.
      "@hyperframes/core/runtime/lottie-readiness": path.resolve(
        here,
        "src/stubs/lottie-readiness.ts",
      ),
    },
  },
  plugins: [
    react(),
    // enforce:"pre" — the replaces must see the RAW .tsx source. Without it the
    // react plugin compiles JSX first, so the `<HyperframesLogo />` key never
    // matches and the wordmark swap silently no-ops (header renders empty: the
    // function-neutralize below, being plain JS, still applies). The /api
    // repoints are plain string literals and work identically pre or post.
    Object.assign(
      replace({
      preventAssignment: true,
      delimiters: ["", ""],
      values: {
        "/api/projects": "/api/studio/projects",
        "/api/events": "/api/studio/events",
        "/api/render/": "/api/studio/render/",
        // REBRAND: the studio header hardcodes the HeyGen/HyperFrames wordmark
        // (<HyperframesLogo /> in StudioHeader.tsx). Users must see Sorrel, not
        // the engine vendor — swap the JSX usage for a Sorrel Studio wordmark
        // (inline styles only: the studio's Tailwind scan doesn't see injected
        // class names, so utility classes here would silently not exist).
        "<HyperframesLogo />":
          '<span style={{ fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em", color: "#fff", userSelect: "none" }}>Sorrel <span style={{ color: "#A3E635" }}>Studio</span></span>',
        // Lint modal's copy-prompt mentions the engine too.
        "these HyperFrames lint issues": "these Sorrel Studio lint issues",
        // Header shows the bare numeric project id ("3") — label it so users
        // understand what the number is.
        'text-neutral-300">{projectId}</span>':
          'text-neutral-300">{"Project " + projectId}</span>',
        // Early-return the now-unused vendor logo component so its SVG body
        // becomes unreachable code the minifier strips — the bundler keeps the
        // (unreferenced) function itself, and the artwork must not ship.
        "function HyperframesLogo() {": "function HyperframesLogo() { return null;",
      },
      }),
      { enforce: "pre" as const },
    ),
    {
      // Build guard: fail if any un-repointed /api/projects|events|render literal
      // survived (it would hit Sorrel's entity API instead of the /api/studio/*
      // file server). Runs after the bundle is written.
      name: "assert-repoint",
      closeBundle(): void {
        const offenders: string[] = [];
        let sawSorrelMark = false;
        let sawVendorLogo = false;
        const scan = (dir: string): void => {
          for (const name of fs.readdirSync(dir)) {
            const p = path.join(dir, name);
            if (fs.statSync(p).isDirectory()) {
              scan(p);
              continue;
            }
            if (!/\.(js|css|html)$/.test(name)) continue;
            const txt = fs.readFileSync(p, "utf8");
            const re = /\/api\/(projects|events|render)\b/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(txt)) !== null) {
              offenders.push(`${name}: ${txt.slice(m.index, m.index + 24)}`);
            }
            // The wordmark must land in the compiled JS (the .html <title>
            // already says "Sorrel" — counting it would mask a failed swap,
            // which is exactly how the first rebrand attempt slipped through).
            if (name.endsWith(".js") && txt.includes("Sorrel")) {
              sawSorrelMark = true;
            }
            // The HeyGen/HyperFrames logo SVG is uniquely identified by its
            // 263×79 viewBox; its presence means the rebrand replace missed.
            if (txt.includes("0 0 263 79")) sawVendorLogo = true;
          }
        };
        scan(path.resolve(here, "dist"));
        if (offenders.length > 0) {
          throw new Error(
            `[assert-repoint] un-repointed API paths:\n  ${offenders.slice(0, 12).join("\n  ")}`,
          );
        }
        if (sawVendorLogo || !sawSorrelMark) {
          throw new Error(
            `[assert-repoint] rebrand check failed (vendor logo present: ${sawVendorLogo}, Sorrel mark present: ${sawSorrelMark}) — the <HyperframesLogo /> replace in vite.config.ts no longer matches the studio source`,
          );
        }
      },
    },
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
