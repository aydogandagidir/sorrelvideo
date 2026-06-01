import React from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Layout } from "@/components/layout";
import { useBillingInfo } from "@/hooks/useBilling";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  AlertCircle,
  BarChart3,
  Clapperboard,
  Sparkles,
  Crown,
  Info,
} from "lucide-react";

/**
 * Mirrors the `ModuleStatusBadge` in pages/modules.tsx. Replicated here (rather
 * than imported) because that component is not exported, and these scaffold
 * pages must not modify modules.tsx.
 */
function ModuleStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "active":
      return (
        <Badge className="bg-primary text-primary-foreground">Active</Badge>
      );
    case "beta":
      return (
        <Badge className="bg-blue-500/10 text-blue-500 border-blue-500/20">
          Beta
        </Badge>
      );
    case "coming_soon":
      return (
        <Badge variant="outline" className="text-muted-foreground">
          Coming Soon
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function SummaryCard({
  title,
  value,
  hint,
  icon: Icon,
}: {
  title: string;
  value: React.ReactNode;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
      </CardContent>
    </Card>
  );
}

const chartConfig = {
  renders: {
    label: "Renders",
    color: "hsl(var(--primary))",
  },
} satisfies ChartConfig;

export default function Analytics() {
  const { data: billing, isLoading, isError } = useBillingInfo();

  if (isError) {
    return (
      <Layout>
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>
            Failed to load usage data. Please try again later.
          </AlertDescription>
        </Alert>
      </Layout>
    );
  }

  const renderCount = billing?.renderCount ?? 0;
  const renderLimit = billing?.renderLimit ?? null;
  const isPro = billing?.plan === "pro";

  const renderUsageLabel =
    renderLimit != null ? `${renderCount} / ${renderLimit}` : `${renderCount}`;

  const resetLabel = billing?.renderResetAt
    ? new Date(billing.renderResetAt).toLocaleDateString()
    : null;

  // Single real datapoint (this period). The trend chart is a scaffold that
  // shows current usage against the plan limit until per-day analytics land.
  const chartData = [
    {
      period: "This period",
      renders: renderCount,
    },
  ];

  return (
    <Layout>
      <div className="flex items-start justify-between mb-8 gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-3xl font-bold tracking-tight">Analytics</h1>
            <ModuleStatusBadge status="beta" />
          </div>
          <p className="text-muted-foreground">
            Track your render usage and plan limits at a glance.
          </p>
        </div>
      </div>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 mb-8">
        {isLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <Skeleton className="h-4 w-24" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-16 mb-2" />
                <Skeleton className="h-3 w-32" />
              </CardContent>
            </Card>
          ))
        ) : (
          <>
            <SummaryCard
              title="Renders used"
              value={renderUsageLabel}
              hint={
                isPro
                  ? "Unlimited on the Pro plan"
                  : resetLabel
                    ? `Resets ${resetLabel}`
                    : "This billing period"
              }
              icon={Clapperboard}
            />
            <SummaryCard
              title="AI suggestions"
              value="—"
              hint="Per-field AI usage analytics coming soon"
              icon={Sparkles}
            />
            <SummaryCard
              title="Current plan"
              value={
                <span className="capitalize">{billing?.plan ?? "free"}</span>
              }
              hint={isPro ? "Thanks for being a Pro" : "Upgrade for more renders"}
              icon={Crown}
            />
          </>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-muted-foreground" />
            Render usage
          </CardTitle>
          <CardDescription>
            Renders consumed in the current billing period.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-[260px] w-full" />
          ) : (
            <ChartContainer
              config={chartConfig}
              className="h-[260px] w-full"
            >
              <BarChart accessibilityLayer data={chartData}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="period"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar
                  dataKey="renders"
                  fill="var(--color-renders)"
                  radius={[6, 6, 0, 0]}
                />
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      <Alert className="mt-8">
        <Info className="h-4 w-4" />
        <AlertTitle>More analytics on the way</AlertTitle>
        <AlertDescription>
          Detailed metrics — per-day render history, AI usage breakdowns, and
          watch-time — will appear here as the Analytics module matures.
        </AlertDescription>
      </Alert>
    </Layout>
  );
}
