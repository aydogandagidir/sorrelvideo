# syntax=docker/dockerfile:1.7

# ---------- Stage 1: base ----------
# Node 24 slim. Puppeteer needs a bunch of native libraries (fonts, libnss3,
# etc.) — we install them in the runtime stage rather than dragging them
# through every layer.
FROM node:24-slim AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    CI=true
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /repo

# ---------- Stage 2: deps ----------
# Install ALL dependencies (incl. dev) needed to type-check + build. Puppeteer
# downloads its Chromium binary into /pnpm/store during install — we keep that
# layer cacheable by copying the lockfile / workspace manifests first.
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY artifacts/api-server/package.json artifacts/api-server/
COPY artifacts/sorrel/package.json artifacts/sorrel/
COPY artifacts/studio-editor/package.json artifacts/studio-editor/
COPY artifacts/mockup-sandbox/package.json artifacts/mockup-sandbox/
COPY lib/db/package.json lib/db/
COPY lib/api-spec/package.json lib/api-spec/
COPY lib/api-zod/package.json lib/api-zod/
COPY lib/api-client-react/package.json lib/api-client-react/
COPY lib/auth-web/package.json lib/auth-web/
COPY lib/object-storage-web/package.json lib/object-storage-web/
COPY lib/ai/package.json lib/ai/
COPY scripts/package.json scripts/
# NOTE: no BuildKit `--mount=type=cache` here — Railway's Metal builder rejects
# cache mounts whose `id` lacks its per-service prefix ("missing the cacheKey
# prefix"). The pnpm store cache is only a build-speed optimization, so we drop
# it for a portable Dockerfile that builds on Railway, local Docker, and CI alike.
RUN pnpm install --frozen-lockfile

# ---------- Stage 3: build ----------
# Run typecheck (catches surprises before deploy) and build every package.
# Output:
#   artifacts/api-server/dist/index.mjs   (esbuild ESM bundle)
#   artifacts/sorrel/dist/public/         (Vite SPA assets)
FROM deps AS build
COPY . .
ENV NODE_ENV=production \
    BASE_PATH=/ \
    PORT=8080
# Frontend (Vite) Sentry config is BUILD-TIME: `import.meta.env.VITE_*` is
# inlined when the SPA is bundled, so these must be present here — not at
# container runtime. Declare them as ARGs (Railway injects matching service
# variables into the Dockerfile build automatically; locally pass them with
# `docker build --build-arg`) and promote to ENV so Vite picks them up. Unset
# → Vite inlines `undefined`, the browser Sentry SDK no-ops, and prod has no
# frontend error tracking. See DEPLOYMENT.md (Sentry) + .env.production.example.
ARG VITE_SENTRY_DSN=""
ARG VITE_SENTRY_TRACES_SAMPLE_RATE=""
# Railway injects RAILWAY_GIT_COMMIT_SHA into the build; default VITE_GIT_SHA to
# it so the SPA Sentry release is tagged under the native GitHub-integration
# deploy with no CI. An explicit --build-arg VITE_GIT_SHA still wins; if both are
# empty the build is byte-identical to before (Vite inlines undefined → no-op).
ARG RAILWAY_GIT_COMMIT_SHA=""
ARG VITE_GIT_SHA=""
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN \
    VITE_SENTRY_TRACES_SAMPLE_RATE=$VITE_SENTRY_TRACES_SAMPLE_RATE \
    VITE_GIT_SHA=${VITE_GIT_SHA:-$RAILWAY_GIT_COMMIT_SHA}
# Typecheck everything, but only build what ships: the api-server bundle, the
# sorrel SPA, and the embedded studio-editor (served at /editor/). mockup-sandbox
# is a dev-only Hyperframes playground and is not deployed.
RUN pnpm run typecheck \
    && pnpm --filter @workspace/api-server --filter @workspace/sorrel --filter @workspace/studio-editor run build

# The Hyperframes producer loads its core runtime + manifest from
# <cwd>/core/dist at render time. That folder isn't in git (it's a copy of the
# installed @hyperframes/core build output), so materialize it here from the
# package. -L dereferences the pnpm symlink.
RUN mkdir -p core \
    && cp -rL artifacts/api-server/node_modules/@hyperframes/core/dist core/dist

