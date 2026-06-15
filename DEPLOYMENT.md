# Deployment — Sorrel on Railway

Step-by-step from a green `main` to a live `https://<your-domain>` that
takes signups, charges customers, renders videos, and generates AI copy.
The repo is **deploy-ready** as of Tur 9; everything in this doc is
account / dashboard setup that lives outside the code.

Aim for roughly 2-3 hours end-to-end the first time. Subsequent deploys
are automatic via GitHub Actions.

## 0. Prerequisites

- A GitHub account and push access to this repo.
- A [Railway](https://railway.com) account (Hobby plan, $5 credit/mo is
  enough for soft launch).
- A domain you control (Cloudflare / Namecheap / Vercel DNS / Route53 —
  any registrar that lets you set CNAMEs).
- A working credit card on Stripe.

## 1. Railway: project + Postgres

1. Sign in to Railway and **New Project → Deploy from GitHub repo**.
   Pick `aydogandagidir/sorrelvideo` and the `main` branch.
2. Railway will detect `Dockerfile` + `railway.json` and start its first
   build — it will fail until env vars + DB are configured. That's fine.
3. In the same project, **+ New → Database → Postgres**. Railway provisions
   it and exposes `DATABASE_URL` automatically inside the project.
4. In the api service settings, **Variables → Reference**: link
   `DATABASE_URL` from the Postgres service.
5. Add a **Volume** to the api service mounted at **`/data`** (5 GB is plenty
   for soft launch) and set env **`RENDERS_DIR=/data/renders`** AND
   **`STUDIO_WORKSPACE_DIR=/data/studio-workspaces`**. Both persist user output
   across deploys: `RENDERS_DIR` the rendered mp4s, `STUDIO_WORKSPACE_DIR` the
   compositions authored in the embedded Studio editor. (The app otherwise writes
   them next to the bundle at `/app/renders` and `/app/studio-workspaces`, which
   are ephemeral — every deploy auto-ships, so an unset `STUDIO_WORKSPACE_DIR`
   silently wipes Studio content and re-seeds the blank template, looking like
   data loss.)
6. (Recommended for production) **+ New → Database → Redis**. In the api service
   **Variables → Reference**: link `REDIS_URL` from the Redis service. This moves
   renders onto a durable BullMQ queue + in-process worker that survives restarts.
   Without it the app still works — renders run inline and a pod restart
   mid-render marks that project `failed` (auto-recovered on boot).

## 2. Stripe — products + webhook

