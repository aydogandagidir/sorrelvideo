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
COPY artifacts/mockup-sandbox/package.json artifacts/mockup-sandbox/
COPY lib/db/package.json lib/db/
COPY lib/api-spec/package.json lib/api-spec/
COPY lib/api-zod/package.json lib/api-zod/
COPY lib/api-client-react/package.json lib/api-client-react/
COPY lib/auth-web/package.json lib/auth-web/
COPY lib/object-storage-web/package.json lib/object-storage-web/
COPY lib/ai/package.json lib/ai/
COPY scripts/package.json scripts/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

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
# Typecheck everything, but only build what ships: the api-server bundle and
# the sorrel SPA. mockup-sandbox is a dev-only Hyperframes playground and is
# not deployed.
RUN pnpm run typecheck \
    && pnpm --filter @workspace/api-server --filter @workspace/sorrel run build

# ---------- Stage 4: runtime ----------
# Slim image with Chromium system deps + production node_modules. Puppeteer's
# cached Chromium binary travels along with node_modules so the renderer can
# start without re-downloading at boot.
FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    BASE_PATH=/ \
    PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH"

# Chromium runtime libraries (https://pptr.dev/troubleshooting#chrome-doesnt-launch-on-linux).
RUN apt-get update && apt-get install -y --no-install-recommends \
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

# Copy the entire monorepo node_modules layout — workspace symlinks need the
# full pnpm store layout for `@workspace/*` to resolve. This keeps the bundle
# small enough to start while leaving heavy native modules in place.
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/pnpm-lock.yaml ./pnpm-lock.yaml

# api-server bundle + composition templates (loaded at render time).
COPY --from=build /repo/artifacts/api-server/dist ./dist
COPY --from=build /repo/artifacts/api-server/src/compositions ./compositions
COPY --from=build /repo/artifacts/api-server/package.json ./package.json.app
COPY --from=build /repo/artifacts/api-server/node_modules ./artifacts/api-server/node_modules

# Frontend bundle — served by api-server's express.static under /public.
COPY --from=build /repo/artifacts/sorrel/dist/public ./public

# Puppeteer cache: install puts Chromium under /root/.cache/puppeteer when run
# at the workspace root. Carry it over so the runtime container doesn't need a
# Chromium download at boot.
COPY --from=build /root/.cache/puppeteer /root/.cache/puppeteer

EXPOSE 8080

# Health: Railway will poll /api/healthz (configured in railway.json).
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
