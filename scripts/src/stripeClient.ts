import Stripe from "stripe";

let cachedClient: Stripe | null = null;

export async function getUncachableStripeClient(): Promise<Stripe> {
  if (cachedClient) return cachedClient;

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error(
      "STRIPE_SECRET_KEY is required. Set it in your environment before running scripts.",
    );
  }

  cachedClient = new Stripe(secretKey, {
    apiVersion: "2026-06-24.dahlia",
  });
  return cachedClient;
}