1. [Stripe Dashboard](https://dashboard.stripe.com) → **Products** →
   create "Sorrel Pro" with a monthly price (test mode is fine for
   soft launch). Note the price ID (`price_…`).
2. [Developers → API keys](https://dashboard.stripe.com/apikeys). Copy
   `STRIPE_SECRET_KEY` (sk*…) and `STRIPE_PUBLISHABLE_KEY` (pk*…).
3. **Developers → Webhooks → Add endpoint**. URL:
   `https://<your-domain>/api/billing/webhook`. (You'll get the domain
   after step 8 — circle back to fill this in.)
   Events: `customer.subscription.created`, `.updated`, `.deleted`,
   `.resumed`, `.paused`, `.trial_will_end`.
4. Copy the **Signing secret** → that's `STRIPE_WEBHOOK_SECRET`.

## 3. Resend — transactional email

1. [Resend Dashboard](https://resend.com/domains) → **Add domain** with
   the domain you'll send from.
2. Add the DNS records Resend lists (SPF + DKIM, typically 3 TXTs).
   Wait for verification — usually a few minutes.
3. **API Keys** → create one with "Full access". That's
   `RESEND_API_KEY`.
4. Set `EMAIL_FROM` to e.g. `Sorrel <noreply@your-domain>`.

## 4. Google Cloud Storage — render uploads + brand assets

1. [GCP Console](https://console.cloud.google.com) → create a project (or
   reuse one). Note the project ID → `GCS_PROJECT_ID`.
2. **Storage → Buckets**: create two buckets, e.g.
   `sorrel-public` (publicly readable for finished thumbnails) and
   `sorrel-private` (private, for in-progress assets).
3. **IAM → Service Accounts** → create `sorrel-storage` with role
   "Storage Object Admin" on both buckets.
4. **Keys → Add key → JSON**. Download the file. Base64 encode it:
   ```bash
   base64 -i sorrel-storage.json | tr -d '\n'
   ```
   That string is `GCS_SERVICE_ACCOUNT_KEY`.
5. Set the bucket env vars: `PUBLIC_OBJECT_SEARCH_PATHS=/sorrel-public`,
   `PRIVATE_OBJECT_DIR=/sorrel-private/uploads`.

## 5. Sentry — error tracking

1. [Sentry](https://sentry.io) → **Projects → Create**. Make one
   `node-express` project (for the API) and one `react` project (for the
   frontend).
2. Copy the DSNs → `SENTRY_DSN` (api) and `VITE_SENTRY_DSN` (frontend).
3. Optional: install the Sentry GitHub integration for release tracking.

> **Frontend DSN is a build-time var.** The SPA is bundled _inside the Docker
> image_, and Vite inlines `import.meta.env.VITE_SENTRY_DSN` at build time. The
> Dockerfile declares it (plus `VITE_SENTRY_TRACES_SAMPLE_RATE` and
> `VITE_GIT_SHA`) as `ARG`s, and Railway automatically forwards matching
> **service variables** into the Docker build. So setting `VITE_SENTRY_DSN` in
> the Railway Variables tab (step 8) is enough — but a value pasted there only
> takes effect on the **next build/deploy**, not a plain restart. If you leave
> it blank the browser Sentry SDK silently no-ops and you get no frontend error
> tracking. (`VITE_GIT_SHA` is set for you by `deploy.yml`; see step 12.)

## 6. Logs → Better Stack (Logtail) via a Railway log drain

The app writes structured JSON (Pino) to **stdout**; Railway captures it and
shows it under **Deployments → Logs**. There is **no in-process Logtail
transport** and **no `LOGTAIL_SOURCE_TOKEN` env var** — shipping logs off Railway
is done with a native **log drain**, which avoids the fragile worker-thread
bundling a Pino transport needs under esbuild.

1. [Better Stack](https://betterstack.com) → **Telemetry → Sources →
   Connect source → HTTP** (or "Railway" if listed). Name it `sorrel-api`.
   Copy the source's **ingesting host + token / drain URL**.
2. Railway → your project → **Settings → Log drains → Add** and paste that
   HTTP drain endpoint. Railway streams all stdout logs there — no app change
   and no redeploy needed.
3. (Optional) add a Better Stack **Heartbeats** monitor pinging
   `/api/healthz` every 1 minute so you get an alert if Railway falls over.

## 7. (Optional) OAuth providers

Skip if you only want email/password sign-in.

**GitHub**: Settings → Developer settings → OAuth Apps → New.
Authorization callback: `https://<your-domain>/api/auth/oauth/github/callback`.
Copy `GITHUB_OAUTH_CLIENT_ID` + `GITHUB_OAUTH_CLIENT_SECRET`.

**Google**: GCP Console → APIs & Services → OAuth consent screen + Web
client. Callback: `https://<your-domain>/api/auth/oauth/google/callback`.
Copy `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET`.

## 8. Railway: paste env vars + deploy

In the api service **Variables** tab, paste everything from
`.env.production.example` with the real values gathered above. Required
minimum:

- `DATABASE_URL` (auto-linked from step 1)
- `SESSION_SECRET` — generate with `openssl rand -hex 32`
- `PORT=8080`, `BASE_PATH=/`
- `ALLOWED_ORIGINS=https://<your-domain>`
- `APP_URL=https://<your-domain>`
- `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`
- `RESEND_API_KEY`, `EMAIL_FROM`
- `GCS_SERVICE_ACCOUNT_KEY`, `GCS_PROJECT_ID`,
  `PUBLIC_OBJECT_SEARCH_PATHS`, `PRIVATE_OBJECT_DIR`
- `SENTRY_DSN` (backend), `VITE_SENTRY_DSN` (frontend — **build-time**, see
  step 5; takes effect on the next build, not a restart)
- `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`)
- `REDIS_URL` (recommended — durable render queue; omit to render inline)

(Logs ship via a Railway **log drain**, not an env var — see step 6.
`VITE_GIT_SHA` is set automatically by `deploy.yml`; no need to paste it.)

Trigger a redeploy from the Railway UI. The build takes ~10 minutes the
first time (Chromium download dominates).

## 9. First schema push

The api auto-runs `applyBillingMigration` on boot (idempotent column
adds), but the full Drizzle schema needs a one-time push:

```bash
railway run --service api pnpm --filter @workspace/db run push
```

Re-run only after you've reviewed schema changes locally. Never wire this
into a deploy hook — accidental destructive migrations are real.

### Versioned migrations (forward path after the first push)

Schema history is tracked as committed SQL under `lib/db/drizzle/`:
`pnpm --filter @workspace/db run generate` writes a reviewed migration per
schema change; `... run migrate` applies them in order. `push`/`push-force`
ignore that dir (they diff the live DB directly), so the dev loop + tests are
unaffected. Migrations are MANUAL only (never on boot/CI — same caution as
`push`); the boot `apply*Migration()` idempotent self-heals are unchanged.

**ONE-TIME baseline stamping — required before the first `migrate`.** Prod's
schema already exists (built via the `push` above), so the baseline
`drizzle/0000_*.sql` must NOT be run — every bare `CREATE TABLE` would throw
`already exists`. Mark it applied instead:

1. Confirm prod matches the schema: run `drizzle-kit push` against prod and
   verify it proposes **no changes** (abort without confirming). If it proposes
   changes, prod has drifted — reconcile the schema first, then regenerate.
2. Stamp `0000` into the migrations ledger so `migrate` skips it:
   ```bash
   railway run --service api psql "$DATABASE_URL" -c \
     "CREATE SCHEMA IF NOT EXISTS drizzle;
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES ('<sha256 of drizzle/0000_*.sql>', <created_at from meta/_journal.json>);"
   ```
3. `railway run --service api pnpm --filter @workspace/db run migrate` → reports
   nothing to apply (0000 stamped). From now on `migrate` runs only `0001+`.

A long-lived LOCAL dev DB built via `push` is in the same boat — keep using
`push` (recommended; never run `migrate` locally) or drop+recreate it empty so
`migrate` applies `0000` cleanly from scratch.

## 10. Custom domain

1. Railway api service → **Settings → Domains → Custom domain**. Add
   `app.your-domain.com` (or root).
2. Copy the CNAME target Railway shows. Paste it into your DNS provider.
3. Wait for "Active". SSL is provisioned automatically.
4. Go back to **Stripe → Webhooks** and finalise the endpoint URL with
   the real domain.

## 11. Smoke test

In an incognito window:

1. `https://<your-domain>` → home loads.
2. Sign up with a real email. Check inbox for verification link.
3. Click the verification link → redirected to `/email-verified?status=ok`.
4. Studio → describe a video brief → "Fill with AI" → three fields
   populate.
5. "Create & render" → wait ~30 s → mp4 streams in the project view.
6. Upgrade to Pro via Stripe Checkout (test card `4242 4242 4242 4242`).
   Webhook fires; `stripe_subscriptions` row appears.

If any of these break:

- Railway → **Deployments → Logs** for stack traces.
- Sentry → first issue at the top.
- Better Stack → live tail of structured Pino logs.

## 12. Auto-deploy (Railway native GitHub integration)

Deploys are handled by **Railway's native GitHub integration** (set up in step 1,
"Deploy from GitHub repo"): every push to `main` triggers a Docker build +
release on Railway — nothing else to configure. The Sentry release tag is taken
from Railway's built-in `RAILWAY_GIT_COMMIT_SHA` (the backend reads it at runtime;
the Dockerfile defaults the `VITE_GIT_SHA` build ARG from it for the SPA), so no
CI step is needed to tag releases.

> There is **no GitHub Actions deploy workflow** — the old `.github/workflows/deploy.yml`
> was removed because it duplicated the native integration (and CI-driving
> `railway up` while native auto-deploy is on would double-fire). If you ever want
> CI to own deploys instead: **first** disable native auto-deploy on the
> `@workspace/api-server` service (Railway → service → Settings → "Deploy on
> push"), **then** add a workflow that runs `railway up --service "@workspace/api-server"`
> with a `RAILWAY_TOKEN` account-token secret (`gh secret set RAILWAY_TOKEN`). A
> known-good version is in git history.

## Rollback

```bash
railway rollback   # interactively pick a previous deploy
```

…or just revert the offending commit and push — CI + deploy ship the
revert.

## Things to set up before non-dev users land

- Statik **Terms of Service** + **Privacy Policy** sayfaları
  (Sorrel'in case'i için kullanıcı doldursun; Stripe + AB kullanıcı varsa
  yasal şart).
- Cookie banner (session cookie + Sentry cookies için).
- Rate limit'i in-memory'den Redis'e taşı (`rate-limit-redis`, mevcut
  `REDIS_URL`'i yeniden kullanır) — multi-instance scaling için.
- Render queue (BullMQ + Redis) hazır: `REDIS_URL` set edilince dayanıklı kuyruk
  + worker devreye girer (pod restart'ta render kaybını önler). Set edilmezse
  render satır içi çalışır.
- DB backup stratejisi — Railway Postgres Hobby plan günlük snapshot
  veriyor; production'da Pro plan + point-in-time recovery'ye geç.
