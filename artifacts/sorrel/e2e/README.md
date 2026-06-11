# Frontend E2E (Playwright)

A real-browser smoke of the shipped SPA running in Chromium through the real Vite
pipeline. It verifies the bundle boots + executes in a browser, client-side
routing, and the signup UX — the layer the HTTP E2E (supertest) can't cover.

`/api` is mocked at the network layer (`page.route`), so the smoke is hermetic:
no database, API server, or Docker required. The **real backend** is covered
end-to-end by the supertest integration tests in
[`artifacts/api-server/src/test/e2e.integration.test.ts`](../../api-server/src/test/e2e.integration.test.ts).

## Run

```bash
pnpm --filter @workspace/sorrel exec playwright install chromium  # one-time
pnpm --filter @workspace/sorrel run e2e
```

Playwright boots the Vite dev server itself (`webServer` in `playwright.config.ts`)
on port 5180, with the dev `/api` proxy pointed at a dead port so any unmocked
call fails fast.

## Not yet covered (follow-up)

A full-stack browser smoke that actually renders an MP4 (signup → Studio → render
→ video served) needs the backend + Postgres + the render toolchain
(chrome-headless-shell + ffmpeg) orchestrated, and is best run in CI (Linux
Docker) — local Windows Docker Desktop's named pipe isn't detected by
testcontainers outside the vitest runner.
