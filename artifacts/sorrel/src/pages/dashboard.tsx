import { Link } from "wouter";
import { Layout } from "@/components/layout";
import {
  useGetStats,
  useGetBillingInfo,
  useListProjects,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Film,
  Video,
  Plus,
  Layers,
  Wand2,
  AlertCircle,
  Sparkles,
  Clapperboard,
  Palette,
  Globe,
  ArrowRight,
  Loader2,
  Crown,
  type LucideIcon,
} from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

/** SVG progress ring — the signature dashboard quota dial. */
function QuotaRing({
  used,
  limit,
}: {
  used: number;
  limit: number | null | undefined;
}) {
  const unlimited = limit == null;
  const pct = unlimited
    ? 100
    : limit > 0
      ? Math.min(100, Math.round((used / limit) * 100))
      : 0;
  const R = 54;
  const C = 2 * Math.PI * R;
  const dash = (pct / 100) * C;
  const near = !unlimited && pct >= 80;
  return (
    <div className="relative h-32 w-32 shrink-0">
      <svg viewBox="0 0 128 128" className="h-full w-full -rotate-90">
        <circle
          cx="64"
          cy="64"
          r={R}
          fill="none"
          stroke="hsl(var(--muted))"
          strokeWidth={11}
        />
        <circle
          cx="64"
          cy="64"
          r={R}
          fill="none"
          stroke={near ? "hsl(var(--spark))" : "hsl(var(--primary))"}
          strokeWidth={11}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${C}`}
          className="transition-all duration-700"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono text-3xl font-bold tabular-nums leading-none">
          {unlimited ? "∞" : used}
        </span>
        <span className="mt-1 text-[11px] text-muted-foreground">
          {unlimited ? "renders" : `of ${limit}`}
        </span>
      </div>
    </div>
  );
}

function StatTile({
  title,
  value,
  icon: Icon,
  hint,
  href,
}: {
  title: string;
  value: string | number;
  icon: LucideIcon;
  hint: string;
  href: string;
}) {
  return (
    <Link href={href}>
      <Card className="group h-full cursor-pointer transition-colors hover:border-primary/40">
        <CardContent className="p-5">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">{title}</span>
            <Icon className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-primary" />
          </div>
          <div className="mt-3 font-mono text-3xl font-bold tabular-nums">
            {value}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
        </CardContent>
      </Card>
    </Link>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    ready: "bg-green-500/10 text-green-500 border-green-500/20",
    rendering: "bg-spark/10 text-spark border-spark/25 animate-pulse",
    failed: "bg-red-500/10 text-red-500 border-red-500/20",
    draft: "bg-secondary text-muted-foreground border-border",
  };
  return (
    <Badge className={cn("capitalize", map[status] ?? map.draft)}>
      {status}
    </Badge>
  );
}

const QUICK_ACTIONS = [
  { href: "/studio", label: "Open Studio", icon: Wand2 },
  { href: "/website-to-video", label: "Website → Video", icon: Globe },
  { href: "/templates", label: "Browse Templates", icon: Layers },
  { href: "/brand", label: "Edit Brand DNA", icon: Palette },
] as const;

export default function Dashboard() {
  const { data: stats, isLoading, isError } = useGetStats();
  const { data: billing } = useGetBillingInfo();
  const { data: projects } = useListProjects();

  const isPro = billing?.plan === "pro";
  const renderUsed = billing?.renderCount ?? 0;
  const renderLimit = isPro ? null : (billing?.renderLimit ?? null);
  const aiUsed = billing?.aiCount ?? 0;
  const aiLimit = isPro ? null : (billing?.aiLimit ?? null);
  const aiPct =
    aiLimit && aiLimit > 0 ? Math.min(100, (aiUsed / aiLimit) * 100) : 100;

  const liveRender = projects?.find((p) => p.status === "rendering");

  if (isError) {
    return (
      <Layout>
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>
            Failed to load dashboard statistics. Please try again later.
          </AlertDescription>
        </Alert>
      </Layout>
    );
  }

  return (
    <Layout>
      {/* Hero */}
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
            <Badge
              className={cn(
                "gap-1",
                isPro
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : "border-border bg-secondary text-muted-foreground",
              )}
            >
              {isPro && <Crown className="h-3 w-3" />}
              {isPro ? "Pro" : "Free"}
            </Badge>
          </div>
          <p className="text-muted-foreground">
            Welcome back — compose, render and ship branded short-form video.
          </p>
        </div>
        <div className="flex gap-3">
          <Button variant="outline" asChild>
            <Link href="/projects">
              <Plus className="mr-2 h-4 w-4" /> New Project
            </Link>
          </Button>
          <Button asChild>
            <Link href="/studio">
              <Wand2 className="mr-2 h-4 w-4" /> Open Studio
            </Link>
          </Button>
        </div>
      </div>

      {/* Top row: quota dial + stat tiles */}
      <div className="mb-6 grid gap-5 lg:grid-cols-3">
        <Card className="lg:row-span-1">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Render quota</CardTitle>
            <CardDescription>
              {isPro ? "Pro — unlimited renders" : "Resets monthly"}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex items-center gap-5">
            <QuotaRing used={renderUsed} limit={renderLimit} />
            <div className="min-w-0 flex-1 space-y-3">
              <div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Sparkles className="h-3 w-3" /> AI suggestions
                  </span>
                  <span className="font-mono tabular-nums">
                    {aiUsed}
                    {aiLimit != null ? `/${aiLimit}` : ""}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${aiPct}%` }}
                  />
                </div>
              </div>
              {!isPro ? (
                <Button size="sm" variant="outline" className="w-full" asChild>
                  <Link href="/settings">
                    <Crown className="mr-2 h-3.5 w-3.5" /> Upgrade to Pro
                  </Link>
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Unlimited AI &amp; renders, 4K export, no watermark.
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-2 gap-5 lg:col-span-2">
          {isLoading || !stats ? (
            Array.from({ length: 4 }).map((_, i) => (
              <Card key={i}>
                <CardContent className="p-5">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="mt-3 h-8 w-14" />
                  <Skeleton className="mt-2 h-3 w-24" />
                </CardContent>
              </Card>
            ))
          ) : (
            <>
              <StatTile
                title="Projects"
                value={stats.totalProjects}
                icon={Film}
                hint="Active video projects"
                href="/projects"
              />
              <StatTile
                title="Rendered"
                value={stats.videosRendered}
                icon={Video}
                hint="Completed videos"
                href="/projects"
              />
              <StatTile
                title="Templates"
                value={stats.totalTemplates}
                icon={Layers}
                hint="Ready to use"
                href="/templates"
              />
              <StatTile
                title="Modules"
                value={stats.activeModules}
                icon={Plus}
                hint="Enabled features"
                href="/modules"
              />
            </>
          )}
        </div>
      </div>

      {/* Live render spark card */}
      {liveRender && (
        <Card className="mb-6 border-spark/30 bg-spark/[0.04]">
          <CardContent className="flex items-center gap-4 p-5">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-spark/10">
              <Loader2 className="h-5 w-5 animate-spin text-spark" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Rendering now</span>
                <span className="truncate text-sm text-muted-foreground">
                  {liveRender.name}
                </span>
              </div>
              <div className="mt-2 h-1.5 w-full max-w-md overflow-hidden rounded-full bg-spark/20">
                <div
                  className={cn(
                    "h-full rounded-full bg-spark",
                    typeof liveRender.renderProgress !== "number" &&
                      "w-1/3 animate-pulse",
                  )}
                  style={
                    typeof liveRender.renderProgress === "number"
                      ? { width: `${liveRender.renderProgress}%` }
                      : undefined
                  }
                />
              </div>
            </div>
            <Button variant="outline" size="sm" asChild>
              <Link href="/projects">View</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Recent renders + quick actions */}
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle>Recent renders</CardTitle>
              <CardDescription>Your latest video projects.</CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/projects">
                All <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : stats?.recentProjects?.length ? (
              <div className="space-y-1">
                {stats.recentProjects.map((project) => (
                  <Link
                    key={project.id}
                    href="/projects"
                    className="flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-secondary/60"
                  >
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
                      <Clapperboard className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {project.name}
                      </div>
                      <div className="truncate text-xs capitalize text-muted-foreground">
                        {project.module}
                      </div>
                    </div>
                    <StatusBadge status={project.status} />
                  </Link>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 py-10 text-center">
                <Clapperboard className="h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  No renders yet — start in Studio.
                </p>
                <Button size="sm" asChild>
                  <Link href="/studio">
                    <Wand2 className="mr-2 h-4 w-4" /> Open Studio
                  </Link>
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quick actions</CardTitle>
            <CardDescription>Jump back into the loop.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {QUICK_ACTIONS.map((a) => (
              <Button
                key={a.href}
                variant="outline"
                className="justify-start"
                asChild
              >
                <Link href={a.href}>
                  <a.icon className="mr-2 h-4 w-4 text-primary" />
                  {a.label}
                </Link>
              </Button>
            ))}
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
