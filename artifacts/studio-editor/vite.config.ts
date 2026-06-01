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
    replace({
      preventAssignment: true,
      delimiters: ["", ""],
      values: {
        "/api/projects": "/api/studio/projects",
        "/api/events": "/api/studio/events",
        "/api/render/": "/api/studio/render/",
      },
    }),
    {
      // Build guard: fail if any un-repointed /api/projects|events|render literal
      // survived (it would hit Sorrel's entity API instead of the /api/studio/*
      // file server). Runs after the bundle is written.
      name: "assert-repoint",
      closeBundle(): void {
        const offenders: string[] = [];
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
          }
        };
        scan(path.resolve(here, "dist"));
        if (offenders.length > 0) {
          throw new Error(
            `[assert-repoint] un-repointed API paths:\n  ${offenders.slice(0, 12).join("\n  ")}`,
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
