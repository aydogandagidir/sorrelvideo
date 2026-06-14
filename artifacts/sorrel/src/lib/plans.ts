/**
 * Plan feature lists for the public marketing surfaces (the Pricing page and the
 * landing page). Centralized here so the two surfaces can't drift from each other
 * — or, more importantly, from the actually-enforced capability matrix.
 *
 * These MUST stay accurate to what the backend enforces:
 *   - Render gate (`renderSettingsService`, api-server): the Free floor is up to
 *     **1080p** (non-4K), `mp4` + `gif`, 24/30 fps, opaque, watermarked, ≤1
 *     transition. **Pro** adds 4K, 60 fps, transparent backgrounds (WebM / ProRes
 *     MOV), PNG-sequence, captions, background audio, watermark removal, and
 *     multiple transitions.
 *   - Quotas (`billingService`): Free = 3 renders/mo + 10 AI drafts/mo; Pro is
 *     unlimited.
 *   - The in-app `UpgradeModal` (components/upgrade-modal.tsx) is the canonical
 *     in-product statement of the same matrix — keep these lists consistent with
 *     it.
 *
 * `plans.test.ts` pins the load-bearing claims (Free is 1080p + GIF, 4K is the Pro
 * differentiator, the real quotas, no unbacked "priority render queue") so the
 * marketing copy can never silently misstate the gate again.
 */

/** Free monthly render quota (mirrors billingService FREE_RENDER_LIMIT). */
export const FREE_RENDER_LIMIT = 3;
/** Free monthly AI-suggestion quota (mirrors billingService FREE_AI_LIMIT). */
export const FREE_AI_LIMIT = 10;

export const FREE_PLAN_FEATURES: readonly string[] = [
  `${FREE_RENDER_LIMIT} video renders per month`,
  `${FREE_AI_LIMIT} AI copy drafts per month`,
  "Up to 1080p (Full HD)",
  "MP4 + GIF export",
  "All standard templates",
  "Sorrel watermark",
  "Community support",
];

export const PRO_PLAN_FEATURES: readonly string[] = [
  "Unlimited renders",
  "Unlimited AI copy drafts",
  "Up to 4K (Ultra HD)",
  "No watermark",
  "Transparent backgrounds (WebM / ProRes MOV)",
  "Captions & background audio",
  "60 fps & multiple transitions",
  "All premium templates",
  "Priority support",
];
