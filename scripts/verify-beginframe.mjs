#!/usr/bin/env node
/**
 * Probe whether the configured headless Chrome exposes the legacy
 * `HeadlessExperimental.beginFrame` CDP domain — the exact capability the
 * Hyperframes render engine needs for deterministic, frame-accurate capture.
 *
 * Background: Debian's apt `chromium` ships `--headless=new`, which DROPPED the
 * `HeadlessExperimental` domain. When the engine is pointed at it, its beginFrame
 * probe rejects and it silently falls back to slow screenshot mode → renders time
 * out (observed in Railway prod). `chrome-headless-shell` still implements it.
 *
 * Run INSIDE the runtime image (from /app/artifacts/api-server so `puppeteer`
 * resolves — it's the api-server's direct dep; `puppeteer-core` is only a
 * transitive dep and isn't symlinked into that node_modules under pnpm):
 *     node verify-beginframe.mjs
 * Exit 0 + "PASS" ⇒ beginframe capture engages. Exit 1 + "FAIL" ⇒ screenshot
 * fallback (the bug). Mirrors the engine's launch flags + its 2s probe race.
 */
import puppeteer from "puppeteer";

const exe =
  process.env.PRODUCER_HEADLESS_SHELL_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
if (!exe) {
  console.error("FAIL: neither PRODUCER_HEADLESS_SHELL_PATH nor PUPPETEER_EXECUTABLE_PATH is set");
  process.exit(1);
}
console.error(`[verify] launching: ${exe}`);

const browser = await puppeteer.launch({
  headless: true,
  executablePath: exe,
  // Mirror the engine's beginframe launch flags so we exercise the real path.
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--enable-begin-frame-control",
    "--run-all-compositor-stages-before-draw",
    "--disable-new-content-rendering-timeout",
  ],
});

try {
  console.error(`[verify] browser: ${await browser.version()}`);
  const page = await browser.newPage();
  const client = await page.createCDPSession();
  await client.send("HeadlessExperimental.enable"); // throws on --headless=new chromium
  const beginFrame = client.send("HeadlessExperimental.beginFrame", {
    frameTimeTicks: 0,
    interval: 33,
    noDisplayUpdates: true,
  });
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("beginFrame probe timed out after 2s")), 2000),
  );
  const res = await Promise.race([beginFrame, timeout]);
  console.error(`[verify] beginFrame OK: ${JSON.stringify(res)}`);
  console.log("PASS: HeadlessExperimental.beginFrame available — beginframe capture engages.");
  await browser.close();
  process.exit(0);
} catch (err) {
  await browser.close().catch(() => {});
  console.error(`[verify] beginFrame failed: ${err?.message ?? err}`);
  console.log("FAIL: beginFrame unavailable — engine would fall back to screenshot mode.");
  process.exit(1);
}
