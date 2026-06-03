import { Router, type IRouter } from "express";
import {
  getBillingInfo,
  ensureStripeCustomer,
  getUserPlan,
} from "../services/billingService";
import { getUncachableStripeClient } from "../stripeClient";

const router: IRouter = Router();

/**
 * Fetches Pro Plan prices from Stripe, filtered to only the "Sorrel Pro" product.
 * Returns a stable list so the UI can display them without auth.
 */
async function getProPrices() {
  const stripe = await getUncachableStripeClient();

  // Search for prices scoped to the Sorrel Pro product by name + metadata.
  // Using products.search avoids iterating all account prices across pages.
  const products = await stripe.products.search({
    query: "name:'Sorrel Pro' AND active:'true'",
  });

  const proProduct = products.data.find(
    (p) => p.metadata?.["plan"] === "pro" || p.name === "Sorrel Pro",
  );

  if (!proProduct) return [];

  // Paginate prices for this product (handles accounts with many prices)
  const pricePages = await stripe.prices.list({
    product: proProduct.id,
    active: true,
    type: "recurring",
    limit: 100,
  });

  return pricePages.data.map((p) => ({
    id: p.id,
    unitAmount: p.unit_amount,
    currency: p.currency,
    interval: p.recurring?.interval ?? null,
    productName: proProduct.name,
  }));
}

// GET /api/billing/prices — public; lists Sorrel Pro prices only
// No auth required so the landing/pricing page works for logged-out visitors
router.get("/billing/prices", async (req, res): Promise<void> => {
  try {
    const prices = await getProPrices();
    res.json({ prices });
  } catch (err) {
    req.log?.warn({ err }, "Failed to fetch Stripe prices");
    res.json({ prices: [] });
  }
});

// GET /api/billing/me — current plan info
router.get("/billing/me", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const info = await getBillingInfo(req.user.id);
  res.json(info);
});

// POST /api/billing/checkout — create Stripe Checkout session, return URL
router.post("/billing/checkout", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const priceId = body["priceId"];
  if (!priceId || typeof priceId !== "string") {
    res.status(400).json({ error: "priceId is required" });
    return;
  }

  // Server-side allowlist: only allow Sorrel Pro prices
  let allowedPrices: string[];
  try {
    const prices = await getProPrices();
    allowedPrices = prices.map((p) => p.id);
  } catch (err) {
    req.log.error({ err }, "Could not verify Pro prices for allowlist");
    res.status(500).json({ error: "Billing service unavailable" });
    return;
  }

  if (!allowedPrices.includes(priceId)) {
    res.status(400).json({ error: "Invalid or unauthorized price" });
    return;
  }

  const customerId = await ensureStripeCustomer(
    req.user.id,
    req.user.email ?? null,
  );

  // Guard against duplicate subscriptions. An already-Pro user (or a
  // double-click / two open tabs) must not be able to buy a SECOND concurrent
  // subscription on the same customer — that bills them twice. Mirrors the
  // existing "already entitled" 403s elsewhere; we send the client to the
  // Customer Portal to manage the plan they already have.
  if ((await getUserPlan(customerId)) === "pro") {
    res.status(409).json({
      error: "You already have an active Pro subscription.",
      reason: "already_subscribed",
    });
    return;
  }

  const origin = process.env.APP_URL ?? `${req.protocol}://${req.get("host")}`;

  const stripe = await getUncachableStripeClient();
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    payment_method_types: ["card"],
    line_items: [{ price: priceId, quantity: 1 }],
    mode: "subscription",
    success_url: `${origin}/settings?upgraded=1`,
    cancel_url: `${origin}/pricing`,
  });

  res.json({ url: session.url });
});

// POST /api/billing/portal — create Stripe Customer Portal session, return URL
router.post("/billing/portal", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const info = await getBillingInfo(req.user.id);

  if (!info.stripeCustomerId) {
    res.status(400).json({ error: "No billing account found" });
    return;
  }

  const origin = process.env.APP_URL ?? `${req.protocol}://${req.get("host")}`;

  const stripe = await getUncachableStripeClient();
  const portalSession = await stripe.billingPortal.sessions.create({
    customer: info.stripeCustomerId,
    return_url: `${origin}/settings`,
  });

  res.json({ url: portalSession.url });
});

export default router;
