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
| `RENDER_WORKERS`                                                | api-server (optional)                   | Parallel render workers per job (producer `workers`). Defaults to `2`. The producer otherwise auto-calibrates to the host CPU count (~6 on Railway), and each worker drives its own headless-Chrome context — 6 OOM-crash a small container. Raise on a bigger box. |
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
| `OPENAI_API_KEY` / `OPENAI_MODEL`                               | api-server (when AI_PROVIDER=openai)    | API key + optional model override (defaults to `gpt-4o-mini`). Also powers Whisper auto-captions (`POST /captions/generate`; set `WHISPER_API_KEY` to override). |
| `TTS_API_KEY` / `OPENAI_TTS_MODEL`                              | api-server (talking-host, optional)     | Script→video narration via OpenAI TTS. Falls back to `OPENAI_API_KEY`; model defaults to `gpt-4o-mini-tts` (brand-tone `instructions` only sent on that family). Unset (and no OpenAI key) → `POST /avatar/video` 503s. |
| `IMAGE_API_KEY` / `OPENAI_IMAGE_MODEL` / `OPENAI_IMAGE_QUALITY` / `OPENAI_IMAGE_FORMAT` | api-server (AI background, optional) | AI background-image generation (`POST /projects/:id/ai-image`). **OpenAI-only** (independent of `AI_PROVIDER` — Anthropic has no image API). Key falls back to `OPENAI_API_KEY`; model defaults to `gpt-image-1`, quality `medium` (low/medium/high/auto), format `jpeg` (png/jpeg/webp — bounds the persisted data URI). Unset (and no OpenAI key) → the endpoint 503s. |
| `LOCAL_MEDIA_MODELS`                                            | api-server (**dev only**, optional)     | `=true` + no OpenAI/TTS/Whisper key → TTS (Kokoro-82M) + caption transcription (Whisper base.en) run on LOCAL ONNX models (`kokoro-js` + `@huggingface/transformers`, devDeps). First use downloads ~250MB to the HF cache. An OpenAI key always wins; **ignored when `NODE_ENV=production`** (the fallback never ships). |
| `SENTRY_DSN`                                                    | api-server (optional)                   | Backend Sentry error tracking (runtime). Init is a no-op when unset, app still runs.             |
| `VITE_SENTRY_DSN` / `VITE_SENTRY_TRACES_SAMPLE_RATE`           | sorrel (optional, **build-time**)       | Frontend Sentry. Vite inlines `import.meta.env.VITE_*` at build → must be a Docker build ARG (Railway injects matching service vars). Unset → browser SDK no-ops. |
| `SENTRY_TRACES_SAMPLE_RATE`                                     | api-server (optional)                   | Backend Sentry trace sampling — defaults to `0.1` (10 %).                                        |
| `LOG_LEVEL`                                                     | api-server (optional)                   | Pino level (default `info`). Logs are JSON on stdout; ship them off Railway with a **log drain**, not an in-process transport. |
| `GIT_SHA` / `VITE_GIT_SHA`                                      | api-server / sorrel (optional)          | Sentry `release` tag (backend / frontend). Under the native Railway deploy both fall back to Railway's built-in `RAILWAY_GIT_COMMIT_SHA` (backend reads it at runtime; the Dockerfile defaults the `VITE_GIT_SHA` build ARG from it), so neither needs to be set manually. |

## Stack

- **Runtime**: Node.js 24, pnpm workspaces, TypeScript 5.9 strict
- **Backend** (`artifacts/api-server`): Express 5, Drizzle ORM + Postgres,
  Stripe SDK, `@hyperframes/producer` + `@hyperframes/core`, Puppeteer,
  Pino logging, `@node-rs/argon2` for password hashing
- **Frontend** (`artifacts/sorrel`): React 19, Vite 7, Wouter, TanStack Query,
  Tailwind v4, Shadcn UI, Framer Motion
