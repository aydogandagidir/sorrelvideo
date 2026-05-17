# Sorrel

Modular video production SaaS. Users compose branded short-form video by picking
HTML templates, the backend renders them with the Hyperframes engine
(Chrome BeginFrame + FFmpeg) and serves the resulting MP4 back to the app.
Billing runs on Stripe; the app is multi-tenant (every row is `userId`-scoped)
and currently in private alpha — billing is live, the Studio / AI / Bulk /
Analytics / Collab modules are partial or planned.

This file is the single source of truth for how to develop in this repo. Read
it before touching code; update it when an architectural decision changes.

---

## Quick start

```bash
pnpm install
# Postgres must be reachable via DATABASE_URL (local or Docker).
pnpm --filter @workspace/db run push       # apply Drizzle schema to dev DB
pnpm --filter @workspace/api-spec run codegen   # regenerate Zod + React Query
pnpm --filter @workspace/api-server run dev # API on PORT (default 8080)
pnpm --filter @workspace/sorrel run dev    # Vite frontend on PORT
```

Copy `.env.example` to `.env` and fill in values before booting the API server.

## Required env

| Var                      | Required by                            | Purpose                                                                            |
| ------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------- |
| `DATABASE_URL`           | api-server, db push                    | Postgres connection string                                                         |
| `SESSION_SECRET`         | api-server                             | Session signing (reserved for future use; currently unused but expected to be set) |
| `PORT`                   | api-server, sorrel, mockup-sandbox     | HTTP listen port (each process needs its own)                                      |
| `BASE_PATH`              | sorrel, mockup-sandbox                 | Vite base path (use `/` locally)                                                   |
| `ALLOWED_ORIGINS`        | api-server (production only)           | Comma-separated full origin URLs allowed by CORS                                   |
| `APP_URL`                | docs/operations                        | Public URL used to register the Stripe webhook (`${APP_URL}/api/billing/webhook`)  |
| `STRIPE_SECRET_KEY`      | api-server, scripts                    | Stripe API key                                                                     |
| `STRIPE_PUBLISHABLE_KEY` | api-server (only if frontend reads it) | Publishable key for client-side checkout                                           |
| `STRIPE_WEBHOOK_SECRET`  | api-server                             | Verifies signatures on POST `/api/billing/webhook`                                 |

## Stack

- **Runtime**: Node.js 24, pnpm workspaces, TypeScript 5.9 strict
- **Backend** (`artifacts/api-server`): Express 5, Drizzle ORM + Postgres,
  Stripe SDK, `@hyperframes/producer` + `@hyperframes/core`, Puppeteer,
  Pino logging, `@node-rs/argon2` for password hashing
- **Frontend** (`artifacts/sorrel`): React 19, Vite 7, Wouter, TanStack Query,
  Tailwind v4, Shadcn UI, Framer Motion
- **Auth**: cookie- and bearer-token sessions stored in Postgres (`sessions`),
  Argon2id-hashed email/password. OAuth (GitHub/Google) is not wired yet
- **Codegen**: Orval reads `lib/api-spec/openapi.yaml` and writes to
  `lib/api-zod/src/generated/` (Zod schemas) and
  `lib/api-client-react/src/generated/` (React Query hooks)
- **Bundler**: esbuild for the API server (CJS bundle), Vite for the frontend

## Monorepo layout

| Package                    | Role                                                                   |
| -------------------------- | ---------------------------------------------------------------------- |
| `lib/db`                   | Drizzle schema (single source of truth) + `db` and `pool` exports      |
| `lib/api-spec`             | OpenAPI YAML + Orval config (single source of truth for API contracts) |
| `lib/api-zod`              | Generated Zod schemas — **do not edit by hand**                        |
| `lib/api-client-react`     | Generated React Query hooks — **do not edit by hand**                  |
| `lib/auth-web`             | Frontend `useAuth` hook (provider-agnostic; talks to `/api/auth/*`)    |
| `lib/object-storage-web`   | Google Cloud Storage helper                                            |
| `artifacts/api-server`     | Express server, routes, services, render pipeline, Stripe webhooks     |
| `artifacts/sorrel`         | Main React frontend (the Sorrel app)                                   |
| `artifacts/mockup-sandbox` | Hyperframes development sandbox                                        |
| `scripts`                  | Standalone helpers (e.g. `seed-products`)                              |

## Architecture decisions

- **Multi-tenant isolation invariant**: every persisted row is scoped by `userId`.
  Routes return 401 (unauthenticated), 403 (authenticated but not the owner),
  or 404 (row does not exist).
- **Render is fire-and-forget**: `POST /api/projects/:id/render` flips status to
  `rendering` and returns 202 immediately. The job runs in the background; the
  frontend polls every 3 seconds. State machine: `draft|failed → rendering → ready|failed`.
- **HTML compositions as templates**: each template is a self-contained HTML
  file in `artifacts/api-server/src/compositions/`. Chrome (Puppeteer + BeginFrame)
  rasterizes it and FFmpeg encodes the frames to MP4.
- **Direct Express video streaming**: `GET /api/projects/:id/video` streams
  from `artifacts/api-server/renders/<projectId>/output.mp4`. There is no CDN yet.
