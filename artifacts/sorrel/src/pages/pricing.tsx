import React, { useState } from "react";
import { Link } from "wouter";
import { Check, Zap, Video, Loader2, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useBillingPrices, useBillingCheckout } from "@/hooks/useBilling";
import { useAuth } from "@workspace/auth-web";

const FREE_FEATURES = [
  "3 renders per month",
  "Standard templates",
  "720p output",
  "Community support",
];

const PRO_FEATURES = [
  "Unlimited renders",
  "All premium templates",
  "1080p output",
  "Priority render queue",
  "Advanced analytics",
  "Priority support",
  "Custom brand kit",
];

function PricingCard({
  plan,
  price,
  priceId,
  features,
  highlighted,
}: {
  plan: string;
  price: string;
  priceId?: string;
  features: string[];
  highlighted?: boolean;
}) {
  const { isAuthenticated, login } = useAuth();
  const checkoutMutation = useBillingCheckout();

  const handleUpgrade = async () => {
    if (!isAuthenticated) {
      // Redirect to login; after login they'll land back at /pricing
      login();
      return;
    }
    if (!priceId) return;
    try {
      const { url } = await checkoutMutation.mutateAsync({ priceId });
      if (url) window.location.href = url;
    } catch (err) {
      console.error("Checkout failed", err);
    }
  };

  return (
    <div
      className={`relative rounded-2xl border p-8 flex flex-col gap-6 ${
        highlighted
          ? "border-primary bg-primary/5 shadow-lg shadow-primary/10"
          : "bg-card"
      }`}
    >
      {highlighted && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
          <Badge className="bg-primary text-primary-foreground px-4">
            Most Popular
          </Badge>
        </div>
      )}

      <div>
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-xl font-bold">{plan}</h3>
          {highlighted && <Zap className="h-4 w-4 text-primary" />}
        </div>
        <div className="flex items-baseline gap-1">
          <span className="text-4xl font-extrabold">{price}</span>
          {price !== "Free" && (
            <span className="text-muted-foreground">/month</span>
          )}
        </div>
      </div>

      <ul className="space-y-3 flex-1">
        {features.map((f) => (
          <li key={f} className="flex items-center gap-2 text-sm">
            <Check className="h-4 w-4 text-primary shrink-0" />
            {f}
          </li>
        ))}
      </ul>

      {highlighted ? (
        <Button
          className="w-full"
          onClick={handleUpgrade}
          disabled={checkoutMutation.isPending || !priceId}
          title={!priceId ? "Pricing unavailable — try again shortly" : undefined}
        >
          {checkoutMutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Zap className="mr-2 h-4 w-4" />
          )}
          {!priceId
            ? "Unavailable"
            : isAuthenticated
              ? "Get Started"
              : "Sign up & Get Started"}
        </Button>
      ) : (
        <Link
          href="/dashboard"
          className="inline-flex w-full h-10 items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium hover:bg-muted transition-colors"
        >
          Get Started Free
        </Link>
      )}
    </div>
  );
}

export default function Pricing() {
  const { data: pricesData, isLoading } = useBillingPrices();
  const monthlyPrice = pricesData?.prices?.find((p) => p.interval === "month");
  const priceDisplay = monthlyPrice
    ? `$${((monthlyPrice.unitAmount ?? 0) / 100).toFixed(0)}`
    : "$29";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="fixed top-0 z-50 w-full border-b bg-background/80 backdrop-blur-md">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <Link href="/" className="flex items-center gap-2 font-bold text-lg tracking-tight">
            <Video className="h-5 w-5 text-primary" />
            <span>Sorrel</span>
          </Link>
          <nav className="hidden md:flex gap-6 text-sm font-medium">
            <Link href="/#features" className="text-muted-foreground hover:text-foreground transition-colors">
              Features
            </Link>
            <Link href="/pricing" className="text-foreground font-semibold">
              Pricing
            </Link>
          </nav>
          <Link
            href="/dashboard"
            className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Open App <ArrowRight className="ml-2 h-4 w-4" />
          </Link>
        </div>
      </header>

      <main className="pt-32 pb-24 px-4">
        <div className="container mx-auto max-w-5xl">
          <div className="text-center mb-16">
            <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl mb-4">
              Simple, transparent pricing
            </h1>
            <p className="text-muted-foreground text-lg max-w-xl mx-auto">
              Start for free, upgrade when you need more. No hidden fees.
            </p>
          </div>

          {isLoading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-3xl mx-auto">
              <PricingCard
                plan="Free"
                price="Free"
                features={FREE_FEATURES}
              />
              <PricingCard
                plan="Pro"
                price={priceDisplay}
                priceId={monthlyPrice?.id}
                features={PRO_FEATURES}
                highlighted
              />
            </div>
          )}

          <p className="text-center text-sm text-muted-foreground mt-8">
            No credit card required for the free plan. Cancel anytime.
          </p>
        </div>
      </main>

      <footer className="py-12 border-t bg-background">
        <div className="container mx-auto px-4 flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-2 font-bold text-lg tracking-tight">
            <Video className="h-5 w-5 text-primary" />
            <span>Sorrel</span>
          </div>
          <p className="text-sm text-muted-foreground">
            © {new Date().getFullYear()} Sorrel Platform. Built on Hyperframes.
          </p>
        </div>
      </footer>
    </div>
  );
}
