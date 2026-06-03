import { useQuery, useMutation } from "@tanstack/react-query";

export interface BillingInfo {
  plan: "free" | "pro";
  renderCount: number;
  renderLimit: number | null;
  renderResetAt: string | null;
  // AI suggestion quota — mirrors the render counters. The backend
  // (GET /api/billing/me) and OpenAPI `BillingInfo` schema already return these;
  // Free users get a numeric `aiLimit`, Pro users get `null` (unlimited).
  aiCount: number;
  aiLimit: number | null;
  aiResetAt: string | null;
  stripeCustomerId: string | null;
}

export interface BillingPrice {
  id: string;
  unitAmount: number | null;
  currency: string;
  interval: string | null;
  productName: string | null;
}

async function fetchBillingInfo(): Promise<BillingInfo> {
  const res = await fetch("/api/billing/me", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to fetch billing info");
  return res.json();
}

async function fetchBillingPrices(): Promise<{ prices: BillingPrice[] }> {
  // Public endpoint — no auth required so the pricing page works for visitors
  const res = await fetch("/api/billing/prices");
  if (!res.ok) throw new Error("Failed to fetch prices");
  return res.json();
}

async function createCheckoutSession(priceId: string): Promise<{ url: string }> {
  const res = await fetch("/api/billing/checkout", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ priceId }),
  });
  if (!res.ok) throw new Error("Failed to create checkout session");
  return res.json();
}

async function createPortalSession(): Promise<{ url: string }> {
  const res = await fetch("/api/billing/portal", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error("Failed to create portal session");
  return res.json();
}

export function useBillingInfo() {
  return useQuery({
    queryKey: ["billing", "me"],
    queryFn: fetchBillingInfo,
    staleTime: 30_000,
  });
}

export function useBillingPrices() {
  return useQuery({
    queryKey: ["billing", "prices"],
    queryFn: fetchBillingPrices,
    staleTime: 5 * 60_000,
  });
}

export function useBillingCheckout() {
  return useMutation({
    mutationFn: ({ priceId }: { priceId: string }) =>
      createCheckoutSession(priceId),
  });
}

export function useBillingPortal() {
  return useMutation({
    mutationFn: createPortalSession,
  });
}
