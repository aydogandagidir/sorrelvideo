import React from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Layout } from "@/components/layout";
import { useBillingInfo } from "@/hooks/useBilling";
import { useGetAnalyticsOverview } from "@workspace/api-client-react";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  Clapperboard,
  Crown,
  Film,
  Percent,
  Sparkles,
  XCircle,
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
        <Badge className="border-warning/25 bg-warning/15 text-warning">
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

/** A compact metric card — small label, large number, optional hint. */
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
        <div className="text-2xl font-bold tabular-nums">{value}</div>
        {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
      </CardContent>
    </Card>
  );
}

/** Colored status pill for a render attempt. */
function RenderStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "ready":
      return (
        <Badge className="bg-primary text-primary-foreground">Ready</Badge>
      );
    case "failed":
      return <Badge variant="destructive">Failed</Badge>;
    case "rendering":
      return (
        <Badge className="border-spark/20 bg-spark/10 text-spark">
          Rendering
        </Badge>
      );
    case "queued":
      return (
        <Badge variant="outline" className="text-muted-foreground">
          Queued
        </Badge>
      );
    case "cancelled":
      return (
        <Badge variant="outline" className="text-muted-foreground">
          Cancelled
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

/** A labeled horizontal-bar breakdown (output formats, top templates). */
function BreakdownList({
  items,
  emptyLabel,
}: {
  items: { label: string; count: number }[];
  emptyLabel: string;
}) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-8">
        {emptyLabel}
      </p>
    );
  }
  const max = Math.max(...items.map((i) => i.count), 1);
  return (
    <div className="space-y-3">
      {items.map((it) => (
        <div key={it.label}>
          <div className="flex items-center justify-between text-sm mb-1.5">
            <span className="font-medium truncate">{it.label}</span>
            <span className="text-muted-foreground tabular-nums">
              {it.count}
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary"
              style={{
                width: `${Math.max(4, Math.round((it.count / max) * 100))}%`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** mp4 → "MP4", png-sequence → "PNG sequence", etc. */
function formatLabel(format: string): string {
  const map: Record<string, string> = {
    mp4: "MP4",
    webm: "WebM",
    mov: "MOV",
    "png-sequence": "PNG sequence",
    unknown: "Unknown",
  };
  return map[format] ?? format.toUpperCase();
}

/** Template slug → Title Case ("website-showcase" → "Website Showcase"). */
function moduleLabel(module: string | null | undefined): string {
  if (!module) return "—";
  return module
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const chartConfig = {
  ready: { label: "Ready", color: "hsl(var(--primary))" },
  failed: { label: "Failed", color: "hsl(var(--destructive))" },
} satisfies ChartConfig;

export default function Analytics() {
  const { data: billing, isLoading, isError } = useBillingInfo();
  const {
    data: analytics,
    isLoading: analyticsLoading,
    isError: analyticsError,
  } = useGetAnalyticsOverview();

  // The full-page error stays tied to billing — usage/quota is the page's
  // backbone. Render-analytics failures degrade inline (see below) so a missing
  // ledger never blanks the whole screen.
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

  // ── Billing-derived quota (existing behavior, kept verbatim) ──────────────
  const renderCount = billing?.renderCount ?? 0;
  const renderLimit = billing?.renderLimit ?? null;
  const isPro = billing?.plan === "pro";

  const renderUsageLabel =
    renderLimit != null ? `${renderCount} / ${renderLimit}` : `${renderCount}`;

  const resetLabel = billing?.renderResetAt
    ? new Date(billing.renderResetAt).toLocaleDateString()
    : null;

  const aiCount = billing?.aiCount ?? 0;
  const aiLimit = billing?.aiLimit ?? null;
  const aiRemaining = aiLimit != null ? Math.max(aiLimit - aiCount, 0) : null;
  const aiNearCap = aiRemaining != null && aiRemaining <= 2;

  const aiUsageLabel =
    aiLimit != null ? `${aiCount} / ${aiLimit}` : `${aiCount}`;
  const aiHint = isPro
    ? "Unlimited on the Pro plan"
    : aiRemaining != null
      ? `${aiRemaining} AI ${aiRemaining === 1 ? "draft" : "drafts"} left this month`
      : "AI drafts used this month";

  // ── Render-job-derived analytics (real, from /api/analytics/overview) ─────
  const totals = analytics?.totals;
  const successRateLabel =
    totals?.successRate != null
      ? `${(totals.successRate * 100).toFixed(1)}%`
      : "—";
  const hasActivity = (totals?.totalRenders ?? 0) > 0;

  const formatItems = (analytics?.formats ?? []).map((f) => ({
    label: formatLabel(f.format),
    count: f.count,
  }));
  const templateItems = (analytics?.topTemplates ?? []).map((t) => ({
    label: moduleLabel(t.module),
    count: t.count,
  }));
  const recentRenders = analytics?.recentRenders ?? [];

  return (
    <Layout>
      <div className="flex items-start justify-between mb-8 gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-3xl font-bold tracking-tight">Analytics</h1>
            <ModuleStatusBadge status="beta" />
          </div>
          <p className="text-muted-foreground">
            Render performance, output mix and plan usage across your account.
          </p>
        </div>
      </div>

      {/* KPI row — render-attempt totals from the ledger. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        {analyticsLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <Skeleton className="h-4 w-24" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-16" />
              </CardContent>
            </Card>
          ))
        ) : (
          <>
            <SummaryCard
              title="Total renders"
              value={totals?.totalRenders ?? 0}
              hint="All render attempts"
              icon={Film}
            />
            <SummaryCard
              title="Succeeded"
              value={totals?.succeeded ?? 0}
              hint={
                totals?.inProgress
                  ? `${totals.inProgress} in progress`
                  : "Completed renders"
              }
              icon={CheckCircle2}
            />
            <SummaryCard
              title="Failed"
              value={totals?.failed ?? 0}
              hint={
                totals?.cancelled
                  ? `${totals.cancelled} cancelled`
                  : "Failed renders"
              }
              icon={XCircle}
            />
            <SummaryCard
              title="Success rate"
              value={successRateLabel}
              hint="Of completed renders"
              icon={Percent}
            />
          </>
        )}
      </div>

      {/* Render activity over the last 30 days. */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-muted-foreground" />
            Render activity
          </CardTitle>
          <CardDescription>
            Renders per day over the last 30 days, by outcome.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {analyticsLoading ? (
            <Skeleton className="h-[260px] w-full" />
          ) : analyticsError ? (
            <p className="text-sm text-muted-foreground text-center py-16">
              Couldn’t load render activity right now.
            </p>
          ) : hasActivity ? (
            <ChartContainer config={chartConfig} className="h-[260px] w-full">
              <AreaChart accessibilityLayer data={analytics?.activity ?? []}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={28}
                  tickFormatter={(value: string) => value.slice(5)}
                />
                <YAxis
                  allowDecimals={false}
                  tickLine={false}
                  axisLine={false}
                  width={28}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Area
                  dataKey="ready"
                  type="monotone"
                  stackId="a"
                  stroke="var(--color-ready)"
                  fill="var(--color-ready)"
                  fillOpacity={0.2}
                />
                <Area
                  dataKey="failed"
                  type="monotone"
                  stackId="a"
                  stroke="var(--color-failed)"
                  fill="var(--color-failed)"
                  fillOpacity={0.2}
                />
              </AreaChart>
            </ChartContainer>
          ) : (
            <div className="flex flex-col items-center justify-center text-center h-[260px] rounded-md border border-dashed">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-muted mb-3">
                <Clapperboard className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground max-w-xs">
                No renders yet. Render a project and your activity will show up
                here.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Output-format + top-template breakdowns. */}
      <div className="grid gap-6 lg:grid-cols-2 mb-6">
        <Card>
          <CardHeader>
            <CardTitle>Output formats</CardTitle>
            <CardDescription>How your renders are exported.</CardDescription>
          </CardHeader>
          <CardContent>
            {analyticsLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-7 w-full" />
                ))}
              </div>
            ) : (
              <BreakdownList items={formatItems} emptyLabel="No renders yet." />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top templates</CardTitle>
            <CardDescription>Most-rendered templates.</CardDescription>
          </CardHeader>
          <CardContent>
            {analyticsLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-7 w-full" />
                ))}
              </div>
            ) : (
              <BreakdownList
                items={templateItems}
                emptyLabel="No renders yet."
              />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Plan usage & quota (billing-derived). */}
      <h2 className="text-lg font-semibold tracking-tight mb-3">
        Plan &amp; usage
      </h2>
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 mb-6">
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
              title="AI drafts used"
              value={
                <span className={aiNearCap ? "text-warning" : undefined}>
                  {aiUsageLabel}
                </span>
              }
              hint={aiHint}
              icon={Sparkles}
            />
            <SummaryCard
              title="Current plan"
              value={
                <span className="capitalize">{billing?.plan ?? "free"}</span>
              }
              hint={
                isPro ? "Thanks for being a Pro" : "Upgrade for more renders"
              }
              icon={Crown}
            />
          </>
        )}
      </div>

      {/* Recent render attempts. */}
      <Card>
        <CardHeader>
          <CardTitle>Recent renders</CardTitle>
          <CardDescription>
            Your latest render attempts across all projects.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {analyticsLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : recentRenders.length > 0 ? (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Project</TableHead>
                    <TableHead>Template</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Format</TableHead>
                    <TableHead className="text-right">Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentRenders.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium max-w-[14rem] truncate">
                        {r.projectName || `Project #${r.projectId}`}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {moduleLabel(r.module)}
                      </TableCell>
                      <TableCell>
                        <RenderStatusBadge status={r.status} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {r.format ? formatLabel(r.format) : "—"}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground tabular-nums">
                        {new Date(r.createdAt).toLocaleDateString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-8">
              No renders yet. Your render history will appear here.
            </p>
          )}
        </CardContent>
      </Card>
    </Layout>
  );
}
