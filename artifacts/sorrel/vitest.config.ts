import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The React plugin gives test files the automatic JSX runtime (so component
  // tests don't need `React` in scope), matching the production Vite build.
  plugins: [react()],
  // Belt-and-suspenders: force esbuild's JSX transform to the automatic runtime
  // for any file the React/Babel plugin doesn't pre-transform.
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  test: {
    name: "sorrel",
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
});
