# Sorrel

Modular video production SaaS platform — create, render, and manage branded video content using the Hyperframes engine.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string, `SESSION_SECRET` — session signing key

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Auth: Replit Auth (OIDC/PKCE, openid-client v6)
- Video render: @hyperframes/producer + @hyperframes/core (Chrome BeginFrame API + FFmpeg)
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Frontend: React 19, Vite, Wouter, TanStack Query, Tailwind v4, Shadcn UI, Framer Motion

## Where things live

- `lib/db/src/schema/` — source of truth for DB schema (Drizzle)
- `lib/api-spec/openapi.yaml` — source of truth for all API contracts
- `lib/api-zod/src/generated/` — auto-generated Zod schemas (do not edit)
- `lib/api-client-react/src/generated/` — auto-generated React Query hooks (do not edit)
- `artifacts/api-server/src/routes/` — all Express route handlers
- `artifacts/api-server/src/services/renderService.ts` — Hyperframes render pipeline
- `artifacts/api-server/src/compositions/` — HTML composition files rendered to video
- `artifacts/api-server/renders/` — rendered mp4 output files (gitignored, keyed by project id)
- `artifacts/sorrel/src/pages/` — React page components
- `artifacts/sorrel/src/components/` — shared UI components

## Architecture decisions

- **Replit Auth only** — Clerk provisioning fails (missing userId) in task-agent contexts; openid-client v6 functional API used instead.
- **Hyperframes render is fire-and-forget** — `POST /api/projects/:id/render` immediately returns 202 with status=rendering; the job runs in background, polling (3s) updates the UI.
- **HTML compositions as templates** — Each template maps to a self-contained HTML file in `artifacts/api-server/src/compositions/`. The file is rendered by Chrome (via puppeteer/BeginFrame) → FFmpeg → mp4.
- **Videos served directly from Express** — `GET /api/projects/:id/video` streams the mp4 from `artifacts/api-server/renders/<id>/output.mp4`. No CDN yet.
- **Multi-tenant isolation** — All data rows are user-scoped (`userId`). Unauthenticated → 401, wrong user → 403, missing row → 404.

## Product

- **Projects**: Create video projects scoped to your account; each project maps to a module (Studio, AI, Bulk).
- **Render**: Hit "Render" on any project to produce an MP4 using a Hyperframes HTML composition. Status polls live (draft → rendering → ready/failed).
- **Watch**: Completed renders are streamable in-app via a video dialog.
- **Brand**: Per-user brand kit (colors, fonts, logo).
- **Templates**: Platform templates (visible to all) + user-scoped templates.
- **Modules**: Studio, Brand, AI, Bulk, Analytics, Collab.

## Gotchas

- `pnpm --filter @workspace/db run push` must be run after schema changes before the API server restarts.
- After editing `lib/api-spec/openapi.yaml`, run `pnpm --filter @workspace/api-spec run codegen` to regenerate hooks and Zod schemas.
- `@hyperframes/engine` ships TypeScript source that requires `dom`, `dom.iterable`, and `@webgpu/types` — these are added to api-server tsconfig. Do not remove them.
- Puppeteer (Chrome) is in `onlyBuiltDependencies` in pnpm-workspace.yaml — required for the Hyperframes render pipeline.
- CORS is permissive in dev (`origin: true`) and restricted to `REPLIT_DOMAINS` in production.
- Date serialization: use `JSON.parse(JSON.stringify(data))` before Zod parse in all routes (Drizzle returns Date objects).

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
