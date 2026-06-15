import React from "react";
import { Link } from "wouter";
import { Check, Zap, Video, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useBillingPrices, useBillingCheckout } from "@/hooks/useBilling";
import { useAuth } from "@workspace/auth-web";
import { FREE_PLAN_FEATURES, PRO_PLAN_FEATURES } from "@/lib/plans";
import { MarketingHeader } from "@/components/marketing-header";

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
  features: readonly string[];
  highlighted?: boolean;
}) {
  const { isAuthenticated, login } = useAuth();
  const checkoutMutation = useBillingCheckout();

  const handleUpgrade = async () => {
    if (!isAuthenticated) {
      // Redirect to login; after login they land back here at /pricing so the
      // user can resume checkout in one more click.
      login("/pricing");
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
          href="/signup"
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
      <MarketingHeader active="pricing" />

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
                features={FREE_PLAN_FEATURES}
              />
              <PricingCard
                plan="Pro"
                price={priceDisplay}
                priceId={monthlyPrice?.id}
                features={PRO_PLAN_FEATURES}
                highlighted
              />
            </div>
          )}

          <p className="text-center text-sm text-muted-foreground mt-8">
            No credit card required for the free plan. Cancel anytime.
          </p>
          <p className="text-center text-xs text-muted-foreground mt-2">
            Subscriptions are billed through Stripe. By subscribing you agree to
            our{" "}
            <Link
              href="/terms"
              className="underline underline-offset-4 hover:text-foreground"
            >
              Terms
            </Link>{" "}
            and{" "}
            <Link
              href="/privacy"
              className="underline underline-offset-4 hover:text-foreground"
            >
              Privacy Policy
            </Link>
            .
          </p>
        </div>
      </main>

      <footer className="py-12 border-t bg-background">
        <div className="container mx-auto px-4 flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-2 font-bold text-lg tracking-tight">
            <Video className="h-5 w-5 text-primary" />
            <span>Sorrel</span>
          </div>
          <nav className="flex items-center gap-6 text-sm text-muted-foreground">
            <Link href="/terms" className="hover:text-foreground transition-colors">
              Terms
            </Link>
            <Link href="/privacy" className="hover:text-foreground transition-colors">
              Privacy
            </Link>
          </nav>
          <p className="text-sm text-muted-foreground">
            © {new Date().getFullYear()} Sorrel Platform. Built on Hyperframes.
          </p>
        </div>
      </footer>
    </div>
  );
}