- **OpenAPI-driven contracts**: edit `openapi.yaml`, run codegen, then implement
  in the backend route. The frontend hook is auto-generated.
- **Billing source of truth**: Stripe subscriptions, mirrored locally into
  `stripe_subscriptions` by webhook events. `getUserPlan(stripeCustomerId)` reads
  that mirror — never check `users.plan`.
- **Render quota**: Free users are limited to 3 renders / month, enforced via a
  Postgres row-lock transaction in `checkAndIncrementRenderCount`. Pro renders
  are not counted, so a downgrade does not pre-consume quota.
- **Premium gating** is enforced twice: in the `/templates` list endpoint
  (filters `isPremium=true` for Free users) and at render time
  (`POST /projects/:id/render`).
- **Auth**: cookie + bearer-token sessions; Argon2id password hashes; sessions
  stored in `sessions` table with 7-day TTL. Provider-agnostic frontend hook.

## Development workflow

**DB schema change**

1. Edit a file under `lib/db/src/schema/`
2. `pnpm --filter @workspace/db run push` (dev only — never auto-run on prod)
3. Restart the API server

**API contract change**

1. Edit `lib/api-spec/openapi.yaml`
2. `pnpm --filter @workspace/api-spec run codegen`
3. Implement the route handler in `artifacts/api-server/src/routes/`
4. The matching React Query hook is regenerated automatically; just import it

**New frontend page**

1. Create `artifacts/sorrel/src/pages/<name>.tsx`
2. Add a `<Route>` in `artifacts/sorrel/src/App.tsx` (wrap with
   `<ProtectedRoute>` if auth is required)
3. If it should appear in the chrome, add it to `NAV_ITEMS` in
   `artifacts/sorrel/src/components/layout.tsx`

## Auth model

Email + password sessions, no third-party identity provider in the loop:

- `POST /api/auth/signup` creates a user (Argon2id hash) and a session cookie
- `POST /api/auth/login` verifies the password and issues a session cookie
- `POST /api/auth/logout` deletes the session and clears the cookie
- `GET /api/auth/user` returns `{ user }` or `{ user: null }`
- `GET /api/login` and `GET /api/logout` are backward-compat browser redirects
  used by `useAuth().login()` / `useAuth().logout()`
- `useAuth()` from `@workspace/auth-web` exposes `loginWithPassword`, `signup`,
  `logout`, `refresh`, plus the `login()` redirect helper

Sessions live in the `sessions` table (`sid` cookie or `Authorization: Bearer`
header). 7-day TTL. OAuth, email verification, password reset, and rate
limiting are deliberately deferred — see "Future work" below.

## Billing

- Stripe is the source of truth; locally we cache subscription state in
  `stripe_subscriptions` (populated by webhook events
  `customer.subscription.{created,updated,deleted,resumed,paused,trial_will_end}`)
- `getUserPlan(stripeCustomerId)` reads `stripe_subscriptions` and returns
  `'pro'` if any row has `status IN ('active', 'trialing')`, else `'free'`
- The webhook URL must be registered manually in the Stripe Dashboard at
  `${APP_URL}/api/billing/webhook` and `STRIPE_WEBHOOK_SECRET` must be set
- `applyBillingMigration()` runs on startup; it only ensures billing columns
  exist on `users` (idempotent). The `stripe_subscriptions` table comes from
  Drizzle schema push
- `users.plan` and `users.stripeSubscriptionId` are reserved schema columns;
  never use them as the source of truth

## Render pipeline

- Endpoint: `POST /api/projects/:id/render` flips status, returns 202
- Service: `services/renderService.ts` runs the Hyperframes producer in the
  background
- Output: `artifacts/api-server/renders/<projectId>/output.mp4`
- Streaming: `GET /api/projects/:id/video` ranges over the file
- Polling: frontend re-queries project status every 3 seconds

## Known gotchas

- Run `pnpm --filter @workspace/db run push` after every schema change before
  restarting the API server
- Run `pnpm --filter @workspace/api-spec run codegen` after every OpenAPI edit;
  generated files are committed
- `@hyperframes/engine` ships TypeScript that needs `dom`, `dom.iterable` and
  `@webgpu/types` — these are added to the api-server tsconfig. Do not remove them
- Puppeteer is in `onlyBuiltDependencies` in `pnpm-workspace.yaml` — required
  for the Hyperframes render pipeline
- CORS is permissive in dev (`origin: true`); in production it enforces
  `ALLOWED_ORIGINS` strictly
- Drizzle returns `Date` objects; before passing rows through Zod parsing,
  serialize via `JSON.parse(JSON.stringify(data))`
- The Stripe webhook route is registered **before** `express.json()` so the
  raw body is preserved for signature verification — do not move it
- `artifacts/api-server/src/lib/objectStorage.ts` still talks to a local
  object-storage sidecar at `127.0.0.1:1106` (legacy from the previous hosting
  environment). Outside that environment GCS calls fail. Replacing this with
  service-account auth + native `getSignedUrl` is tracked under "Future work"
  — until then, brand/project file uploads only work where that sidecar is
  reachable. The endpoint is overridable via `OBJECT_STORAGE_SIDECAR_URL`

