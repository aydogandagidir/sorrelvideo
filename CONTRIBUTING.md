# Contributing to Sorrel

Thanks for working on Sorrel. This is a **private, proprietary** codebase — contributions are from
authorized collaborators only. This guide covers the workflow and the quality bar.

> 📖 The deep architectural reference — every subsystem, gotcha, and decision — lives in
> **[CLAUDE.md](./CLAUDE.md)**. Read the relevant section before making non‑trivial changes.

## Prerequisites

- **Node.js 24** + **pnpm 10** (`corepack enable`)
- **Postgres**, **FFmpeg**, and (optional) **Redis** — see the [README Quick start](./README.md#-quick-start).

## Getting started

```bash
pnpm install
cp .env.example .env        # fill in DATABASE_URL, SESSION_SECRET, …
pnpm --filter @workspace/db run push          # apply schema (dev DB)
pnpm --filter @workspace/api-spec run codegen # generate API types
```

## Branching & commits

- Work on a **feature branch** and open a PR into `main`. **Never push directly to `main`.**
- Use **[Conventional Commits](https://www.conventionalcommits.org/)**:
  `feat(scope): …`, `fix(scope): …`, `docs: …`, `chore: …`, `test: …`, `refactor: …`.
- Keep PRs focused; describe the _why_, not just the _what_.

## Golden rules

- **Never edit generated code** — `lib/api-zod/src/generated/**` and
  `lib/api-client-react/src/generated/**` are produced by Orval. Change `openapi.yaml` and run codegen.
- **Never read `users.plan`** to decide entitlements — derive it via `getUserPlan()` (the Stripe mirror).
- **Don't bypass the toolchain** with `// eslint-disable` or `// @ts-ignore`. Fix the code or narrow the type.
- The Stripe webhook route stays **before** `express.json()` (raw body for signature verification).
- Every persisted row is `userId`‑scoped — return **401** (unauthenticated), **403** (not owner), **404** (missing).
- BullMQ job ids must be **non‑numeric** (`render-<id>`); keep render work fire‑and‑forget at the route.

## Making common changes

| Change             | Steps                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| **DB schema**      | Edit `lib/db/src/schema/*` → `pnpm --filter @workspace/db run push` (dev only) → restart the API       |
| **API contract**   | Edit `lib/api-spec/openapi.yaml` → `pnpm --filter @workspace/api-spec run codegen` → implement route   |
| **New page**       | Add `artifacts/sorrel/src/pages/<name>.tsx` → add a `<Route>` (wrap in `<ProtectedRoute>` if auth‑gated) |

## Quality gates (must pass before merge)

```bash
pnpm run typecheck && pnpm run lint && pnpm test && pnpm run build
```

Husky enforces these locally: **`lint-staged`** on commit and **`typecheck + lint + test`** on push.
CI re‑runs the full pipeline on every PR and also verifies the generated API files are in sync.

## Testing

- **Unit tests** (`*.test.ts[x]`) are DB‑less and fast.
- **Integration tests** (`*.integration.test.ts`, api‑server only) run against a Postgres
  **Testcontainer**, **serially in a single fork** (they share one DB and truncate the same tables).
  They skip themselves when Docker is unavailable; CI always runs them.

Add or update tests for any behavior change.
