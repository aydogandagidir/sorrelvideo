import { createRequire } from "node:module";
import path from "node:path";

// @hyperframes/studio ships NO tailwind preset (its exports point at a file that
// isn't published), so we use a vanilla Tailwind v3 config and scan the studio
// source so every utility class it uses is generated. studio.css supplies the
// @tailwind layers + the dark global theme.
const nodeRequire = createRequire(import.meta.url);
const studioSrc = path.dirname(nodeRequire.resolve("@hyperframes/studio"));

/** @type {import("tailwindcss").Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
    path.join(studioSrc, "**", "*.{ts,tsx}"),
  ],
  theme: { extend: {} },
  plugins: [],
};
