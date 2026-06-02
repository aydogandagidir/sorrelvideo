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

| Var                                                             | Required by                             | Purpose                                                                                          |
| --------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                                                  | api-server, db push                     | Postgres connection string                                                                       |
| `REDIS_URL`                                                     | api-server (optional)                   | Enables the durable BullMQ render queue + worker. Unset → renders run inline (fire-and-forget).   |
| `RENDER_CONCURRENCY`                                            | api-server (optional)                   | Render worker concurrency. Defaults to `1` (Chrome + FFmpeg is heavy).                            |
| `RENDER_JOB_ATTEMPTS`                                           | api-server (optional)                   | Render job retry attempts. Defaults to `1` (render failures are usually deterministic).           |
| `SESSION_SECRET`                                                | api-server                              | Session signing (reserved for future use; currently unused but expected to be set)               |
| `PORT`                                                          | api-server, sorrel, mockup-sandbox      | HTTP listen port (each process needs its own)                                                    |
| `BASE_PATH`                                                     | sorrel, mockup-sandbox                  | Vite base path (use `/` locally)                                                                 |
| `ALLOWED_ORIGINS`                                               | api-server (production only)            | Comma-separated full origin URLs allowed by CORS                                                 |
| `APP_URL`                                                       | docs/operations                         | Public URL used to register the Stripe webhook (`${APP_URL}/api/billing/webhook`)                |
| `STRIPE_SECRET_KEY`                                             | api-server, scripts                     | Stripe API key                                                                                   |
| `STRIPE_PUBLISHABLE_KEY`                                        | api-server (only if frontend reads it)  | Publishable key for client-side checkout                                                         |
| `STRIPE_WEBHOOK_SECRET`                                         | api-server                              | Verifies signatures on POST `/api/billing/webhook`                                               |
| `GCS_SERVICE_ACCOUNT_KEY` _or_ `GOOGLE_APPLICATION_CREDENTIALS` | api-server (object uploads)             | GCS auth — base64 JSON _or_ path to JSON. Falls back to Application Default Credentials.         |
| `GCS_PROJECT_ID`                                                | api-server                              | GCP project id. Inferred from JSON in `GCS_SERVICE_ACCOUNT_KEY` mode.                            |
| `PUBLIC_OBJECT_SEARCH_PATHS`                                    | api-server (object uploads)             | Comma-separated bucket paths searched by `GET /api/storage/public-objects/*`                     |
| `PRIVATE_OBJECT_DIR`                                            | api-server (object uploads)             | Private bucket prefix for user uploads (`/<bucket>/<dir>`)                                       |
| `RESEND_API_KEY`                                                | api-server (auth emails, optional)      | Resend API key. If unset, emails are logged to stdout instead of sent (dev-friendly).            |
| `EMAIL_FROM`                                                    | api-server (when RESEND_API_KEY set)    | From header for auth emails — e.g. `Sorrel <noreply@sorrel.video>`                               |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET`         | api-server (optional)                   | Enables the "Continue with GitHub" button. Callback: `${APP_URL}/api/auth/oauth/github/callback` |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`         | api-server (optional)                   | Enables the "Continue with Google" button. Callback: `${APP_URL}/api/auth/oauth/google/callback` |
| `AI_PROVIDER`                                                   | api-server (AI suggest)                 | `anthropic` (default) or `openai`. Picks which provider `lib/ai` routes calls to.                |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`                         | api-server (when AI_PROVIDER=anthropic) | API key + optional model override (defaults to `claude-haiku-4-5`).                              |
| `OPENAI_API_KEY` / `OPENAI_MODEL`                               | api-server (when AI_PROVIDER=openai)    | API key + optional model override (defaults to `gpt-4o-mini`).                                   |
| `SENTRY_DSN` / `VITE_SENTRY_DSN`                                | api-server / sorrel (optional)          | Sentry error tracking. Init is a no-op when unset, app still runs.                               |
| `SENTRY_TRACES_SAMPLE_RATE`                                     | api-server / sorrel (optional)          | Sentry trace sampling — defaults to `0.1` (10 %).                                                |
| `LOGTAIL_SOURCE_TOKEN`                                          | api-server (optional)                   | Better Stack / Logtail log sink. Logs ship to stdout regardless; this just adds a remote target. |
| `GIT_SHA`                                                       | api-server (optional, set by CI)        | Pinned to `github.event.workflow_run.head_sha`; surfaces as the `release` tag in Sentry events.  |

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
| `lib/ai`                   | Provider-agnostic LLM adapter (Anthropic / OpenAI) for AI suggest      |
| `artifacts/api-server`     | Express server, routes, services, render pipeline, Stripe webhooks     |
| `artifacts/sorrel`         | Main React frontend (the Sorrel app)                                   |
| `artifacts/mockup-sandbox` | Hyperframes development sandbox                                        |
| `scripts`                  | Standalone helpers (e.g. `seed-products`)                              |
| `infra`                    | `@workspace/infra` — AWS CDK scaffold for the Lambda render backend (M11, deployed out-of-band; not yet in the workspace install — see Future work) |

## Architecture decisions

- **Multi-tenant isolation invariant**: every persisted row is scoped by `userId`.
  Routes return 401 (unauthenticated), 403 (authenticated but not the owner),
  or 404 (row does not exist).
- **Durable render queue with inline fallback**: `POST /api/projects/:id/render`
  atomically claims the project (conditional `UPDATE ... WHERE status <> 'rendering'`
  — the concurrency guard, 409 to the loser), flips status to `rendering`, and
  returns 202 immediately. When `REDIS_URL` is set the job is enqueued on a BullMQ
  queue and consumed by an in-process worker that survives restarts; when unset it
  runs inline (fire-and-forget), so local dev needs no Redis. The frontend polls
  every 3 seconds. State machine: `draft|failed|ready → rendering → ready|failed`.
  On boot, `recoverStuckRenders()` resets orphaned `rendering` rows (no live job)
  back to `failed`.
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
header). 7-day TTL.

**Email verification** is best-effort: signup creates the account and an
unverified row in `email_verifications` (HMAC-SHA256(token, SESSION_SECRET)
storage, 24-hour TTL). The user gets a `/verify-email?token=...` link by
email; consuming it sets `users.emailVerifiedAt` and deletes the row.
Verification is **not** a login gate yet — users keep working while
unverified, and `/api/auth/resend-verification` can re-send the link.

**Password reset**: `POST /api/auth/forgot-password` always returns 200 to
avoid email enumeration. If the email matches a user, a token (30-minute
TTL, single-use, stored as HMAC hash in `password_resets`) is mailed. The
user posts the token + new password to `/api/auth/reset-password`.

**Rate limiting** (`express-rate-limit`, in-memory): `/api/auth/login` 5/15min
per IP+email, `/api/auth/signup` 3/hour per IP, `/api/auth/forgot-password`
3/hour per IP+email, `/api/auth/verify-email` + `/auth/resend-verification`
10/hour per IP. Swap to a Redis store before scaling horizontally.

**Email transport**: `lib/email.ts` wraps Resend. When `RESEND_API_KEY` is
unset (typical local dev) it logs the message body instead — the app keeps
working without an external dependency.

## AI module

The Studio page exposes an "✨ Fill with AI" button that calls
`POST /api/ai/suggest { prompt }` and auto-fills the headline, bodyText,
and ctaText fields. The route lives in
`artifacts/api-server/src/routes/ai.ts` and delegates to `getProvider()`
from `@workspace/ai` — a provider-agnostic adapter with two
implementations (`anthropic`, `openai`). `AI_PROVIDER` env picks one;
`ANTHROPIC_MODEL` / `OPENAI_MODEL` env optionally override the model.

Brand voice: the user picks one of four canonical tones
(`professional|playful|bold|minimal`) on the Brand Kit page and can
attach free-text "voice notes". Both are stored on `brand_kit` and merged
into the system prompt by `buildSystemPrompt` (`lib/ai/src/prompt.ts`).
User prompt is treated as separate data (separate role) to soften
prompt-injection risk; the LLM response is then `SuggestOutputSchema`-
parsed (`lib/ai/src/schema.ts`) before going back to Studio.

**AI quota**: Free 10/month, Pro unlimited.
`checkAndIncrementAiCount` in `billingService.ts` mirrors
`checkAndIncrementRenderCount` (pg row-lock + monthly reset).
`/api/billing/info` returns `aiCount` + `aiLimit` so the frontend can
warn before the cap. 403 with `reason: "upgrade_required"` triggers the
`UpgradeModal` (`reason="ai_limit"`). A separate `aiSuggestLimiter`
(express-rate-limit, 20 / 15min per IP+user) protects the LLM provider
from a single account hammering it.

Tokens are deliberately not stored: AI provider keys live only in env,
and provider response usage is logged but not persisted.

## OAuth (GitHub + Google)

Optional, gated by env. When
`GITHUB_OAUTH_*` / `GOOGLE_OAUTH_*` are set, login and signup show
"Continue with …" buttons that bounce through
`/api/auth/oauth/<provider>` → provider authorize URL → callback. The
callback exchanges the code via `arctic`, fetches the provider profile,
and calls `findOrCreateOAuthUser`:

- If the `(provider, providerAccountId)` pair already maps to a user →
  log them in.
- Else if the provider's verified email matches an existing user → link
  the identity and log them in.
- Else create a new user. Email coming from the provider counts as
  verified — `users.emailVerifiedAt` is set immediately.

The OAuth identity row lives in `oauth_accounts`. No provider tokens are
stored; we only need the identity for sign-in.

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
- **Render-settings capability matrix**: the Free floor reproduces today's render
  output — `draft|standard` quality, `24|30` fps, ≤1080p (non-4k), `mp4`, opaque,
  watermarked, ≤1 transition. Everything else (high quality, 60fps, any `-4k`
  resolution, webm/mov/png-sequence export, transparent background, watermark removal,
  >1 transition) is Pro. `assertRenderSettingsAllowed` enforces this, reusing the
  existing `getUserPlan` + `403 { reason: "upgrade_required" }` pattern (byte-identical
  to the premium-template / quota rejections, so the same `UpgradeModal` fires). The
  gate runs at PATCH time AND again at render time (defense in depth — a user who
  downgrades must not render a previously-saved Pro config).

## Render pipeline

- Endpoint: `POST /api/projects/:id/render` atomically claims the project
  (`UPDATE ... WHERE status <> 'rendering' RETURNING` — one winner, else 409),
  checks quota, enqueues, returns 202
- Trigger: `enqueueRender` in `lib/renderQueue.ts` — enqueues a BullMQ job when
  `REDIS_URL` is set, else runs `executeRender` inline (fire-and-forget)
- Worker + recovery: `startRenderWorker()` (in-process; no-op without Redis)
  consumes jobs; `recoverStuckRenders()` on boot resets orphaned `rendering` rows
- Service: `executeRender` in `services/renderService.ts` runs the Hyperframes
  producer (the work half)
- Output: `artifacts/api-server/renders/<projectId>/output.mp4`
- Streaming: `GET /api/projects/:id/video` ranges over the file
- Polling: frontend re-queries project status every 3 seconds
- **Template substitution**: before each render, `renderService` reads the
  composition HTML, merges the user's brand kit with the project's
  `compositionVars` JSON, and writes a per-project
  `renders/<projectId>/composition.html` that Hyperframes consumes. The
  substitution helper `renderCompositionTemplate(source, vars)` replaces
  `{{key}}` placeholders, HTML-escapes the value, and converts `\n` in
  `user.*` keys to `<br/>`. Unknown placeholders are left intact for
  debug-ability. `STUDIO_FALLBACKS` covers every required key so a render
  always produces sensible output even with no brand kit set
- **Per-project render settings**: the `projects.render_settings` jsonb column
  (`$type<RenderSettings>`) holds the user-editable render config —
  `{ fps: 24|30|60, quality: draft|standard|high, format: mp4|webm|mov|png-sequence,
  resolution: landscape|portrait|square (+ each `-4k` variant), transparent, watermark,
  transitions? }`. Null → `DEFAULT_RENDER_SETTINGS` (draft / 30fps / mp4 / portrait /
  opaque / watermarked) so legacy projects render byte-for-byte as before. Edited via the
  dedicated, Pro-gated `PATCH /api/projects/:id/render-settings` (NOT the generic project
  PATCH — that would let Pro-only knobs be set un-gated). The settings service lives in
  `services/renderSettingsService.ts`: `resolveSettings` (coerce a partial/null blob into a
  complete valid object), `assertRenderSettingsAllowed` (the Free/Pro gate, see Billing),
  `resolveDimensions` (pixel size per resolution preset), and `toEngineConfig` (the one
  adapter mapping `RenderSettings` → the engine's `RenderConfig`).
- **Engine config is derived from settings**: `executeRender` re-reads the project's
  `renderSettings` at render time and builds the producer `RenderConfig` via
  `toEngineConfig(resolveSettings(...), entryFile)`. The previously hardcoded
  `{ fps: {num:30,den:1}, quality: "draft" }` is gone. `enqueueRender` / `executeRender`
  thread a `renderJobId` through both the inline and BullMQ paths.
- **`render_jobs` ledger**: a per-attempt audit table (`lib/db/src/schema/render.ts`,
  row type `RenderJobRow`) distinct from the project's own `status`/`renderError`. One
  row per render attempt: `id` (uuid — doubles as a queue correlation id, so non-numeric
  on purpose), `projectId`, `userId`, `backend` (`inline|bullmq|lambda`), `externalId`,
  `status` (`queued|rendering|ready|failed|cancelled`), `progress`, `costCents`, `format`,
  `config` (a `RenderSettings` snapshot), `outputPath`, `error`, `cancelRequested`,
  timestamps. CRUD + lifecycle setters live in `services/renderJobsService.ts`;
  `recoverStuckRenders()` now reconciles orphaned `render_jobs` rows alongside stuck
  projects, and `truncateAll()` clears the table.
- **Hyperframes API (verified against 0.6.6)**: producer `RenderConfig.fps` is an exact
  rational `{ num, den }` (NOT an enum); `format` ∈ `mp4|webm|mov|png-sequence` (webm/mov/
  png-sequence carry true alpha); `executeRenderJob(job, dir, out, onProgress?, abortSignal?)`
  accepts an `AbortSignal` and throws `RenderCancelledError` on cancel (treated as a
  rollback-to-draft, not a failure). Resolution presets mirror core's `CANVAS_DIMENSIONS`
  (the 6 named presets above); dimensions are composition-authored, with
  `RenderConfig.outputResolution` (a `CanvasResolution`) as the override.

## Known gotchas

- Run `pnpm --filter @workspace/db run push` after every schema change before
  restarting the API server
- Run `pnpm --filter @workspace/api-spec run codegen` after every OpenAPI edit;
  generated files are committed
- `@hyperframes/engine` ships TypeScript that needs `dom`, `dom.iterable` and
  `@webgpu/types` — these are added to the api-server tsconfig. Do not remove them
- Puppeteer is in `onlyBuiltDependencies` in `pnpm-workspace.yaml` — required
  for the Hyperframes render pipeline
- BullMQ rejects purely-numeric custom job ids ("Custom Id cannot be integers").
  The render queue keys jobs as `render-<projectId>` via `jobIdFor()` in
  `renderQueue.ts` — keep render job ids non-numeric
- The render producer reads its core runtime from `<cwd>/core/dist`. The Docker
  image materializes it; for local dev run the api-server from the repo root (so
  cwd has `core/dist`) — `cp -rL artifacts/api-server/node_modules/@hyperframes/core/dist core/dist`
- **Windows install**: the root `preinstall` script runs `sh -c '...'`, which fails
  under PowerShell (`'sh' is not recognized`). Run `pnpm install` from a shell that has
  `sh` on PATH — Git Bash or WSL
- `@hyperframes/core`'s ESM `dist` uses extensionless relative imports. esbuild (the
  prod bundle) and `tsc` (types only) resolve these fine, but Node's native ESM loader
  (used by vitest) cannot — so any module that imports a **runtime** value from core
  needs `server.deps.inline: [/@hyperframes\/core/]` in `vitest.config.ts`.
  `renderSettingsService` sidesteps this today by keeping a local `CANVAS_DIMENSIONS`
  copy (verified against 0.6.6) instead of importing it
- CORS is permissive in dev (`origin: true`); in production it enforces
  `ALLOWED_ORIGINS` strictly. **`ALLOWED_ORIGINS` must include the app's own
  public origin** — the api-server serves the SPA same-origin, and Vite tags its
  module `<script>`/`<link>` tags `crossorigin`, so the browser fetches even
  same-origin bundle assets in CORS mode (with an `Origin` header). The origin
  callback resolves a disallowed origin to `false` (omit `Access-Control-Allow-Origin`;
  the browser still blocks the cross-origin read) — it must **never** `cb(new Error())`.
  Throwing makes `cors` call `next(err)` → a 500 that also kills those same-origin
  asset loads, white-screening the whole SPA whenever `ALLOWED_ORIGINS` is unset or
  even slightly mismatched (http/https, www, trailing slash). Regression-guarded by
  `artifacts/api-server/src/app.test.ts`
- Drizzle returns `Date` objects; before passing rows through Zod parsing,
  serialize via `JSON.parse(JSON.stringify(data))`
- The Stripe webhook route is registered **before** `express.json()` so the
  raw body is preserved for signature verification — do not move it
- Object storage talks to GCS directly via `@google-cloud/storage`
  (`bucket.file(name).getSignedUrl({ version: "v4" })`). Pick an auth mode
  from `.env.example` — base64 service-account JSON for containers,
  `GOOGLE_APPLICATION_CREDENTIALS` for local dev, or ADC for workload
  identity

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

Vitest workspace runs four projects: **api-server** (node), **sorrel**
(jsdom), **auth-web** (jsdom), **ai** (node). Run `pnpm test` (CI mode),
`pnpm test:watch` (dev), or `pnpm test:coverage`.

There are two test tiers:

- **Unit tests** (`*.test.ts`/`*.test.tsx`) — DB-less and fast. Password
  hashing, schema parsing, route-auth rejection paths, useAuth fetch
  mocks, render template substitution.
- **Integration tests** (`*.integration.test.ts`) — only inside
  `api-server`. Run against a real Postgres instance booted by Vitest's
  `globalSetup` (`src/test/global-setup.ts`) via
  `@testcontainers/postgresql`. The container is created once per `pnpm