- **Design system ("Sorrel OS")**: tokens live as shadcn HSL CSS vars in
  `artifacts/sorrel/src/index.css` (ported from the Claude Design handoff) —
  layered **warm-neutral dark** canvas (subtly green), softer **Sorrel lime**
  primary (`75 95% 63%`), and a warm **render/live "spark"** (orange,
  `--spark`/`bg-spark`) that signals rendering (resolving the old lime-vs-orange
  brand split). Type: **Space Grotesk** display (headings) · **Inter** UI ·
  **Space Mono** numerals (loaded in `index.html`; `font-display` utility).
  Changing a token re-skins every shadcn component at once.
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
| `artifacts/studio-editor`  | Repointed `@hyperframes/studio` build (vite repoints `/api/*` → `/api/studio/*` + rebrands), served same-origin under `/editor` (M9). See "Embedded studio editor" / `routes/studio.ts` |
| `artifacts/mockup-sandbox` | Hyperframes development sandbox                                        |
| `scripts`                  | Standalone helpers (e.g. `seed-products`)                              |
| `infra`                    | `@workspace/infra` — AWS CDK scaffold for the Lambda render backend (M11, deployed out-of-band; CDK pin aligned to 0.6.91; not in the workspace install on Windows — see Future work #9) |

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
- **Template library (registry-vendored, Apache-2.0)**: the hand-authored
  compositions are joined by templates vendored from the open-source
  [Hyperframes registry](https://github.com/heygen-com/hyperframes/tree/main/registry)
  (Apache-2.0). `artifacts/api-server/scripts/import-registry-templates.mjs` (the
  registry scripts all live there, NOT repo-root `scripts/`; `REF` is pinned to
  an audited commit for reproducibility) fetches curated blocks → writes
  `<slug>.html` (attribution header) + the
  `compositions/registry-templates.generated.json` manifest + `REGISTRY-NOTICE.md`.
  **Multi-file blocks are supported**: a block whose extra files are all static
  `hyperframes:asset`s (images/audio, allow-listed extensions) is vendored — the
  importer downloads each asset to `compositions/assets/<slug>/<name>`, normalizes
  the composition's relative refs to the canonical `assets/<name>` form, and
  records them in the manifest's `assets[]`. `renderService.copyTemplateAssets`
  copies them next to the per-render `composition.html` (the engine resolves the
  relative refs; an `<audio src="assets/x.wav">` is muxed into the output's audio
  track — sha-proven), and the **allow-listed** `GET /api/templates/:id/assets/:name`
  + `GET /api/projects/:id/assets/:name` routes serve them to the preview iframe
  (`:name` matched against the manifest so it can't traverse). Blocks whose extra
  files are NON-static (`.glb` models, `lib/*.js` runtimes) are still skipped.
  `scripts/verify-registry-renders.mjs`
  render-checks every vendored block against the installed engine.
  `services/registryTemplates.ts` types the manifest and feeds both renderService's
  `COMPOSITION_MAP` (slug → file) and `seedPlatformTemplates()`
  (`services/platformTemplatesService.ts`), which the api-server boot runs
  **idempotently** (insert-if-missing keyed by `module`, never clobbering an
  existing row) so a fresh environment's gallery is never empty. Re-run the
  importer with more slugs to grow the library; a project's `module` is the
  template slug, so no enum/migration is needed to add one.
- **Self-hosted gallery thumbnails**: each template's gallery poster is a
  first-frame PNG rendered FROM its own composition (`scripts/generate-thumbnails.mjs`
  picks the richest frame across 40–95 % of the duration — blank early frames
  compress tiny — and flattens onto a neutral bg), committed under
  `compositions/thumbnails/<slug>.png` and served by the **allow-listed**
  `GET /api/templates/thumbnails/:slug` (public, brand-neutral, `:slug` matched
  against the manifest so it can't traverse). This replaces the runtime dependency
  on HeyGen's `static.heygen.ai` CDN; the original CDN URL is kept per-template as
  `cdnThumbnailUrl` (a documented fallback, never fetched).
- **Parametric templates** (`data-chart` is the first): editable content uses the
  engine's **native typed-variable** pipeline — a `data-composition-variables` JSON
  on `<html>` declares typed scalars (`CompositionVariable`: string|number|color|
  boolean|enum), read at runtime via `getVariables()` with defaults equal to the
  authored literals (so a no-vars render is byte-identical — sha256-proven). The
  manifest carries a `variables?` field per template, **surfaced on the
  `/templates` API** (`Template.variables`, read-time enrichment via
  `variablesForModule` — never persisted) and rendered as a typed form
  (`components/template-params-form.tsx`) on a draft project's detail dialog: one
  control per `type` (string→Input/Textarea, number→number Input, color→color
  picker, boolean→Switch, enum→Select), saved into `compositionVars` keyed by
  variable id. The write path **type-validates** every supplied var against its
  declaration (`lib/typedVars.ts` `findInvalidTypedVar`, wired into POST + PATCH
  `/projects` → 400) — closing the gap where a typed `color` (not in
  `compositionVars`' fixed COLOR_KEYS) would reach the render unchecked. The
  render path forwards `compositionVars` to `config.variables`, which the engine
  merges over the HTML-declared defaults (the typed schema has no array type, so
  list-valued series stay code-side defaults overridable via `compositionVars`);
  string-typed numeric values coerce correctly in the composition's arithmetic
  (render-proven), so no composition-side `Number()` wrapping is needed.
- **Direct Express video streaming**: `GET /api/projects/:id/video` streams
  from `artifacts/api-server/renders/<projectId>/output.<ext>` with HTTP range
  support (mp4/webm/mov/gif — `image/gif` for gif). A **png-sequence** render's
  artifact is a DIRECTORY of frames (not a streamable file), so the same route
  streams it back as a `application/zip` attachment built on the fly with
  `archiver` (STORE level 0 — PNGs are already compressed; constant memory via
  backpressure; no Content-Length → chunked, Range ignored; `archive.directory`
  also picks up the engine's optional `audio.aac` sidecar). There is no CDN yet.
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
- **Security hardening baseline** (enforced app-wide, regression-tested): `app.ts`
  sets `trust proxy = 1` (Railway runs one proxy hop — without it every IP-keyed
  `express-rate-limit` collapses to a single global bucket) and mounts `helmet`
  early for `nosniff` / `frameguard: SAMEORIGIN` (the same-origin
  `<hyperframes-player>` iframe + `/editor` mount must stay framable) /
  `Referrer-Policy` / HSTS-in-prod. helmet's **CSP is deliberately disabled** — a
  strict default CSP white-screens the SPA (inline styles) and breaks renders
  (compositions load CDN GSAP/D3 + inline scripts); a tailored CSP is tracked
  follow-up. Private object reads (`GET /api/storage/objects/*`) are **auth-gated +
  per-object owner-ACL'd** (`canAccessObjectEntity`; objects with no ACL fail
  closed) — the UUID path is never an authorization boundary; uploads are a 2-phase
  flow (`request-url` → client PUT → `PUT /storage/uploads/finalize` stamps
  `owner = req.user.id, visibility = private`). All untrusted text that lands in a
  composition is validated server-side at the write path: `lib/compositionVars.ts`
  (`findUnsafeCompositionVar` in routes, `assertSafeCompositionVars` in services)
  runs every `compositionVars` value that resolves into a URL/attribute/color
  context through `isSafeLogoUrl` / a strict color pattern — because
  `renderCompositionTemplate`'s `escapeMarkup` does **not** escape quotes (it can't:
  `brand.fontFamily` is `'Inter'`, single-quoted, used in CSS). The SAME
  `findUnsafeCompositionVar` gate runs on the **`?vars=` live-preview overrides**
  of `GET /projects/:id/composition` AND the module-keyed
  `GET /compositions/:module/preview` — both substitute the override into the
  composition, so an un-gated value would be reflected XSS against whoever opens
  the (guessable) preview link.

- **Live composition preview**: `GET /projects/:id/composition` (owner-scoped,
  brand-merged, `?vars=` override-able) and `GET /compositions/:module/preview`
  (auth-only, module-keyed via `isKnownModule`, the user's default brand kit +
  `STUDIO_FALLBACKS`, optional `?resolution=`) render the REAL composition HTML
  for a same-origin `<hyperframes-player>` iframe. The Studio create page (no
  project id pre-submit) uses the module route with debounced `user.*` vars; the
  projects detail dialog points a draft/failed project's `HfPlayer` at its own
  composition route (unsaved typed-parameter edits ride along as `?vars=`). A
  changed `src` reloads the iframe; the old presentational rAF mock
  (`CompositionPlayer`/`CompositionLoading`) is deleted.

## Development workflow

**DB schema change**

1. Edit a file under `lib/db/src/schema/`
2. Dev loop: `pnpm --filter @workspace/db run push` (dev only — never auto-run on
   prod). Tests apply the schema via `push-force` (testcontainers, throwaway).
3. Record it in versioned history: `pnpm --filter @workspace/db run generate` —
   writes a reviewed `lib/db/drizzle/<n>_*.sql` + updates `meta/`. Commit the
   WHOLE `drizzle/` dir (the `.sql` AND `meta/_journal.json` + `*_snapshot.json`).
4. Restart the API server (the boot `apply*Migration()` idempotent self-heals
   still run, unchanged — they're the belt-and-suspenders layer, complementary
   to the migration history, not replaced by it).
5. Apply to prod MANUALLY (never on boot/CI — same caution as `db push`):
   `railway run --service api pnpm --filter @workspace/db run migrate`. The FIRST
   migrate on an existing DB needs one-time baseline-stamping (prod's schema
   already exists, so the `0000` baseline must be marked applied, NOT run, or its
   bare `CREATE TABLE`s throw `already exists`) — see DEPLOYMENT.md §9.

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
Consuming it **invalidates every existing session for that user**
(`deleteSessionsForUser`, backed by the `IDX_session_user` expression index)
— a reset must lock out an attacker who already has a live session, so a
stale session can't survive the password change for the 7-day TTL.

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

## Brand DNA (brand kit)

The brand kit is surfaced in the UI as **"Brand DNA"** (Pomelli-style): a rich,
AI-extracted, editable brand profile. The `brand_kit` table holds both the
**visual identity** (logo, primary/secondary/accent color, font) and the
**narrative identity / DNA** (`tagline`, `description`, `valueProposition`,
`targetAudience`, `industry`, `keywords` jsonb`string[]`, `personality`
jsonb`string[]`, `imageStyle`) — all nullable, so a pre-DNA / heuristic kit is
valid. The DNA fields are consumed by the AI copy suggester + the video-idea
generator; they are NOT injected into compositions, so they need no CSS/attr
guard (only colors/logo/font do — `assertSafeBrandFields`).

**Many-per-user** (was one-per-user). `brand_kit` carries `name`, `isDefault`,
and `sourceUrl` (the site a kit was auto-detected from); the old
`UNIQUE(user_id)` is replaced by a **partial-unique index**
`UQ_brand_kit_default ON (user_id) WHERE is_default` — at most one default per
user, many non-defaults. `brandKitService` centralises the invariant: any write
that sets a kit default clears the user's other defaults in the same transaction.
`projects.brandKitId` (a bare integer, like `templateId`) pins a project's kit;
null → the user's default at render time (`renderService.loadBrandKit`).

- **API**: `/brand-kits` collection — `GET` (list, default first), `POST`
  (create), `GET/PATCH/DELETE /brand-kits/:id`, and `POST /brand-kits/extract`
  (detect from a URL, does NOT save). `GET/PUT /brand` are kept as a back-compat
  **default-kit** accessor (studio's `useGetBrandKit`); `GET /brand` returns a
  NON-persisted `transientDefaultBrandKit` when the user has no kit, so it never
  litters an empty placeholder row (a placeholder would wrongly satisfy
  website→video's "do you have a kit?" check and reimpose the generic look).
- **Auto-extraction (`brandExtractionService`)**: `captureWebsite({ extractBrand })`
  scrapes RAW signals in-page — CSS custom props, theme-color, dominant
  CTA/link/header colors (area-weighted frequency map), fonts, logo candidates,
  og:site_name, AND a bounded `textSample` (headings + lead paragraphs).
  `lib/brandColors.ts` (pure, unit-tested) normalises/dedupes the colors and
  `pickBrandColors` makes the deterministic pick. An AI **refine** step
  (`AiProvider.extractBrand`, Claude/OpenAI **vision** on the screenshot +
  signals + page text) returns the full DNA: visual roles (primary/secondary/
  accent + company name + font) AND narrative (tagline, description, value prop,
  audience, industry, keywords, personality, image style). Runs when configured +
  within AI quota (`consumeAiUnitIfAvailable`, charges one AI unit), with the
  deterministic heuristic as a hard fallback (narrative fields null/[] without
  AI) — so extraction always returns a brand. Every value is re-validated
  (`isSafeCssColor`/`isSafeLogoUrl`/`sanitizeFontFamily`) before save/render.
- **DNA-grounded generation**: the AI copy suggester (`/ai/suggest`) loads the
  user's DEFAULT kit and feeds the DNA (description, value prop, audience,
  keywords, personality, voice) into the system prompt via `buildBrandContext`,
  so generated copy is on-brand. website→video already stamps `brandKitId`.
- **Video ideas (Pomelli "campaign ideas")**: `POST /brand-kits/:id/video-ideas`
  → `AiProvider.generateVideoIdeas(dna)` returns 3–5 ready-to-render concepts
  ({title, description, module, headline/body/cta}); the Brand DNA page turns one
  into a project (`POST /projects` with `brandKitId` + `user.*` compositionVars)
  in one click. AI-only (no heuristic), quota-gated, `aiSuggestLimiter`.
- **Validation at write**: `assertSafeBrandFields` rejects unsafe colors / logo /
  font on every create+update (colors land UNQUOTED in composition CSS; the
  template layer only escapes `< > &`, not quotes — see `lib/compositionVars.ts`).
- **AI provider keys** reuse the existing `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
  + `AI_PROVIDER` — no new env. Brand extraction is rate-limited
  (`brandExtractLimiter`, 10 / 15 min) because it launches Chrome.

## OAuth (GitHub + Google)

Optional, gated by env. When
`GITHUB_OAUTH_*` / `GOOGLE_OAUTH_*` are set, login and signup show
"Continue with …" buttons that bounce through
`/api/auth/oauth/<provider>` → provider authorize URL → callback. The SPA
discovers which providers are actually configured via
`GET /api/auth/oauth/providers` (spec-exempt, registered before the
`:provider` route) and renders only those buttons — when none are set the
whole block, including the "or continue with email" divider, is hidden so
the email/password form stands alone (otherwise a button would full-page
navigate to a raw `503` JSON body). The callback exchanges the code via
`arctic`, fetches the provider profile, and calls `findOrCreateOAuthUser`:

- If the `(provider, providerAccountId)` pair already maps to a user →
  log them in.
- Else if the provider's verified email matches an existing user → link
  the identity and log them in.
- Else create a new user. Email coming from the provider counts as
  verified — `users.emailVerifiedAt` is set immediately.

**Only a verified provider email is ever trusted for the email-match link**
(step 2) — otherwise it is account-takeover. GitHub's `/user` profile `email`
field is **not** required to be verified, so it is deliberately ignored; the
email is resolved solely from `/user/emails`, accepting only the entry that is
both `primary` AND `verified` (else the user signs in email-less and won't
auto-link). Google gates on `email_verified`. A GitHub user could otherwise set
their profile email to a victim's address and link into the victim's account.

The OAuth identity row lives in `oauth_accounts`. No provider tokens are
stored; we only need the identity for sign-in.

## Website → Video

`POST /api/website-to-video { url }` screenshots a user-supplied URL and creates
a draft project from the branded `website-showcase` composition, returned so the
SPA (`pages/website-to-video.tsx`) navigates straight to it. The flow:
`websiteToVideoService.createWebsiteVideoProject` →
`websiteCaptureService.captureWebsite` (headless Chrome via Puppeteer) → embeds
the **full-page** screenshot as a `capture.image` **JPEG data URI** in
`compositionVars` (+ `capture.height`/`title`/`url`), at the composition's native
1920×1080. `renderService` substitutes those (HTML-escaping the untrusted
title/url) into `compositions/website-showcase.html` (intro → mac-style browser
scrolling the screenshot → outro CTA).

**Brand wiring (the showcase is actually branded).** The intro card and stage
glow read `brand.primaryColor`/`secondaryColor`/`companyName`, which come from the
project's brand kit at render time (`renderService.loadBrandKit(userId,
brandKitId)`). `createWebsiteVideoProject` resolves and stamps `projects.brandKitId`
up front: an explicit `brandKitId` → the user's **configured** default kit
(`isConfiguredBrandKit` — a real kit, not an empty placeholder) → else it
**auto-extracts a kit from the captured site** and saves it (so the very first
video of a site is branded, not the generic "Your Brand" placeholder). `autoBrand:
true` forces fresh detection even when a default exists. Extraction =
`brandExtractionService` (DOM scrape via the SAME capture + AI refine, see Brand
Kit); the AI step is best-effort + quota-gated (`consumeAiUnitIfAvailable`), with
a deterministic heuristic fallback.

**Length (the "too short / shows it incompletely" fix).** The capture is the
**whole page** (cap raised to 9000px, JPEG-encoded so the inlined data URI stays
bounded — the old 2800px PNG cap truncated tall sites), and `duration` is
**adaptive when omitted**: `computeAutoDuration(captureHeight)` sizes the scroll
to a calm ~360 px/s reading pace (matching the composition's scroll math) so the
ENTIRE page scrolls through without racing, capped at 45s. An explicit `duration`
(3–60) still overrides. `STUDIO_FALLBACKS` keeps `duration: "9"` only for legacy
projects whose `compositionVars` predate the field.

**Brand fidelity (the "doesn't look like my site" fixes — verified against
bluedev.dev).** Three layers:

- **Lazy-load scroll-priming**: before measuring/shooting, `captureWebsite`
  steps the page to the bottom (re-reads `scrollHeight` each step but caps at
  1.2× the height limit so an infinite feed can't run away) and back, then
  settles 500ms — otherwise IntersectionObserver-gated sections never paint and
  the showcase video "scrolls through blank white" below the hero.
- **Truthful previews**: the projects grid + video-dialog placeholder render the
  REAL `compositionVars["capture.image"]` when present instead of the generic
  `CompositionThumb` mock (which fabricates a letter badge + "Learn more" CTA +
  a project-name headline — users read the mock as broken output).
- **Real logo + palette**: `website-showcase`'s intro leads with
  `<img src="{{brand.logoUrl}}">` (CSS `[src=""]` + `onerror` collapse it when
  absent/broken). `pickBrandColors` requires a vivid runner-up to carry
  meaningful weight (`≥ max(0.05, 10% of primary)`) before claiming
  secondary/accent — a 0.006-weight stray swatch can no longer beat the page's
  true dark base — and a saturated dark same-hue base (#0f172a-style slate,
  "vivid" by saturation so `darkestNeutral` never sees it) is an explicit
  secondary tier.

**Capabilities (shipped).** The video dialog (`projects.tsx`) has **Download**
(direct same-origin MP4) + **Share** (Web Share API with the actual file so a
private render shares without a public link; falls back to copy-link). **Length
is selectable** — `website-showcase` reads `data-duration="{{duration}}"` and the
GSAP page-scroll stretches to fill (intro/outro fixed); the request `duration` is
clamped server-side to 3–60, and **omitting it picks an adaptive length** from the
page height (calm full-page scroll, ≤45s — see "Length" above). **Brand** is
user-chosen too (automatic / always-detect / a specific kit). **"Which section" to
feature** is user-chosen, and *every* mode
reduces to one `CropRegion` (0–1 fractions) emitted as `capture.cropX/Y/W/H` that
the composition zooms/pans/scrolls into (default `0/0/1/1` = whole page,
byte-identical). Pure crop math is `lib/websiteCrop.ts`
(`heroCrop`/`bboxToCrop`/`buildCropVars`, clamped + floored so a hostile fraction
can't break the `parseFloat("…")` literals). Modes:

- **Whole page** — `{ url }`, no crop.
- **Drag-select a region** — two-step: `POST /website-to-video/preview { url }`
  captures + returns `{ previewId, image, width, height }` WITHOUT creating a
  project (screenshot held in `websitePreviewStore` — owner-scoped, single-use,
  15-min TTL); the SPA shows it, the user drags, then
  `POST /website-to-video { previewId, crop }`.
- **Hero** — `{ url, section: "hero" }` → `heroCrop()` (top viewport).
- **By element** — `{ url, selector }` → `captureWebsite` resolves the element box
  → `bboxToCrop()`.
- **AI / text** (PLANNED — backend half-done): `captureWebsite({ extractSections })`
  already returns candidate `sections` (label + crop); the missing pieces are a
  `lib/ai` `pickSection(description, sections)` method (both providers) the service
  calls to pick the region from a natural-language prompt (gate with
  `checkAndIncrementAiCount`), plus the interactive multi-mode SPA UI (mode picker
  + drag-select crop component + selector/AI text inputs). See Future work #11.

**Security (SSRF) — this loads an arbitrary user URL server-side:**

- `lib/ssrfGuard.ts` `assertSafeUrl` rejects non-http(s) schemes, embedded
  credentials, blocked hostnames (localhost, cloud metadata), and any host that
  resolves (every address, via `net.BlockList`) to a loopback/private/link-local/
  reserved range — incl. `169.254.169.254`. 21 unit tests.
- The capture re-validates **every main-frame navigation** (redirect-to-internal
  is aborted mid-flight). Residual DNS-rebinding + sub-resource SSRF is the infra
  layer's job: the render box should have **no internal network egress**.
- `websiteCaptureLimiter` (5 / 15 min) — Chrome capture is expensive. `SsrfError`
  → 400, `WebsiteCaptureError` → 502.

**Chrome binary** — two distinct binaries by design (the Dockerfile ships both):

- The **render engine** needs Chrome's `HeadlessExperimental.beginFrame`
  (deterministic, frame-accurate capture). Debian's apt `chromium` is
  `--headless=new` and DROPPED that CDP domain, so the engine's probe rejects →
  it silently falls back to slow screenshot mode and renders **TIME OUT** on
  Railway. The fix ships **`chrome-headless-shell`** (the only headless build that
  still implements beginFrame — pinned by `puppeteer@24.43.1` to 148.x) and sets
  `PRODUCER_HEADLESS_SHELL_PATH=/usr/local/bin/chrome-headless-shell`. Gotcha:
  puppeteer's postinstall downloads the shell **zip** into `~/.cache/puppeteer`
  but FAILS to extract the executable on Debian slim (only `ABOUT` + `LICENSE`
  land), and the wrapper `puppeteer browsers install` then no-ops on that stub
  folder — so the Dockerfile **unzips the intact cached zip itself** into
  `/opt/hf-cache` and symlinks it. `scripts/verify-beginframe.mjs` probes the
  capability inside the image (PASS = beginFrame engages, FAIL = screenshot
  fallback) — run it after any Chrome/puppeteer bump.
- The **website→video capture** (`captureWebsite`, full `puppeteer`, untrusted
  pages) instead wants a sandboxed Chrome. It resolves `executablePath` from
  `CAPTURE_CHROME_PATH ?? PUPPETEER_EXECUTABLE_PATH ?? PRODUCER_HEADLESS_SHELL_PATH`;
  the image sets `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` (the apt package) so
  capture picks that, falling back to `undefined` (puppeteer's own cache) for local
  dev. Without it the capture 502s in prod while normal renders still work.

**`CAPTURE_NO_SANDBOX`**: Chrome's sandbox is ON by default (untrusted pages).
Set `=true` ONLY on container hosts that can't start a sandboxed Chrome (root /
no user namespaces). The captured screenshot is embedded as a **JPEG** data URI
(full page, capped at 9000px tall — JPEG keeps a tall capture's base64 ~1–1.5MB);
moving it to object storage is still a future optimisation.

## Script → talking-host video (avatar's render value)

`POST /api/avatar/video { script (10–1200 chars), voice?, brandKitId? }` turns a
script into a branded talking-host MP4: `talkingHostService.createTalkingHostVideo`
→ `ttsService.synthesizeSpeech` (OpenAI `gpt-4o-mini-tts`, `TTS_API_KEY ??
OPENAI_API_KEY`, brand voice/personality mapped to `instructions`) →
`transcribeBuffer` (the Whisper word-timing core shared with captions, also
surfacing verbose_json's clip `duration`) → creates a `talking-host` project →
**auto-starts the render** via `startProjectRender` (the claim→quota→re-gate→
ledger→enqueue sequence extracted VERBATIM from POST /projects/:id/render — both
callers share one implementation, pinned by the render integration suites). The
SPA panel lives on `/avatar` (`useCreateAvatarVideo`) and lands on
`/projects?focus=<id>` where the normal 3s polling + video dialog take over.

- **Gating**: NOT Pro-gated (deliberately unlike `/avatar/chat`). Free spends
  **1 AI unit** per creation, charged AFTER both providers succeed (the
  routes/ai.ts precedent — a 502 never burns quota); the auto-render consumes
  the regular render quota, and when THAT is exhausted the project still lands
  as a **draft** (`renderStarted: false` + `renderMessage` in the 201).
- **Data channel**: `compositionVars["host.payload"] =
  base64(JSON({intro, outro, words:[[text,start,end],…]}))` — base64 survives
  `escapeMarkup` byte-identical (no quote-escaping hazard). The composition
  (`compositions/talking-host.html`) decodes it, builds mouth tweens per word
  window + branded karaoke (DOM via `textContent` ONLY — words are user script)
  on ONE paused GSAP timeline at `window.__timelines["talking-host"]`; an
  unsubstituted payload (gallery preview) falls back to a built-in ~9s DEMO.
  `duration` = `intro + whisperDuration + outro` (clamped 3–120s).
- **Voiceover track** (`RenderSettings.voiceover { objectPath, startAt,
  volume? }`, server-managed, ABSENT from `RenderSettingsInput`): the TTS mp3 is
  ALWAYS written to `renders/<id>/voice.mp3` (dev needs no GCS) AND uploaded as
  a private GCS object when configured (durable re-renders; `objectPath` null
  without GCS). `renderService.resolveVoiceoverTag` prefers the local file, else
  downloads the object (ownership re-checked), and injects
  `<audio src="voice.mp3" data-start="{startAt}" data-track-index="1">` —
  **no `loop`** (narration must not restart; bg music keeps index 0). Missing
  BOTH sources **fails the render loudly** (`VoiceoverUnavailableError` →
  `failed` + refund) — deliberately stricter than bg music's silent fallback,
  because a mute talking-host video is worthless.
- **Two coercion traps**, both regression-tested: `resolveSettings` MUST carry
  `voiceover` through its field-by-field rebuild (else executeRender's
  re-resolve ships a silent video / a settings PATCH erases the track), and
  `assertRenderSettingsAllowed` must NOT list voiceover as Pro-only (the
  render-time re-gate would 403 every Free auto-render AFTER the AI unit was
  spent).
- **Gallery**: seeded as the hand-authored `talking-host` platform template
  (Free, category "AI"); its thumbnail is rendered from the DEMO narration by
  `scripts/generate-thumbnails.mjs` and the slug is allow-listed in
  `THUMBNAIL_SLUGS`. A template-gallery project without a payload renders the
  DEMO silently (no voiceover in settings → no injection → no strict failure).

## AI background image (generative media)

`POST /api/projects/:id/ai-image { prompt }` generates an on-brand BACKGROUND
image and stamps it into the project's `compositionVars["ai.backgroundImage"]`
(a data URI, the SAME channel website→video uses for `capture.image`), so the
live preview + render pipeline need no new asset plumbing. The route lives in
`routes/projects.ts`; the live preview reflects it immediately and `POST /render`
bakes it in. This is Sorrel's first GENERATIVE-media feature (everything else is
deterministic template rendering).

- **OpenAI-only, off the AiProvider interface**: image generation is OpenAI's
  `gpt-image-1` (Anthropic has no image API), so it is a standalone
  `generateBrandImage()` in `lib/ai/src/imageGen.ts` — NOT a method on
  `AiProvider` — and runs regardless of `AI_PROVIDER` (which only picks the TEXT
  provider). Key: `IMAGE_API_KEY ?? OPENAI_API_KEY` (talking-host's
  `TTS_API_KEY ?? OPENAI_API_KEY` precedent). No key → the route 503s.
- **On-brand prompt**: `buildImagePrompt` (`lib/ai/src/prompt.ts`) grounds the
  user's brief in the DEFAULT Brand DNA (palette hex hints + `imageStyle` +
  industry/keywords/personality) and leads with hard guardrails — no text/logos,
  atmospheric, darker/low-contrast so light overlay copy stays readable. Aspect
  is derived from the project's render resolution → the closest gpt-image-1 size.
- **Gating**: NOT Pro-only — Free spends **1 AI unit** (`checkAndIncrementAiCount`
  AFTER a successful generation, the `/ai/suggest` precedent: a provider error
  never burns a unit), Pro unlimited. A separate `aiImageLimiter` (10/15min, the
  brandExtract tier — image gen is pricier/slower than text) bounds abuse.
- **Capability set**: only compositions that host the layer consume the var —
  `services/aiBackgroundTemplates.ts` (`AI_BACKGROUND_MODULES = {studio,
  brand-promo, social-teaser, product-launch, brand-story}`; the
  `transitionCapableTemplates.ts` pattern), surfaced as
  `Template.supportsAiBackground` (read-time enrichment in `routes/templates.ts`,
  never persisted) so the project dialog shows the "AI arka plan" control only
  where it works. Add a module + wire its composition to grow the set. The first
  four are single-scene copy templates (one `position:relative` `.scene`).
  `brand-story` is the TRANSITION-CAPABLE case: it carries the layer PER SCENE —
  each of its two `position:absolute` opaque-background scenes gets its own
  `.ai-bg-layer` at `z-index:-1` (above the scene's secondaryColor fill, below
  content). The shader bootstrap's scene collection
  (`querySelectorAll('.scene[id]')`) is unaffected (the layer is `.ai-bg-layer`,
  not `.scene[id]`); the per-scene image rides each scene's html2canvas snapshot,
  so it composites across the boundary, and in hard-cut mode the scene's
  `autoAlpha` toggle carries the layer with it.
- **Composition wiring**: a capable composition declares a full-bleed
  `<img class="ai-bg" src="{{ai.backgroundImage}}">` inside a `.ai-bg-layer` at
  `z-index:-1` (paints above the authored gradient, below content — no content
  z-index edits) + a readability scrim. **CRITICAL — the `.scene` MUST set
  `isolation: isolate`** (establish a stacking context): without it the
  `z-index:-1` layer paints BEHIND the scene's own opaque background and the AI
  image NEVER shows (the classic negative-z-behind-parent gotcha — render-proven,
  not caught by the HTML substitution tests; the v1/v2 wiring shipped this bug and
  the brand-story pass fixed all five). `STUDIO_FALLBACKS["ai.backgroundImage"]`
  (and the templates route's `PREVIEW_FALLBACKS`) default it to `""`, and
  `.ai-bg-layer:has(img[src=""]){display:none}` collapses the layer when unset —
  so a no-AI render is **byte-identical** to the authored gradient. Render smokes:
  `aiBackgroundRenderSmoke.test.ts` (single-scene studio) +
  `transitionsRenderSmoke.test.ts`'s AI-bg case (brand-story across the shader),
  both RENDER_SMOKE-gated, frame-grab the magenta fixture to prove it paints.
- **Security**: the new `ai.backgroundImage` key is added to
  `lib/compositionVars.ts` `URL_ATTRIBUTE_KEYS` as kind `"image"` (same
  `isSafeImageSrc` gate as `capture.image`: http(s) URL or a raster
  `data:image/*;base64,…`, no attribute-breakout chars) — server-produced today
  but user-overridable via the `?vars=` preview path, so it must be gated.

## Smart Trim (transcript-driven footage trim)

`POST /api/smart-trim { videoObjectPath, removeFillers?, removeSilences?,
silenceThresholdMs?, captions?, brandKitId? }` cleans up a user-uploaded raw
talking-head clip (inspired by `browser-use/video-use`):
`smartTrimService.createSmartTrimVideo` owner-checks + size-gates the source,
downloads it, extracts a mono 16k audio track, word-times it with `transcribeBuffer`
(the shared Whisper core), computes a keep-EDL, creates a `smart-trim` project, and
**auto-starts the render** via `startProjectRender`. The SPA page is `/smart-trim`
(`useSmartTrim`) and lands on `/projects?focus=<id>` where the normal 3s polling +
video dialog take over. It is the inverse of talking-host (footage→video, not
script→video).

- **The one direct-FFmpeg path**: this is the ONLY render that re-encodes an
  EXISTING video — every other module rasterizes HTML via `@hyperframes/producer`
  (ffmpeg is otherwise thumbnail-only). `services/videoTrimService.ts` (`trimVideo`)
  is a single ffmpeg pass: per-segment `trim`/`atrim` + a 30 ms `afade` at each join
  → `concat` → optional ASS caption burn (`buildAssSubtitles`, 2-word UPPERCASE) +
  `drawtext` watermark; re-encoded to a faststart mp4. Abortable — an aborted signal
  kills the child → `VideoTrimAbortedError`, which the render branch maps to the
  engine's `RenderCancelledError` (rollback to draft).
- **EDL is pure + safe**: `lib/smartTrimEdl.ts` (`computeKeepSegments`,
  `remapWordsToTrimmed`) is a dependency-free interval-subtract over the transcript
  — drops filler words (default `DEFAULT_FILLER_WORDS`: um/uh/er…, deliberately NOT
  "like"/"you know") + over-long silences (default >0.6s). Safe-by-construction:
  empty / all-filler / degenerate input keeps the WHOLE clip rather than emit a
  silence-only stub.
- **Render wiring with NO schema change**: `executeRender` branches on
  `module === "smart-trim"` → `runSmartTrimRender` (re-download the source with an
  ACL re-check, FFmpeg-trim to the EDL); the rest of the render LIFECYCLE (claim →
  quota → ledger → enqueue → worker → polling → thumbnail → cancel → refund →
  `work-*` cleanup) is shared VERBATIM. The keep-EDL rides
  `compositionVars["smarttrim.payload"]` (base64, like `host.payload`); the caption
  words reuse the existing `renderSettings.captions` field; the output is forced to
  `mp4`. `module` is a free string + the blobs are jsonb, so nothing migrates.
- **Gating** (like `/avatar/video`, NOT Pro-gated): Free spends **1 AI unit**
  charged AFTER transcription succeeds (a provider error never burns it); the
  auto-render consumes the render quota and degrades to a **draft** when exhausted.
  Burned captions are Pro and **dropped for Free at create time** — a Free caption
  request must not 403 the render-time gate AFTER the AI unit was spent and strand
  the just-paid draft. Watermark is the Free lever (`drawtext`, font-probe +
  fontconfig fallback). `smartTrimLimiter` (5 / 15 min) bounds the heavy
  download + encode.
- **Limits**: source ≤500 MB and ≤30 min (the mono-16k audio extract keeps Whisper
  under its 25 MB cap). No new env. There is NO gallery template — the module needs
  an upload, so it ships as a page, not a seeded composition.
- **Verified** by `lib/smartTrimEdl.test.ts` (EDL), `services/videoTrimService.test.ts`
  (ASS builder + the `smarttrim.payload` codec), and the `RENDER_SMOKE`-gated
  `services/videoTrimSmoke.test.ts` (real ffmpeg cuts a synthetic clip → a valid,
  shorter mp4 with both streams + burned captions).

## Billing

- Stripe is the source of truth; locally we cache subscription state in
  `stripe_subscriptions` (populated by webhook events
  `customer.subscription.{created,updated,deleted,resumed,paused,trial_will_end}`)
- `getUserPlan(stripeCustomerId)` reads `stripe_subscriptions` and returns
  `'pro'` if any row has `status IN ('active', 'trialing')`, else `'free'`
- The webhook URL must be registered manually in the Stripe Dashboard at
  `${APP_URL}/api/billing/webhook` and `STRIPE_WEBHOOK_SECRET` must be set
- **Webhook idempotency + ordering** (`webhookHandlers.ts`): Stripe delivery is
  at-least-once and unordered (retries up to 3 days), so the cache is guarded two
  ways. (1) Idempotency — each handled `event.id` is recorded in
  `processed_stripe_events`; a replay no-ops (route still 200s so Stripe stops
  retrying). (2) Monotonicity — `upsert/deleteSubscription` compare the incoming
  `event.created` against the row's stored `event_ts` watermark and **skip
  logically-older writes**, and `customer.subscription.deleted` is a **terminal
  tombstone** (`status = 'canceled'` + `deleted_at`, never overwritten) — so a
  late `deleted` can't be undone by an older `updated(active)` (revenue leak) and
  the inverse can't revoke a paying customer. `POST /billing/checkout` also
  pre-checks `getUserPlan` and 409s an already-Pro user (no duplicate charges).
- `applyBillingMigration()` runs on startup; it idempotently ensures billing
  columns on `users`, the `stripe_subscriptions` ordering columns
  (`event_ts`, `deleted_at`), and the `processed_stripe_events` table exist
  (`ADD COLUMN / CREATE TABLE IF NOT EXISTS`) — so a fresh boot self-heals. The
  `stripe_subscriptions` table itself still comes from Drizzle schema push
- `users.plan` and `users.stripeSubscriptionId` are reserved schema columns;
  never use them as the source of truth
- **Render-settings capability matrix**: the Free floor is `draft|standard` quality,
  `24|30` fps, ≤1080p (non-4k), **`mp4` OR `gif`** export, opaque, watermarked, ≤1
  transition. GIF is a deliberate Free-tier growth hook — small, shareable,
  watermark-friendly — encoded by the producer's two-pass palette (`gifLoop: 0` =
  infinite), and being opaque it joins mp4 on the non-alpha side (the `FREE_FORMATS`
  + `ALPHA_FORMATS` sets in `renderSettingsService`, replacing the old inline
  `format !== "mp4"` checks). Everything else (high quality, 60fps, any `-4k`
  resolution, webm/mov/png-sequence export, transparent background, watermark removal,
  >1 transition, **background audio**, **captions** — incl. the caption `style`
  preset) is Pro. **`voiceover` is deliberately NOT gated** (the talking-host flow
  that sets it already charges an AI unit at creation + the render quota; gating it
  here would 403 the auto-render AFTER the spend and strand a paid draft).
  `assertRenderSettingsAllowed` enforces this, reusing the
  existing `getUserPlan` + `403 { reason: "upgrade_required" }` pattern (byte-identical
  to the premium-template / quota rejections, so the same `UpgradeModal` fires). The
  gate runs at PATCH time AND again at render time (defense in depth — a user who
  downgrades must not render a previously-saved Pro config). **Transparency is coerced
  at one choke point**: `resolveSettings` forces `transparent → false` for any opaque
  format (mp4/gif), which also closed a latent bug where `transparent:true` +
  `format:"mp4"` passed the gate but threw in `toEngineConfig` at render time (the
  defensive throw remains, now unreachable by design).

## Render pipeline

- Endpoint: `POST /api/projects/:id/render` atomically claims the project
  (`UPDATE ... WHERE status <> 'rendering' RETURNING` — one winner, else 409),
  checks quota, enqueues, returns 202
- Trigger: `enqueueRender` in `lib/renderQueue.ts` — enqueues a BullMQ job when
  `REDIS_URL` is set, else runs `executeRender` inline (fire-and-forget)
- Worker + recovery: `startRenderWorker()` (in-process; no-op without Redis)
  consumes jobs; `recoverStuckRenders()` on boot resets orphaned `rendering` rows
- Service: `executeRender` in `services/renderService.ts` runs the Hyperframes
  producer (the work half) — EXCEPT for `module === "smart-trim"`, which branches
  to `runSmartTrimRender` (a direct-FFmpeg re-encode of an uploaded video; see
  **Smart Trim**) and shares the same finalize (thumbnail + ready + ledger)
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
  transitions? }`. Null → `DEFAULT_RENDER_SETTINGS` (standard / 30fps / mp4 / portrait /
  opaque / watermarked — `standard` is the crisp, Free-allowed default quality floor; was
  `draft`, bumped so default output is sale-quality without changing the Free/Pro gate). Edited via the
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
- **Watermark + transparency actually take effect** (they were gated/billed but no-ops
  before): when resolved `settings.watermark` is true (always true for Free — the
  monetization lever — removable on Pro), `injectWatermark()` burns a static, fixed
  bottom-right "Made with Sorrel" pill (`data-sorrel-watermark`) into the per-project
  `composition.html` just before `</body>`, AFTER template substitution so it's never
  escaped/substituted and always wins the stacking context. Transparency is
  **format-derived**: `settings.transparent` maps to an alpha-capable format (webm
  VP9-alpha / mov ProRes4444 / png-sequence RGBA) — the `transparent` flag itself is a
  no-op at the engine-config level by design. Engine constraint: alpha output and a
  resolution/DPR upscale are mutually exclusive (`resolveDeviceScaleFactor` throws), so a
  `transparent` render is emitted at the composition's authored resolution and a `-4k`
  preset is effectively ignored — the editor should disable 4K when transparent is on.
  NOTE: the watermark is burned only on the RENDER path, not the live-preview
  `GET /:id/composition` route (preview stays clean — intentional).
- **Shader transitions actually render (M8)** (they were billed-but-inert before —
  `RenderSettings.transitions` persisted and Pro-gated but nothing consumed it):
  `resolveSettings` now CONTENT-validates the array via `sanitizeTransitions`
  (shader ∈ `TRANSITION_SHADERS` — the 14 upstream `@hyperframes/shader-transitions`
  names + Sorrel's `fade-dissolve` CSS-crossfade entry; time/duration clamped; ease
  charset-checked; sorted; ≤20), and `prepareCompositionFor` injects, LAST in the
  injection order, the package's `dist/index.global.js` (inlined, ~250 KB,
  `window.HyperShader`) + a bootstrap that hands the composition's ROOT
  `window.__timelines` timeline to `HyperShader.init()` (mandatory — initless
  registration would clobber the root timeline), collects `.scene[id]` elements,
  snaps a single transition to the root's `data-scene-boundary` (start = boundary −
  duration/2), maps `fade-dissolve` by omitting `shader`, and reads
  `--sorrel-bg`/`--sorrel-accent` for shader colors. **Capability handshake**: a
  transition-capable composition declares ≥2 `class="scene"` elements + the
  boundary attr and branches its own HARD-CUT wiring on the substituted
  `{{sorrel.transitionsActive}}` var ("0" default → composition cuts; "1" → the
  bootstrap owns the boundary, falling back via `window.__sorrelWireHardCuts()` if
  its preconditions fail). `brand-story` is the first capable template;
  `services/transitionCapableTemplates.ts` is the code-side capability set, surfaced
  as `Template.supportsTransitions` (read-time enrichment, never persisted) so the
  render-settings form disables the picker elsewhere (the Studio create page passes
  `false` — its `studio`/`video-spotlight` modules are single-scene). Verified by
  the RENDER_SMOKE-gated `transitionsRenderSmoke.test.ts` (real Chrome+FFmpeg
  render + boundary frame extraction). Free keeps ≤1 transition (unchanged gate).
- **Caption style presets (Pro)**: `RenderCaptions.style?` ∈
  `classic|pill-karaoke|neon-accent|kinetic-slam` (Whisper word-timing →
  `RenderCaptions.words`). The overlay builder lives in its own pure module
  `lib/captionStyles.ts` (`buildCaptionOverlay(words, style?)`, testable apart from
  the ~1k-line renderService): `classic` is the byte-identical legacy overlay
  (pinned by a regression test) and the three presets are ported from upstream
  caption components — each renders under `[data-sorrel-captions]`, tweens on the
  ROOT `window.__timelines` timeline, emits the words via `<`-escaped
  `JSON.stringify` (user script is untrusted — no raw interpolation), and sizes in
  viewport units so portrait/landscape/square stay in sync. `sanitizeCaptions`
  keeps only the 3 non-`classic` values (`classic`/invalid/absent → the key is
  dropped, so legacy projects stay byte-identical); the caption Pro-gate is
  unchanged (the `style` preset rides the existing captions gate).
- **Cancel now genuinely aborts** an in-flight render (it was documented-but-false):
  `executeRender` creates an `AbortController`, passes `ac.signal` to `executeRenderJob`,
  and the progress callback polls `isCancelRequested(renderJobId)` → `ac.abort()`. The
  `RenderCancelledError` catch maps to project `draft` + `markCancelled` (not `failed`).
  Cancel does NOT refund the already-incremented quota (anti-abuse).
- **`render_jobs` boot migration + claim safety**: `applyRenderJobsMigration()` (idempotent
  `CREATE TABLE IF NOT EXISTS`, deliberately FK-free so a missing prod `db push` never
  hard-fails boot) runs alongside `applyBillingMigration()`; the ledger INSERT sits inside
  a try/catch that **releases the `rendering` claim and 503s** on failure (a failed ledger
  never strands a project). On the Redis path, a re-render fired while a prior job is still
  finishing throws `RenderAlreadyActiveError` → 409 instead of silently dropping the
  re-add (which would strand the project in `rendering`).
- **`render_jobs` ledger**: a per-attempt audit table (`lib/db/src/schema/render.ts`,
  row type `RenderJobRow`) distinct from the project's own `status`/`renderError`. One
  row per render attempt: `id` (uuid — doubles as a queue correlation id, so non-numeric
  on purpose), `projectId`, `userId`, `backend` (`inline|bullmq|lambda`), `externalId`,
  `status` (`queued|rendering|ready|failed|cancelled`), `progress`, `costCents`, `format`,
  `config` (a `RenderSettings` snapshot), `outputPath`, `error`, `cancelRequested`,
  timestamps. On failure the ledger's `error` keeps the **RAW** engine/ffmpeg
  message for operator diagnosis (it is operator-only — `withRenderProgress` never
  surfaces it to the client), while the project's `renderError` carries the SHORT,
  classified guidance the UI shows verbatim (`renderFailureMessage` maps OOM /
  capture-timeout / headless-Chrome-death / disk-full symptoms to a "render
  something smaller" message, everything else to a generic try-again). CRUD +
  lifecycle setters live in `services/renderJobsService.ts`;
  `recoverStuckRenders()` now reconciles orphaned `render_jobs` rows alongside stuck
  projects, and `truncateAll()` clears the table.
- **Render disk hygiene (the ENOSPC fix)**: the producer captures every frame to a
  per-render scratch dir `renders/<id>/work-<jobId>-<hash>/` and encodes from there.
  Those frames are the biggest disk consumer (a 38 s 1080p render ≈ 1100+ PNGs ≈ GBs).
  Two layers keep the Railway `/data` volume from filling → `No space left on device`:
  (1) `lib/renderDiskCleanup.ts` deletes `work-*` dirs in executeRender's `finally`
  (success/failure/cancel) and sweeps orphans across all projects on boot
  (`reclaimOrphanRenderDisk`, called in `index.ts` BEFORE `startRenderWorker()` so a
  live render isn't swept) — this fixes the BETWEEN-render leak and self-heals a full
  volume on deploy (deleting needs no free space). It matches ONLY the `work-` prefix,
  so served artifacts (`output.<ext>`, png `frames/`, `composition.html`, `thumb.png`,
  `voice.mp3`) are safe. (2) **Streaming encode** (`PRODUCER_ENABLE_STREAMING_ENCODE=true`,
  baked into the Dockerfile) pipes frames straight to the encoder instead of holding the
  WHOLE set on disk first, capping a SINGLE render's peak scratch to ~the output size —
  cleanup alone can't help mid-render, and a single 1080p clip's frames can overflow a
  small volume on their own. The engine gates streaming to mp4/webm/mov + `RENDER_WORKERS=1`
  (the small-box setting; our `DEFAULT_RENDER_WORKERS` is 2, so the env must be 1 for it to
  engage) + duration ≤ `PRODUCER_STREAMING_ENCODE_MAX_DURATION_SECONDS` (240 s); other
  renders fall back to the disk path unchanged (verified: streaming render serves a valid
  MP4 via the RENDER_SMOKE smoke).
- **Hyperframes API (verified against 0.6.91)**: producer `RenderConfig.fps` is an exact
  rational `{ num, den }` (NOT an enum); `format` ∈ `mp4|webm|mov|png-sequence` (webm/mov/
  png-sequence carry true alpha); `executeRenderJob(job, dir, out, onProgress?, abortSignal?)`
  accepts an `AbortSignal` and throws `RenderCancelledError` on cancel (treated as a
  rollback-to-draft, not a failure). Resolution presets mirror core's `CANVAS_DIMENSIONS`
  (the 6 named presets above); dimensions are composition-authored, with
  `RenderConfig.outputResolution` (a `CanvasResolution`) as the override. 0.6.91 also
  adds optional `RenderConfig` fields we don't expose yet — `format: "gif"` + `gifLoop`,
  `crf`/`videoBitrate` overrides, `hdrMode` — adopt deliberately, not by accident.
- **Engine version pinning**: `@hyperframes/core`/`producer` (api-server) and
  `@hyperframes/player` (sorrel) are pinned EXACT (`0.6.91`, no caret) and must move in
  lockstep with `patches/@hyperframes__producer@<version>.patch` (a pnpm patch keyed by
  exact version) and the local `core/dist` runtime copy. The patch carries TWO fixes:
  (1) an ffmpeg `-threads` cap via `PRODUCER_FFMPEG_THREADS` (still absent upstream at
  0.6.91), inserted after BOTH `args.push("-c:v", encoderName, "-preset", preset);`
  anchors; (2) an ESM `__dirname`/`__filename` shim at the top of `dist/index.js` —
  the 0.6.81+ font-embedding inlines emscripten/wawoff2 which reads `__dirname` at
  module init, crashing EVERY plain Node-ESM import (vitest, smoke-render, tsx dev);
  upstream shipped a `require` shim but forgot `__dirname` (works on bun / in CJS
  bundles, so they don't see it). Bump procedure: update pins → temporarily empty
  `pnpm.patchedDependencies` → `pnpm install` → `pnpm patch @hyperframes/producer@<v>`
  → re-apply both fixes in the session dir → `pnpm patch-commit` (expect
  `grep -c PRODUCER_FFMPEG_THREADS dist/index.js` == 2 and
  `node --input-type=module -e "import('@hyperframes/producer')"` to succeed) →
  refresh `core/dist` → run smoke:render + verify-beginframe + verify-registry-renders.
  `@hyperframes/*` is excluded from pnpm's `minimumReleaseAge` quarantine
  (`pnpm-workspace.yaml`) because exact pins make the 1-day delay pure friction.

## Known gotchas

- Run `pnpm --filter @workspace/db run push` after every schema change before
  restarting the API server. **Outstanding pushes from recent work**: the
  `IDX_session_user` session index, the `stripe_subscriptions` ordering columns +
  `processed_stripe_events` table, the four tenant **cascade FKs**
  (`projects.userId`, `brand_kit.userId`, `render_jobs.userId`+`projectId`), and
  the **multi-kit + DNA brand schema** (`brand_kit` `name`/`is_default`/
  `source_url` + the DNA columns `tagline`/`description`/`value_proposition`/
  `target_audience`/`industry`/`keywords`/`personality`/`image_style`, drop
  `UQ_brand_kit_user`, add `UQ_brand_kit_default` partial-unique + the
  `IDX_brand_kit_user` index, `projects.brand_kit_id`). Boot migrations self-heal
  the billing/render_jobs tables AND the multi-kit + DNA brand schema
  (`applyBrandKitMigration`, which also back-fills one default per user), but the
  tenant FKs exist only via `db push`. **The FK push FAILS on prod if orphan rows
  already exist** (a tenant row whose parent was deleted) — clean those up first,
  then push.
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
  copy (verified against 0.6.91) instead of importing it
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
- **A client upload MUST be FINALIZED before its path is used.** The 2-phase flow
  is `request-url` → client PUT → **`PUT /storage/uploads/finalize`**, and ONLY
  finalize stamps the `owner` ACL. `canAccessObject` fails CLOSED on an object with
  no ACL — so an un-finalized object is silently dropped at render
  (`resolveBackgroundAudioTag` renders silent) or 404s (`transcribeObject`). The
  web `useUpload` hook does request-url + PUT but NOT finalize; callers must invoke
  `useFinalizeUpload` after it (smart-trim's `/smart-trim` page and
  `render-settings-form`'s background-audio + caption uploaders do — a missing
  finalize was a real bug, fixed in #168). Server-side `uploadPrivateObject`
  (talking-host TTS) stamps the ACL itself, so it needs no finalize.

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

**Deploy — Railway native GitHub integration (single path).** The app runs on
Railway (project `mellow-gratitude`, service `@workspace/api-server`,
`production` env) and deploys **automatically on push to `main`** via Railway's
native GitHub integration (Settings → Deploy from repo): Railway builds the
Dockerfile + releases. Public URL: `workspaceapi-server-production-5961.up.railway.app`.
There is **no GitHub Actions deploy workflow** — it was removed (it was a broken,
redundant second deployer; CI-driving deploys would double-fire alongside the
native integration). To restore a CI-driven deploy instead, disable native
auto-deploy first and re-add a workflow (see git history / DEPLOYMENT.md §12).
The release SHA for Sentry comes from Railway's built-in `RAILWAY_GIT_COMMIT_SHA`
(backend reads it directly; the Dockerfile defaults the `VITE_GIT_SHA` build ARG
from it for the SPA) — no CI step needed.

**Observability**:

- **Sentry** (`@sentry/node` + `@sentry/react`) — error tracking;
  release tag pinned to the deploy commit's `GIT_SHA` (backend) /
  `VITE_GIT_SHA` (frontend). `beforeSend` scrubs password / token fields
  from request bodies. No-op when the DSN is unset so local dev stays
  clean. The **frontend DSN is build-time**: Vite inlines
  `import.meta.env.VITE_SENTRY_DSN` when the SPA is bundled inside the
  Docker image, so the Dockerfile declares `VITE_SENTRY_DSN` /
  `VITE_SENTRY_TRACES_SAMPLE_RATE` / `VITE_GIT_SHA` as build `ARG`s and
  Railway forwards the matching service variables into the build.
- **Logs** — structured JSON via Pino straight to **stdout** (Railway
  captures it). `lib/logger.ts` reads only `LOG_LEVEL`; there is **no
  in-process Logtail transport** and no `LOGTAIL_SOURCE_TOKEN`. To ship
  logs to Better Stack / Logtail, attach a Railway native **log drain**
  (Project → Settings → Log drains) — this avoids the fragile
  worker-thread bundling a Pino transport needs under esbuild.

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
2. **Legal pages**: static `/terms` + `/privacy` routes (outside
   `ProtectedRoute`) + a localStorage cookie-consent banner have **landed**, but
   the copy is **DRAFT** — review with counsel before public launch. (Stripe +
   any EU user makes published, accurate policies mandatory.)
3. **End-to-end test coverage** (mostly landed): an HTTP E2E suite (supertest vs
   the real Express app + testcontainer Postgres) covers the critical journeys —
   auth, projects, multi-tenant isolation, render-settings gating, avatar
   endpoints (`api-server/src/test/e2e.integration.test.ts`); plus a hermetic
   Playwright browser smoke (`artifacts/sorrel/e2e`, `/api` mocked) for the shipped
   SPA booting + the signup UX in real Chromium (`pnpm --filter @workspace/sorrel
   run e2e`); plus a FULL-STACK render smoke
   (`api-server/src/test/e2eRenderSmoke.integration.test.ts`): signup → create →
   POST /render → the REAL inline pipeline (Chrome BeginFrame + FFmpeg) →
   poll-to-ready → the video route serves an ffprobe-valid MP4 (incl. a Range
   request, exercising `lib/httpRange`). RENDER_SMOKE=1-gated (a real render is
   1–3 min + needs the toolchain); it self-resolves chrome-headless-shell from the
   puppeteer cache + materializes `core/dist`, so `RENDER_SMOKE=1 pnpm exec vitest
   run artifacts/api-server/src/test/e2eRenderSmoke.integration.test.ts` is
   self-contained where deps + Docker + ffmpeg are present (validated locally:
   ~92s render → served MP4). **Still pending**: wiring it into CI (install the
   render toolchain on the Linux runner + run the gated job) so it gates `main`.
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
9. **Distributed render backend (M11)** — **code-side landed**:
   `@hyperframes/aws-lambda@0.6.91` is now an api-server `dependency`, so
   `lambdaBackend.ts` compiles against the REAL SDK types (the ambient
   `hyperframes-aws-lambda.d.ts` is deleted) and `RENDER_BACKEND=lambda` is
   genuinely loadable. dispatch materializes the project dir via
   `prepareCompositionFor` (sibling assets/voiceover included — the old
   html-string dropped them), builds + `validateDistributedRenderConfig`s a
   `SerializableDistributedRenderConfig`, guards gif (not a distributed format),
   and calls the real `renderToLambda({ projectDir, config, bucketName,
   stateMachineArn, region, executionName })`; reconcile reads the typed
   `RenderProgress` (`SUCCEEDED/FAILED/…` union, `costs.accruedSoFarUsd`→cents,
   `errors: RenderError[]`). New env: **`HYPERFRAMES_STATE_MACHINE_ARN`** (the
   `RenderStateMachineArn` CfnOutput) — `lambdaEnvReady`/dispatch now require it
   alongside `AWS_REGION` + `HYPERFRAMES_S3_BUCKET`. The aws-lambda package is
   `external` in `build.mjs` (its `@sparticuz/chromium`/ffmpeg-static natives
   never enter the bundle; loaded via a dynamic import behind the lambda gate),
   and a loadability test pins the SDK surface. infra's CDK pin is aligned to
   `0.6.91` and the stack's prop usage spot-checks against the installed
   `./cdk` types (`HyperframesRenderStackProps`: `reservedConcurrency`,
   `chromeSource`). STILL PENDING: (a) adding `infra/` to `pnpm-workspace.yaml`
   — it triggers a pnpm rename bug on THIS Windows worktree (long+spaced path);
   do it on Linux/CI so `pnpm --filter @workspace/infra run build` tsc-checks the
   CDK stack; (b) a real cloud deploy. The container-based upstream
   **`@hyperframes/gcp-cloud-run`** (0.6.79+, Terraform + Cloud Workflows, no
   250MB Lambda zip ceiling) is the alternative to evaluate before any deploy —
   it suits Sorrel's container model better than the Lambda zip.
10. **Dependency security — residual dev-only `vitest` advisory**: `pnpm audit`
    is clean for production (`pnpm audit --prod` → no vulnerabilities). Transitive
    prod vulns (`qs` DoS, `uuid` bounds-check) and most dev ones (`undici`, `tmp`,
    `vite`, `esbuild`) are pinned to patched versions via `pnpm.overrides`, using
    scoped `pkg@<bad-range>: ^patched` selectors so non-vulnerable instances (e.g.
    the frontend's own Vite/esbuild) are left untouched. After each override the
    full workspace (`pnpm build` + `pnpm test`, all 4 projects) is re-verified.
    One advisory remains: `vitest <4.1.0` (GHSA-5xrq-8626-4rwp — arbitrary file
    read **when the Vitest UI server is listening**). It is **dev-only and
    non-exploitable here**: we only ever run `vitest run` headless; the UI server
    is never started, and vitest never ships. The fix is a `vitest`/`@vitest/
    coverage-v8` 2→4 major bump — a real migration (v4 removes the root
    `vitest.workspace.ts` / `defineWorkspace` form; it must move to `test.projects`
    in a root `vitest.config.ts`). Deferred to a focused change that compares the
    4-project test **count** (not just green) before/after, since a botched
    migration can silently skip whole projects.
    - **`eslint-plugin-react-hooks` 5 → 7 (DONE — React Compiler lint rules adopted).**
      v7 moves four React-Compiler rules (`set-state-in-effect`, `purity`,
      `immutability`, `refs`) into the `recommended` preset our `eslint.config.mjs`
      spreads, turning them on at `error` and surfacing **11 real anti-patterns**.
      All fixed behaviorally (NO `eslint-disable`, NO rule-off config): browser-state
      mirrors → `useSyncExternalStore` (`hooks/use-mobile`, `components/ui/carousel`
      can-scroll flags); the cookie-consent + mockup-sandbox `App` preview resets →
      lazy `useState` init / a `key`-remounted child instead of synchronous
      setState-in-effect; `lib/auth-web/use-auth` mount kickoff deferred to a
      microtask so `refresh()`'s eager `setIsLoading(true)` isn't a sync
      setState-in-effect; `SidebarMenuSkeleton`'s `Math.random` width moved from
      `useMemo` (render-phase, flagged) to a lazy `useState` initializer (not
      flagged); `layout` CommandPalette `window.location.href =` → `.assign()`
      (method call, not a mutation of the global). Verified: lint + typecheck +
      test + build all green.
11. **Website→Video — AI section mode + interactive crop UI** (backend mostly
    landed): four "which section to feature" modes ship today — whole page,
    drag-selected region (the `/website-to-video/preview` two-step flow),
    `section:"hero"`, and CSS `selector` — all reducing to `capture.crop*` (see
    **Website → Video**). Still to build: (a) the **AI/text mode** —
    `captureWebsite({ extractSections })` already returns candidate `sections`
    (label + crop); add a `lib/ai` `pickSection(description, sections)` method on
    `AiProvider` (anthropic + openai impls + a tiny schema) that the service calls
    (gate with `checkAndIncrementAiCount`) to map a natural-language prompt → a
    section's crop; expose it as `aiPrompt` on `WebsiteToVideoRequest`. (b) The
    **interactive SPA**: a section-mode picker on `pages/website-to-video.tsx` + a
    drag-select crop overlay component (consumes the preview's `image`/`width`/
    `height`) + selector / AI-text inputs, wired through the generated
    `useWebsiteToVideoPreview` + `useWebsiteToVideo` hooks.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Pointers

- `engineering:architecture` skill for ADR-style writeups when introducing a
  new module or replacing a major dependency
- `engineering:code-review` skill before merging anything that touches billing
  or auth
