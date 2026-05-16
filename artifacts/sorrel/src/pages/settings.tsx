import { useEffect } from "react";
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
} from "lucide-react";
import {
  useBillingInfo,
  useBillingCheckout,
  useBillingPortal,
  useBillingPrices,
} from "@/hooks/useBilling";
import { useQueryClient } from "@tanstack/react-query";

function BillingCard() {
  const { data: billing, isLoading } = useBillingInfo();
  const { data: pricesData } = useBillingPrices();
  const checkoutMutation = useBillingCheckout();
  const portalMutation = useBillingPortal();
  const queryClient = useQueryClient();
  const search = useSearch();

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
    const { url } = await checkoutMutation.mutateAsync({
      priceId: monthlyPrice.id,
    });
    if (url) window.location.href = url;
  };

  const handlePortal = async () => {
    const { url } = await portalMutation.mutateAsync();
    if (url) window.location.href = url;
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
          </>
        )}

        {isPro && (
          <p className="text-sm text-muted-foreground">
            Unlimited renders included with your Pro plan.
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
      .filter(Boolean)
      .map((n) => n![0].toUpperCase())
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
          <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
          <p className="text-muted-foreground">
            Manage your account and preferences.
          </p>
        </div>

        <BillingCard />

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
                className="text-green-600 bg-green-50"
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
