import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// Dev/preview server port. Defaults to 5173 when unset (e.g. during `vite build`,
// where the server port is irrelevant). An explicitly-set invalid value still errors.
const rawPort = process.env.PORT;
const port = rawPort ? Number(rawPort) : 5173;

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Vite base path. Defaults to "/" for local dev. Git Bash (MSYS) rewrites a
// lone "/" env value into the Git install path (e.g. "C:/Program Files/Git/"),
// which breaks asset URLs — detect that and reset to "/".
function resolveBasePath(): string {
  const raw = process.env.BASE_PATH;
  if (!raw || raw === "/") return "/";
  if (/program files|:[\\/]|[\\/]git[\\/]?$/i.test(raw)) return "/";
  return raw;
}

const basePath = resolveBasePath();

export default defineConfig({
  base: basePath,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(
        import.meta.dirname,
        "..",
        "..",
        "attached_assets",
      ),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    // In dev the SPA runs on its own port; proxy API + auth-redirect calls to
    // the api-server (default :8080). Override with API_PROXY_TARGET.
    // In production the api-server serves the built SPA itself, so no proxy.
    proxy: {
      "/api": {
        target: process.env.API_PROXY_TARGET ?? "http://localhost:8080",
        changeOrigin: true,
      },
    },
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