## Don't do this

- Edit anything under `lib/api-zod/src/generated/` or
  `lib/api-client-react/src/generated/` — regenerate via codegen instead
- Create `package-lock.json` or `yarn.lock`; the root `preinstall` script
  enforces pnpm and removes them
- Read `users.plan` to decide whether a user is Pro — call `getUserPlan()`
- Await the render job inside the render endpoint — keep it fire-and-forget
- Move the Stripe webhook route after `express.json()` — signature verification
  needs the raw `Buffer`
- Use `req.user.id` without first calling `req.isAuthenticated()`
- Run `pnpm --filter @workspace/db run push` against a production database
  automatically (e.g. from a post-merge or CI hook)
- Bypass lint errors with `// eslint-disable` or `// @ts-ignore` — the config
  is strict on purpose. Fix the code, narrow the type, or open a PR that
  revises the rule itself with rationale

## Testing strategy

Vitest workspace runs three projects: **api-server** (node), **sorrel** (jsdom),
and **auth-web** (jsdom). Run `pnpm test` (CI mode), `pnpm test:watch`
(dev), or `pnpm test:coverage`.

Initial coverage is intentionally narrow (smoke level): password hashing,
`getUserPlan(null)` short-circuit, route 401 paths for `/projects` and
`/auth`, and `useAuth` hydration + login fetch mock.

Each testable package owns a `vitest.config.ts`; the workspace root has
`vitest.workspace.ts`. The api-server project loads `src/test/setup.ts`
which seeds env defaults (`DATABASE_URL`, `SESSION_SECRET`, Stripe stubs)
so import-time validations don't trip during unit tests. **Tests must not
hit the real database**; supertest route tests cover the auth-rejection
path only. Use `vi.mock` for any DB-touching test until a Postgres
testcontainer setup is added.

ESLint relaxes `no-explicit-any`, `no-non-null-assertion`, and `no-console`
inside `**/*.test.{ts,tsx}` and `**/test/**`. Husky's `pre-push` runs the
full suite, so a broken test blocks `git push`.

Playwright / E2E can wait until there is meaningful UI surface to cover.

## Lint & format

ESLint 9 flat config lives at the workspace root in `eslint.config.mjs`. It
runs in **strict mode** — every rule is `error`, there are no warnings to
ignore. Run `pnpm run lint` to check and `pnpm run lint:fix` to auto-fix.
Prettier 3 handles formatting; ESLint defers to it via `eslint-config-prettier`
(loaded last). Generated files (`lib/api-{zod,client-react}/src/generated/**`)
and HTML compositions are excluded from linting.

Notable rule decisions:

- `@typescript-eslint/no-explicit-any` and `no-non-null-assertion` are
  **errors** — narrow types or use a guarded check (`if (!x) throw …`)
- `unused-imports/no-unused-imports` is error with auto-fix; underscore-prefixed
  vars (`^_`) are intentionally ignored
- `react-refresh/only-export-components` is **off** — Shadcn/cva re-exports
  variants alongside components and the rule fights that idiom
- `react/no-unknown-property` has `cmdk-input-wrapper` allowlisted
- `@typescript-eslint/no-namespace` allows `declare namespace` (used for Express
  request augmentation)

## Deployment

CI runs on GitHub Actions (`.github/workflows/ci.yml`): on every PR and on
`push` to `main` it installs deps, verifies that OpenAPI codegen is in
sync, lints, typechecks, applies the Drizzle schema to a Postgres service
container, runs the Vitest suite, and builds every package. A permanent
hosting target has not been chosen. Reasonable candidates: Railway / Fly /
Render / Vercel for the frontend. Whatever the choice:

- The API server is a single Node 24 process listening on `PORT`
- The frontend is a static Vite build (`pnpm --filter @workspace/sorrel run build`
  produces `dist/public/`)
- The Stripe webhook needs a public HTTPS URL configured in the Stripe Dashboard
- Postgres can be any managed Postgres (Neon, Supabase, RDS, etc.)
- Puppeteer needs a Chromium binary in the runtime image

## Future work

Tracked here so it does not get rediscovered each time:

1. **Object storage migration**: drop the `objectStorage.ts` sidecar dependency
   and use a GCS service account directly (`GOOGLE_APPLICATION_CREDENTIALS` +
   native `bucket.file().getSignedUrl()`)
2. **Auth hardening**: rate limiting for `/api/auth/*`
   (express-rate-limit), email verification, password reset (Resend)
3. **OAuth providers** via `arctic` (GitHub + Google planned)
4. **Studio module MVP**: parametric compositions + brand-kit injection +
   render flow
5. **Test depth**: add a Postgres testcontainer so `billingService` race
   tests and `webhookHandlers.upsertSubscription` can run against a real DB
6. **Module completion** (after Studio): AI, Bulk, Analytics, Collab — each
   needs a spec before implementation

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Pointers

- `engineering:architecture` skill for ADR-style writeups when introducing a
  new module or replacing a major dependency
- `engineering:code-review` skill before merging anything that touches billing
  or auth
