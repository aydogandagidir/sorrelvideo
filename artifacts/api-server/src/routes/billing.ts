import { Router, type IRouter } from "express";
import { getBillingInfo, ensureStripeCustomer } from "../services/billingService";
import { getUncachableStripeClient } from "../stripeClient";

const router: IRouter = Router();

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
    cancel_url: `${origin}/settings`,
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

// GET /api/billing/prices — list active Pro Plan prices from Stripe
router.get("/billing/prices", async (req, res): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const stripe = await getUncachableStripeClient();
    const prices = await stripe.prices.list({
      active: true,
      expand: ["data.product"],
    });

    const formatted = prices.data
      .filter((p) => p.type === "recurring")
      .map((p) => ({
        id: p.id,
        unitAmount: p.unit_amount,
        currency: p.currency,
        interval: p.recurring?.interval,
        productName:
          typeof p.product === "object" && p.product !== null && "name" in p.product
            ? (p.product as any).name
            : null,
      }));

    res.json({ prices: formatted });
  } catch (err: any) {
    req.log.error({ err }, "Failed to fetch Stripe prices");
    res.json({ prices: [] });
  }
});

export default router;