# The render engine needs Chrome's HeadlessExperimental.beginFrame (deterministic,
# frame-accurate capture). Debian's apt `chromium` is `--headless=new` and DROPPED
# that CDP domain, so the engine's probe rejects → it falls back to slow screenshot
# mode and renders TIME OUT (observed on Railway). chrome-headless-shell is the only
# headless build that still implements beginFrame; puppeteer@24.43.1 pins its
# revision (148.x — no drift).
#
# Why we unzip by hand instead of `puppeteer browsers install`: puppeteer's
# npm-postinstall (deps stage) DOWNLOADS the chrome-headless-shell zip into
# /root/.cache/puppeteer but FAILS to extract the executable here (Debian slim —
# only ABOUT + LICENSE land, the ~188 MB binary never extracts). The wrapper
# `install` then sees that stub folder, declares "already installed" and no-ops;
# `--path` isn't exposed by the wrapper and the low-level `@puppeteer/browsers`
# bin isn't on PATH. The downloaded .zip itself is intact (118 MB, verified), so
# we extract it ourselves into /opt/hf-cache — version-agnostic (glob), no
# network, none of puppeteer's cache-resolution guesswork. find+test fails the
# build LOUD here if the zip is ever absent (e.g. an upstream PUPPETEER_SKIP_-
# DOWNLOAD) instead of silently degrading to screenshot mode at runtime.
RUN set -eux; \
    apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/*; \
    ZIP="$(find /root/.cache/puppeteer/chrome-headless-shell -name '*chrome-headless-shell-linux64.zip' | head -n1)"; \
    test -n "$ZIP"; \
    mkdir -p /opt/hf-cache; \
    unzip -q -o "$ZIP" -d /opt/hf-cache; \
    SHELL_BIN="$(find /opt/hf-cache -type f -name chrome-headless-shell | head -n1)"; \
    test -n "$SHELL_BIN"; \
    chmod +x "$SHELL_BIN"; \
    echo "chrome-headless-shell extracted to: $SHELL_BIN"

# ---------- Stage 4: runtime ----------
# Slim image with Chromium system deps + production node_modules. Puppeteer's
# cached Chromium binary travels along with node_modules so the renderer can
# start without re-downloading at boot.
FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    BASE_PATH=/ \
    PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    # Two different Chrome needs, two different binaries:
    #  • website→video capture (full puppeteer, untrusted pages) → the system
    #    `chromium` installed below (sandboxed; no beginFrame needed).
    #  • the RENDER engine → chrome-headless-shell, set as
    #    PRODUCER_HEADLESS_SHELL_PATH *after* the cache copy below, because apt
    #    chromium (--headless=new) lacks HeadlessExperimental.beginFrame and the
    #    engine would silently fall back to slow screenshot mode.
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=true

# Chromium + its runtime libraries
# (https://pptr.dev/troubleshooting#chrome-doesnt-launch-on-linux).
RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        ffmpeg \
        ca-certificates \
        fonts-liberation \
        libasound2 \
        libatk-bridge2.0-0 \
        libatk1.0-0 \
        libc6 \
        libcairo2 \
        libcups2 \
        libdbus-1-3 \
        libdrm2 \
        libexpat1 \
        libfontconfig1 \
        libgbm1 \
        libglib2.0-0 \
        libgtk-3-0 \
        libnspr4 \
        libnss3 \
        libpango-1.0-0 \
        libx11-6 \
        libx11-xcb1 \
        libxcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxext6 \
        libxfixes3 \
        libxkbcommon0 \
        libxrandr2 \
        libxshmfence1 \
        wget \
        xdg-utils \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app

# chrome-headless-shell (beginFrame-capable) extracted in the build stage into
# /opt/hf-cache (unzipped from puppeteer's cached zip) → wire it to the render
# engine. find+symlink to a STABLE path avoids hardcoding the version-stamped dir
# (survives puppeteer bumps); the build fails loudly (test -n) if the binary is
# somehow absent — strictly better than today's silent runtime screenshot-fallback.
COPY --from=build /opt/hf-cache /opt/hf-cache
RUN set -eux; \
    SHELL_BIN="$(find /opt/hf-cache -type f -name chrome-headless-shell | head -n1)"; \
    test -n "$SHELL_BIN"; \
    chmod +x "$SHELL_BIN"; \
    ln -sf "$SHELL_BIN" /usr/local/bin/chrome-headless-shell
ENV PRODUCER_HEADLESS_SHELL_PATH=/usr/local/bin/chrome-headless-shell

# Preserve the EXACT monorepo layout so pnpm's relative symlinks keep working.
# The esbuild bundle externalizes native deps (@node-rs/argon2, puppeteer,
# @sentry/*, @google-cloud/*); at runtime Node resolves them from
# artifacts/api-server/node_modules -> ../../node_modules/.pnpm/... . Flattening
# the bundle to /app/dist broke that chain, so we keep the bundle at its
# original path: /app/artifacts/api-server/dist.
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/pnpm-lock.yaml ./pnpm-lock.yaml

# api-server bundle + its node_modules (symlinks into /app/node_modules/.pnpm)
# + composition templates (read at render time via the src/compositions probe).
COPY --from=build /repo/artifacts/api-server/dist ./artifacts/api-server/dist
COPY --from=build /repo/artifacts/api-server/node_modules ./artifacts/api-server/node_modules
COPY --from=build /repo/artifacts/api-server/package.json ./artifacts/api-server/package.json
COPY --from=build /repo/artifacts/api-server/src/compositions ./artifacts/api-server/src/compositions

# Frontend bundle — app.ts (in production) serves it via express.static from
# `<bundle dir>/../public` = /app/artifacts/api-server/public.
COPY --from=build /repo/artifacts/sorrel/dist/public ./artifacts/api-server/public
# Embedded @hyperframes/studio editor (M9) → express serves it at /editor/.
COPY --from=build /repo/artifacts/studio-editor/dist ./artifacts/api-server/public/editor

# Hyperframes core runtime (manifest + iife) materialized in the build stage.
# Producer resolves it at <cwd>/core/dist (cwd is /app).
COPY --from=build /repo/core ./core

EXPOSE 8080

# Health: Railway polls /api/healthz (configured in railway.json).
CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
