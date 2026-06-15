import { useEffect, useState } from "react";
import { useSearch } from "wouter";
import { Layout } from "@/components/layout";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import { useAuth } from "@workspace/auth-web";
import {
  User,
  Mail,
  Shield,
  LogOut,
  Zap,
  CreditCard,
  Loader2,
  Keyboard,
} from "lucide-react";
import {
  useBillingInfo,
  useBillingCheckout,
  useBillingPortal,
  useBillingPrices,
} from "@/hooks/useBilling";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

/**
 * Single-key nav shortcuts (S/D/P/T/B) are convenient but a WCAG 2.1.4 risk —
 * the spec requires a way to switch character-key shortcuts off. The layout's
 * key handler reads `localStorage["sorrel:navShortcuts"]` at fire time, so this
 * toggle needs no shared state or context.
 */
function NavShortcutsToggle() {
  const [enabled, setEnabled] = useState(
    () =>
      typeof localStorage === "undefined" ||
      localStorage.getItem("sorrel:navShortcuts") !== "off",
  );
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <Label htmlFor="nav-shortcuts" className="text-sm font-medium">
          Single-key navigation shortcuts
        </Label>
        <p className="mt-1 text-xs text-muted-foreground">
          Press S, D, P, T, or B to jump between pages. Turn this off if it gets
          in the way of typing.
        </p>
      </div>
      <Switch
        id="nav-shortcuts"
        checked={enabled}
        aria-label="Single-key navigation shortcuts"
        onCheckedChange={(on) => {
          setEnabled(on);
          try {
            localStorage.setItem("sorrel:navShortcuts", on ? "on" : "off");
          } catch {
            /* localStorage may be unavailable */
          }
        }}
      />
    </div>
  );
}