test` invocation, the Drizzle schema is applied through
  `pnpm --filter @workspace/db run push-force`, and the URL is
  `provide()`-d to workers (read in `src/test/setup.ts`). Each test calls
  `truncateAll()` in `beforeEach`. Current coverage:
  `billingService` render + AI race tests and Pro bypass,
  `getBillingInfo` snapshot, `webhookHandlers.upsertSubscription` +
  `deleteSubscription`, `applyBillingMigration` idempotency.

**Docker dependency**: integration tests need a reachable container
runtime. If Docker isn't running locally, `globalSetup` logs a warning
and the integration suites skip themselves (`describe.runIf`) — unit
tests still run. CI uses `ubuntu-latest` which has Docker built in, so
integration tests run there unconditionally. Override with
`SORREL_SKIP_INTEGRATION_DB=true` to force-skip even when Docker is
present.

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

**Hosting target: Railway.** Single container running the Node 24
api-server, which also serves the Vite SPA bundle out of `/app/public`
via `express.static` + an SPA fallback for client-side routing. The
Dockerfile builds both packages in one multi-stage image (Chromium
system dependencies installed; Puppeteer's downloaded binary copied
across).

**CI** (`.github/workflows/ci.yml`): on every PR and push to `main` —
install deps, verify OpenAPI codegen is in sync, lint, typecheck, run
Vitest (with Postgres testcontainer for integration tests), build.

**Deploy** (`.github/workflows/deploy.yml`): listens for the CI workflow
to finish on `main`; if green, runs `railway up --service api --detach`
using a `RAILWAY_TOKEN` secret. Subsequent pushes auto-ship.

**Observability**:

- **Sentry** (`@sentry/node` + `@sentry/react`) — error tracking;
  release tag pinned to the deploy commit's `GIT_SHA`. `beforeSend`
  scrubs password / token fields from request bodies. No-op when
  `SENTRY_DSN` is unset so local dev stays clean.
- **Better Stack / Logtail** (`@logtail/pino`) — structured log sink
  layered on top of Pino. Stdout always carries the logs (Railway
  scrapes that too); the Logtail target is only attached when
  `LOGTAIL_SOURCE_TOKEN` is present.

**One-time setup** for every clean environment: see `DEPLOYMENT.md` —
Stripe products + webhook, Resend domain verify, GCS bucket + service
account, optional GitHub/Google OAuth apps, Railway env paste, custom
domain DNS, first manual `pnpm --filter @workspace/db run push` against
production.

Production schema migrations are **manual** (`railway run pnpm --filter
@workspace/db run push`). Wiring `db push` into the deploy pipeline is
deliberately not done — a misclick erasing prod data is the easiest
disaster to write.

## Future work

Tracked here so it does not get rediscovered each time:

1. **Multi-instance auth limiters**: the durable render queue (BullMQ + Redis)
   has landed (see Architecture decisions / Render pipeline). The remaining Redis
   follow-on is backing the in-memory `express-rate-limit` auth limiters with
   `rate-limit-redis` (reusing `REDIS_URL`) so they stay correct across more than
   one instance.
2. **Legal pages**: static Terms / Privacy / cookie banner. Stripe +
   any EU user makes this mandatory before broad launch.
3. **End-to-end Playwright smoke test**: signup → Studio → render →
   mp4 served. Currently the only render-pipeline check is `pnpm run
