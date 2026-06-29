import Stripe from "stripe";

let cachedClient: Stripe | null = null;

function readSecretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      "STRIPE_SECRET_KEY is required. Set it in your environment (.env) before booting the API server.",
    );
  }
  return key;
}

/**
 * Returns the shared Stripe client. The signature is kept async for backward
 * compatibility with existing call sites; the implementation is now synchronous
 * under the hood (a single cached singleton driven by STRIPE_SECRET_KEY).
 */
export async function getUncachableStripeClient(): Promise<Stripe> {
  if (!cachedClient) {
    cachedClient = new Stripe(readSecretKey(), {
      apiVersion: "2026-06-24.dahlia",
    });
  }
  return cachedClient;
}

export async function getStripePublishableKey(): Promise<string> {
  const key = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!key) {
    throw new Error(
      "STRIPE_PUBLISHABLE_KEY is required for client-side checkout flows.",
    );
  }
  return key;
}

export async function getStripeSecretKey(): Promise<string> {
  return readSecretKey();
}
