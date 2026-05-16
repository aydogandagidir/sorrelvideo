// Root flat-config for the workspace. Single source of truth.
// Run: pnpm run lint  |  pnpm run lint:fix

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactPlugin from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import unusedImports from "eslint-plugin-unused-imports";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.cache/**",
      "**/coverage/**",
      "**/*.tsbuildinfo",
      "**/pnpm-lock.yaml",
      "lib/api-zod/src/generated/**",
      "lib/api-client-react/src/generated/**",
      "artifacts/mockup-sandbox/src/.generated/**",
      "artifacts/api-server/renders/**",
      "artifacts/api-server/src/compositions/**",
      "eslint.config.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    plugins: { "unused-imports": unusedImports },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "error",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-empty-object-type": [
        "error",
        { allowInterfaces: "with-single-extends" },
      ],
      // Allow `declare global { namespace Express { ... } }` for Express
      // type augmentation; this is the documented Express + TS pattern.
      "@typescript-eslint/no-namespace": [
        "error",
        { allowDeclarations: true },
      ],
      "prefer-const": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
  {
    files: [
      "artifacts/sorrel/**/*.{ts,tsx}",
      "artifacts/mockup-sandbox/**/*.{ts,tsx}",
      "lib/auth-web/**/*.{ts,tsx}",
      "lib/object-storage-web/**/*.{ts,tsx}",
      "lib/api-client-react/src/custom-fetch.ts",
    ],
    plugins: {
      react: reactPlugin,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2022 },
    },
    settings: { react: { version: "19.1" } },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactPlugin.configs["jsx-runtime"].rules,
      ...reactHooks.configs.recommended.rules,
      // Shadcn/cva re-exports `buttonVariants`, `badgeVariants`, etc.
      // alongside the component. That is idiomatic; the Fast-Refresh nag
      // would otherwise fire on ~14 files. The actual HMR impact is benign.
      "react-refresh/only-export-components": "off",
      "react/prop-types": "off",
      "react/react-in-jsx-scope": "off",
      // Shadcn/cmdk uses a custom attribute on its input wrapper; the rule
      // doesn't recognize it but it is intentional and supplied by the lib.
      "react/no-unknown-property": [
        "error",
        { ignore: ["cmdk-input-wrapper"] },
      ],
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    files: [
      "artifacts/*/vite.config.ts",
      "artifacts/mockup-sandbox/mockupPreviewPlugin.ts",
    ],
    languageOptions: { globals: { ...globals.node, ...globals.es2022 } },
  },
  {
    files: [
      "artifacts/api-server/**/*.{ts,mts,js,mjs}",
      "scripts/**/*.{ts,mts}",
      "lib/db/**/*.{ts,mts}",
      "lib/api-spec/**/*.{ts,mts}",
      "**/drizzle.config.ts",
      "**/build.mjs",
    ],
    languageOptions: { globals: { ...globals.node, ...globals.es2022 } },
    rules: { "no-console": "off" },
  },
  prettier,
);
