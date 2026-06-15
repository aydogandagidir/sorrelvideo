import React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Zap, Check, Loader2 } from "lucide-react";
import { useBillingCheckout, useBillingPrices } from "@/hooks/useBilling";

interface UpgradeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reason?:
    | "render_limit"
    | "premium_template"
    | "ai_limit"
    | "render_quality"
    | "avatar"
    | "general";
}

const REASON_MESSAGES: Record<string, { title: string; description: string }> =
  {
    render_limit: {
      title: "You've hit the free render limit",
      description:
        "Free accounts get 3 renders per month. Upgrade to Pro for unlimited renders.",
    },
    premium_template: {
      title: "Premium template requires Pro",
      description:
        "This template is exclusive to Pro users. Upgrade to unlock it and all other premium templates.",
    },
    ai_limit: {
      title: "You've hit the free AI limit",
      description:
        "Free accounts get 10 AI suggestions per month. Upgrade to Pro for unlimited AI drafts.",
    },
    render_quality: {
      title: "High-quality exports need Pro",
      description:
        "Free renders are capped at 1080p, 30fps, MP4 with a watermark and a single transition. Upgrade to Pro for 4K, 60fps, transparent backgrounds, ProRes/MOV and WebM exports, watermark removal, and multiple transitions.",
    },
    avatar: {
      title: "The Live Avatar is a Pro feature",
      description:
        "The real-time conversational avatar is included with Sorrel Pro. Upgrade to talk to your brand's AI host live.",
    },
    general: {
      title: "Upgrade to Sorrel Pro",
      description:
        "Get unlimited renders, all premium templates, and priority support.",
    },
  };

const PRO_FEATURES = [
  "Unlimited renders & AI drafts",
  "4K resolution & 60 fps",
  "No watermark",
  "Transparent, WebM & ProRes exports",
  "Captions & background audio",
  "All premium templates",
];

export function UpgradeModal({
  open,
  onOpenChange,
  reason = "general",
}: UpgradeModalProps) {
  const { data: pricesData, isLoading: pricesLoading } = useBillingPrices();
  const checkoutMutation = useBillingCheckout();

  const message = REASON_MESSAGES[reason];
  const monthlyPrice = pricesData?.prices?.find((p) => p.interval === "month");

  const handleUpgrade = async () => {
    if (!monthlyPrice) return;
    try {
      const { url } = await checkoutMutation.mutateAsync({
        priceId: monthlyPrice.id,
      });
      if (url) window.location.href = url;
    } catch (err) {
      console.error("Checkout failed", err);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2 mb-1">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
              <Zap className="h-4 w-4 text-primary" />
            </div>
            <Badge className="bg-primary/10 text-primary border-primary/20">
              Pro
            </Badge>
          </div>
          <DialogTitle>{message.title}</DialogTitle>
          <DialogDescription>{message.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <ul className="space-y-2">
            {PRO_FEATURES.map((feature) => (
              <li key={feature} className="flex items-center gap-2 text-sm">
                <Check className="h-4 w-4 text-primary shrink-0" />
                {feature}
              </li>
            ))}
          </ul>

          <div className="rounded-lg border bg-muted/30 p-4 text-center">
            {pricesLoading ? (
              <div className="h-8 flex items-center justify-center">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : monthlyPrice ? (
              <>
                <span className="text-3xl font-bold">
                  ${((monthlyPrice.unitAmount ?? 0) / 100).toFixed(0)}
                </span>
                <span className="text-muted-foreground">/month</span>
              </>
            ) : (
              <span className="text-muted-foreground text-sm">
                Contact us for pricing
              </span>
            )}
          </div>

          <Button
            className="w-full"
            onClick={handleUpgrade}
            disabled={checkoutMutation.isPending || !monthlyPrice}
          >
            {checkoutMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Zap className="mr-2 h-4 w-4" />
            )}
            Upgrade to Pro
          </Button>

          <p className="text-center text-xs text-muted-foreground">
            Cancel anytime via the billing portal. Secured by Stripe.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
