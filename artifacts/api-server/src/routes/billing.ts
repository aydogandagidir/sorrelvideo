import { Router, type IRouter } from "express";
import { getBillingInfo, ensureStripeCustomer } from "../services/billingService";
import { getUncachableStripeClient } from "../stripeClient";

const router: IRouter = Router();

/**
 * Fetches Pro Plan prices from Stripe, filtered to only the "Sorrel Pro" product.
 * Returns a stable list so the UI can display them without auth.
 */
async function getProPrices() {
  const stripe = await getUncachableStripeClient();
  const prices = await stripe.prices.list({
    active: true,
    expand: ["data.product"],
  });

  return prices.data
    .filter((p) => {
      if (p.type !== "recurring") return false;
      const product = p.product as any;
      // Only expose prices belonging to the Sorrel Pro product
      return (
        product &&
        typeof product === "object" &&
        (product.metadata?.plan === "pro" ||
          product.name === "Sorrel Pro")
      );
    })
    .map((p) => ({
      id: p.id,
      unitAmount: p.unit_amount,
      currency: p.currency,
      interval: (p.recurring?.interval) ?? null,
      productName:
        typeof p.product === "object" && p.product !== null && "name" in p.product
          ? (p.product as any).name
          : null,
    }));
}

// GET /api/billing/prices — public; lists Sorrel Pro prices only
// Auth not required so the landing/pricing page can show prices to visitors
router.get("/billing/prices", async (req, res): Promise<void> => {
  try {
    const prices = await getProPrices();
    res.json({ prices });
  } catch (err: any) {
    // Log only when a request logger is available (authenticated request)
    if (req.log) req.log.warn({ err }, "Failed to fetch Stripe prices");
    // Return static fallback so the pricing UI is never broken
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

  const { priceId } = req.body as { priceId?: string };
  if (!priceId || typeof priceId !== "string") {
    res.status(400).json({ error: "priceId is required" });
    return;
  }

  // Server-side allowlist: only allow Pro Plan prices
  let allowedPrices: string[];
  try {
    const prices = await getProPrices();
    allowedPrices = prices.map((p) => p.id);
  } catch (err: any) {
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

  const origin = process.env.REPLIT_DOMAINS
    ? `https://${process.env.REPLIT_DOMAINS.split(",")[0].trim()}`
    : `${req.protocol}://${req.get("host")}`;

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

  const origin = process.env.REPLIT_DOMAINS
    ? `https://${process.env.REPLIT_DOMAINS.split(",")[0].trim()}`
    : `${req.protocol}://${req.get("host")}`;

  const stripe = await getUncachableStripeClient();
  const portalSession = await stripe.billingPortal.sessions.create({
    customer: info.stripeCustomerId,
    return_url: `${origin}/settings`,
  });

  res.json({ url: portalSession.url });
});

export default router;