function BillingCard() {
  const { data: billing, isLoading } = useBillingInfo();
  const { data: pricesData } = useBillingPrices();
  const checkoutMutation = useBillingCheckout();
  const portalMutation = useBillingPortal();
  const queryClient = useQueryClient();
  const search = useSearch();
  const { toast } = useToast();

  // After a successful Stripe checkout, the webhook may take a few seconds to
  // arrive and update the subscription record. We poll /billing/me until the
  // plan flips to "pro" (or we give up after 30 seconds) so the UI updates
  // reliably without waiting for a manual page refresh.
  useEffect(() => {
    if (!search.includes("upgraded=1")) return;

    let attempts = 0;
    const MAX_ATTEMPTS = 10;
    const INTERVAL_MS = 3000;

    const poll = setInterval(() => {
      attempts++;
      queryClient.invalidateQueries({ queryKey: ["billing"] });

      const cached = queryClient.getQueryData<{ plan: string }>(["billing", "me"]);
      if (cached?.plan === "pro" || attempts >= MAX_ATTEMPTS) {
        clearInterval(poll);
      }
    }, INTERVAL_MS);

    return () => clearInterval(poll);
  }, [search, queryClient]);

  const monthlyPrice = pricesData?.prices?.find((p) => p.interval === "month");

  const handleUpgrade = async () => {
    if (!monthlyPrice) return;
    try {
      const { url } = await checkoutMutation.mutateAsync({
        priceId: monthlyPrice.id,
      });
      if (url) window.location.href = url;
    } catch {
      toast({
        variant: "destructive",
        title: "Couldn't start checkout",
        description: "Please try again in a moment.",
      });
    }
  };

  const handlePortal = async () => {
    try {
      const { url } = await portalMutation.mutateAsync();
      if (url) window.location.href = url;
    } catch {
      toast({
        variant: "destructive",
        title: "Couldn't open the billing portal",
        description: "Please try again in a moment.",
      });
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center h-32">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const isPro = billing?.plan === "pro";
  const renderCount = billing?.renderCount ?? 0;
  const renderLimit = billing?.renderLimit ?? 3;
  const renderPct = isPro ? 0 : Math.min((renderCount / renderLimit) * 100, 100);
  const aiCount = billing?.aiCount ?? 0;
  const aiLimit = billing?.aiLimit ?? 10;
  const aiPct = isPro ? 0 : Math.min((aiCount / aiLimit) * 100, 100);
  const aiRemaining = Math.max(aiLimit - aiCount, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CreditCard className="h-4 w-4" />
          Plan & Billing
        </CardTitle>
        <CardDescription>Manage your subscription and usage.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <p className="text-sm font-medium">Current plan</p>
            <div className="flex items-center gap-2">
              <Badge
                className={
                  isPro
                    ? "bg-primary/10 text-primary border-primary/20"
                    : "bg-muted text-muted-foreground"
                }
              >
                {isPro ? (
                  <>
                    <Zap className="mr-1 h-3 w-3" /> Pro
                  </>
                ) : (
                  "Free"
                )}
              </Badge>
            </div>
          </div>
          {isPro ? (
            <Button
              variant="outline"
              size="sm"
              onClick={handlePortal}
              disabled={portalMutation.isPending}
            >
              {portalMutation.isPending && (
                <Loader2 className="mr-2 h-3 w-3 animate-spin" />
              )}
              Manage Subscription
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={handleUpgrade}
              disabled={checkoutMutation.isPending || !monthlyPrice}
            >
              {checkoutMutation.isPending ? (
                <Loader2 className="mr-2 h-3 w-3 animate-spin" />
              ) : (
                <Zap className="mr-2 h-3 w-3" />
              )}
              Upgrade to Pro
            </Button>
          )}
        </div>

        {!isPro && (
          <>
            <Separator />
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Renders this month</span>
                <span className="font-medium">
                  {renderCount} / {renderLimit}
                </span>
              </div>
              <Progress value={renderPct} className="h-2" />
              {billing?.renderResetAt && (
                <p className="text-xs text-muted-foreground">
                  Resets{" "}
                  {new Date(billing.renderResetAt).toLocaleDateString("en-US", {
                    month: "long",
                    day: "numeric",
                  })}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">AI drafts this month</span>
                <span className="font-medium">
                  {aiCount} / {aiLimit}
                </span>
              </div>
              <Progress value={aiPct} className="h-2" />
              <p className="text-xs text-muted-foreground">
                {aiRemaining > 0
                  ? `${aiRemaining} AI ${aiRemaining === 1 ? "draft" : "drafts"} left — upgrade to Pro for unlimited.`
                  : "You're out of AI drafts this month — upgrade to Pro for unlimited."}
              </p>
            </div>
          </>
        )}

        {isPro && (
          <p className="text-sm text-muted-foreground">
            Unlimited renders and AI drafts included with your Pro plan.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function Settings() {
  const { user, logout } = useAuth();

  if (!user) return null;

  const initials =
    [user.firstName, user.lastName]
      .filter((name): name is string => Boolean(name))
      .map((n) => n[0]?.toUpperCase() ?? "")
      .join("") ||
    user.email?.[0]?.toUpperCase() ||
    "U";

  const displayName =
    [user.firstName, user.lastName].filter(Boolean).join(" ") ||
    user.email ||
    "User";

  return (
    <Layout>
      <div className="space-y-6">
        <div>
          <h1 className="text-[27px] leading-tight">Settings</h1>
          <p className="text-muted-foreground">
            Manage your account and preferences.
          </p>
        </div>

        <BillingCard />

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Keyboard className="h-4 w-4" />
              Preferences
            </CardTitle>
            <CardDescription>Personalize how Sorrel behaves.</CardDescription>
          </CardHeader>
          <CardContent>
            <NavShortcutsToggle />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="h-4 w-4" />
              Profile
            </CardTitle>
            <CardDescription>
              Your account information from your identity provider.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center gap-4">
              <Avatar className="h-16 w-16">
                {user.profileImageUrl && (
                  <AvatarImage src={user.profileImageUrl} alt={displayName} />
                )}
                <AvatarFallback className="bg-primary/10 text-primary text-xl">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div>
                <p className="text-lg font-semibold">{displayName}</p>
                {user.email && (
                  <p className="text-sm text-muted-foreground flex items-center gap-1">
                    <Mail className="h-3 w-3" />
                    {user.email}
                  </p>
                )}
              </div>
            </div>

            <Separator />

            <div className="grid gap-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">User ID</span>
                <code className="bg-muted px-2 py-0.5 rounded text-xs font-mono truncate max-w-[200px]">
                  {user.id}
                </code>
              </div>
              {user.firstName && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">First name</span>
                  <span>{user.firstName}</span>
                </div>
              )}
              {user.lastName && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Last name</span>
                  <span>{user.lastName}</span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Security
            </CardTitle>
            <CardDescription>
              Authentication and session management.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Authentication status</p>
                <p className="text-xs text-muted-foreground">
                  You are currently signed in.
                </p>
              </div>
              <Badge
                variant="secondary"
                className="border-success/25 bg-success/15 text-success"
              >
                Active
              </Badge>
            </div>

            <Separator />

            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Sign out</p>
                <p className="text-xs text-muted-foreground">
                  End your current session on this device.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={logout}
                className="gap-2"
              >
                <LogOut className="h-4 w-4" />
                Log out
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