build`.
4. **Module completion**: Bulk, Analytics, Collab — each needs a spec
   before implementation. Studio MVP (Tur 6) and AI MVP (Tur 7) landed.
5. **AI v2**: streaming responses, per-field regen, prompt history,
   custom prompt templates
6. **Studio v2**: timeline / segment editor, custom asset upload, more
   parametric templates beyond `studio-default.html`
7. **Auth integration tests**: signup → user row + session cookie,
   login → session lookup, OAuth account linking (depends on an email
   transport stub).
8. **Sentry source map upload**: `sentry-cli releases files
upload-sourcemaps` in the deploy workflow + strip `.map` from the
   shipped artifact.
9. **Distributed render backend (M11)**: the render-backend abstraction
   (`inline | bullmq | lambda`, recorded on `render_jobs.backend`) and the
   `infra/` AWS CDK scaffold (S3 render bucket + Hyperframes Lambda / Step
   Functions state machine, least-privilege IAM, `deploy-infra.yml`) exist as
   scaffolding only. Still pending: adding `infra/*` to `pnpm-workspace.yaml` +
   install, the api-server glue (`renderBackend.ts` / `lambdaBackend.ts` plugging
   into `renderQueue.ts`), and a deliberate `@hyperframes/*` version alignment
   (`0.6.6` → `0.6.65`) once the player / studio / `aws-lambda` packages are
   adopted. The `@hyperframes/aws-lambda` API used by the CDK stack is
   developer-stated and unverified until then.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Pointers

- `engineering:architecture` skill for ADR-style writeups when introducing a
  new module or replacing a major dependency
- `engineering:code-review` skill before merging anything that touches billing
  or auth
