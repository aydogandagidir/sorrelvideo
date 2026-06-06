import { Link } from "wouter";
import { Layout } from "@/components/layout";
import {
  useGetStats,
  useGetBillingInfo,
  useListProjects,
  useGetBrandKit,
  type Project,
  type BrandKit,
  type BillingInfo,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CompositionThumb,
  type CompositionLayout,
} from "@/components/composition";
import {
  Film,
  Video,
  Layers,
  Wand2,
  Palette,
  Play,
  ArrowRight,
  ChevronRight,
  Loader2,
  AlertCircle,
  type LucideIcon,
} from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

const DEFAULT_ACCENT = "#cdfb45";
const COMP_BG = "#0d1110";
const LAYOUTS: CompositionLayout[] = ["center", "grid", "stat", "quote"];

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/** Map a project + brand into composition props (real compositionVars). */
function thumbProps(project: Project, brand?: BrandKit) {
  const v = project.compositionVars ?? {};
  const company = brand?.companyName || "Sorrel";
  return {
    vars: {
      headline: v["user.headline"] || project.name,
      body: v["user.bodyText"] || "",
      cta: v["user.ctaText"] || "Learn more",
    },
    brand: { companyName: company, logoMark: company.charAt(0).toUpperCase() },
    accent: brand?.primaryColor || DEFAULT_ACCENT,
    bg: COMP_BG,
  };
}

function StatusDot({ status }: { status: string }) {
  const map: Record<string, { cls: string; label: string; live?: boolean }> = {
    ready: {
      cls: "bg-green-500/15 text-green-400 border-green-500/25",
      label: "Ready",
    },
    rendering: {
      cls: "bg-spark/15 text-spark border-spark/30",
      label: "Rendering",
      live: true,
    },
    failed: { cls: "bg-red-500/15 text-red-400 border-red-500/25", label: "Failed" },
    draft: {
      cls: "bg-secondary text-muted-foreground border-border",
      label: "Draft",
    },
  };
  const s = map[status] ?? map.draft;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        s.cls,
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full bg-current",
          s.live && "animate-pulse",
        )}
      />
      {s.label}
    </span>
  );
}

function ProjectThumb({
  project,
  brand,
  index,
}: {
  project: Project;
  brand?: BrandKit;
  index: number;
}) {
  const showImg = project.status === "ready" && project.thumbnailUrl;
  const props = thumbProps(project, brand);
  const layout = LAYOUTS[index % LAYOUTS.length];
  return (
    <Link href="/projects" className="group block">
      <div className="relative aspect-[9/16] overflow-hidden rounded-xl border bg-[#0d1110] transition-colors group-hover:border-primary/40">
        {showImg ? (
          <img
            src={project.thumbnailUrl ?? undefined}
            alt={project.name}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <CompositionThumb {...props} layout={layout} />
        )}
        {project.status === "rendering" && (
          <div className="absolute inset-0 grid place-items-center bg-black/55 backdrop-blur-[2px]">
            <div className="text-center text-white">
              <Loader2 className="mx-auto h-5 w-5 animate-spin text-spark" />
              <div className="mt-1.5 font-mono text-[10.5px]">
                {Math.round(project.renderProgress ?? 0)}%
              </div>
            </div>
          </div>
        )}
        <div className="absolute left-2 top-2">
          <StatusDot status={project.status} />
        </div>
      </div>
      <div className="mt-1.5 truncate text-[12.5px] font-semibold">
        {project.name}
      </div>
      <div className="text-[11px] text-muted-foreground">
        {new Date(project.updatedAt).toLocaleDateString()}
      </div>
    </Link>
  );
}

function StatTile({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  icon: LucideIcon;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2.5 p-4">
        <div className="flex items-center justify-between">
          <span className="text-[12.5px] font-medium text-muted-foreground">
            {label}
          </span>
          <span className="grid h-[30px] w-[30px] place-items-center rounded-lg bg-secondary text-muted-foreground">
            <Icon className="h-[15px] w-[15px]" />
          </span>
        </div>
        <span
          className="text-3xl font-semibold tabular-nums"
          style={{ fontFamily: "var(--font-display)", letterSpacing: "-.03em" }}
        >
          {value}
        </span>
      </CardContent>
    </Card>
  );
}

function QuotaRing({ billing }: { billing?: BillingInfo }) {
  const isPro = billing?.plan === "pro";
  const used = billing?.renderCount ?? 0;
  const limit = isPro ? null : (billing?.renderLimit ?? null);
  const pct = isPro ? 1 : limit && limit > 0 ? Math.min(1, used / limit) : 0;
  const R = 26;
  const C = 2 * Math.PI * R;
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-4">
        <div className="relative h-[68px] w-[68px] shrink-0">
          <svg width="68" height="68" viewBox="0 0 68 68" className="-rotate-90">
            <circle
              cx="34"
              cy="34"
              r={R}
              fill="none"
              stroke="hsl(var(--muted))"
              strokeWidth="7"
            />
            <circle
              cx="34"
              cy="34"
              r={R}
              fill="none"
              stroke="hsl(var(--primary))"
              strokeWidth="7"
              strokeLinecap="round"
              strokeDasharray={C}
              strokeDashoffset={C * (1 - pct)}
              style={{ transition: "stroke-dashoffset 1s ease" }}
            />
          </svg>
          <div className="absolute inset-0 grid place-items-center">
            <Film className="h-5 w-5 text-primary" />
          </div>
        </div>
        <div>
          <div className="text-[12.5px] text-muted-foreground">
            Renders this month
          </div>
          <div
            className="text-2xl font-semibold tabular-nums"
            style={{ fontFamily: "var(--font-display)" }}
          >
            {used}{" "}
            <span className="text-sm font-normal text-muted-foreground">
              / {isPro || limit == null ? "∞" : limit}
            </span>
          </div>
          <div className="mt-0.5 text-[11.5px] font-semibold text-primary">
            {isPro ? "Pro · unlimited" : "Free plan"}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function QuickAction({
  icon: Icon,
  label,
  desc,
  href,
}: {
  icon: LucideIcon;
  label: string;
  desc: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-lg border border-transparent px-2.5 py-2 transition-colors hover:border-border hover:bg-secondary"
    >
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-4 w-4" />
      </span>
      <span className="flex-1">
        <span className="block text-[13px] font-semibold">{label}</span>
        <span className="block text-[11.5px] text-muted-foreground">{desc}</span>
      </span>
      <ChevronRight className="h-[15px] w-[15px] text-muted-foreground/50" />
    </Link>
  );
}

export default function Dashboard() {
  const { data: stats, isLoading, isError } = useGetStats();
  const { data: billing } = useGetBillingInfo();
  const { data: projects } = useListProjects();
  const { data: brand } = useGetBrandKit();

  const rendering = projects?.find((p) => p.status === "rendering");
  const recent = projects?.slice(0, 4) ?? [];
  const latestReady = projects?.find((p) => p.status === "ready");

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
      <div className="mx-auto max-w-[1180px]">
        {/* Page head */}
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[27px] leading-tight">
              {greeting()} <span className="text-muted-foreground">👋</span>
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Here&apos;s what&apos;s moving in your workspace today.
            </p>
          </div>
          <div className="flex items-center gap-2.5">
            <Button variant="outline" asChild>
              <Link href="/brand">
                <Palette className="mr-2 h-4 w-4" /> Brand DNA
              </Link>
            </Button>
            <Button asChild>
              <Link href="/studio">
                <Wand2 className="mr-2 h-4 w-4" /> New video
              </Link>
            </Button>
          </div>
        </div>

        {/* Stat row */}
        <div className="mb-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <QuotaRing billing={billing} />
          {isLoading || !stats ? (
            Array.from({ length: 3 }).map((_, i) => (
              <Card key={i}>
                <CardContent className="p-4">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="mt-3 h-8 w-14" />
                </CardContent>
              </Card>
            ))
          ) : (
            <>
              <StatTile
                label="Videos shipped"
                value={stats.videosRendered}
                icon={Video}
              />
              <StatTile
                label="Projects"
                value={stats.totalProjects}
                icon={Film}
              />
              <StatTile
                label="Templates"
                value={stats.totalTemplates}
                icon={Layers}
              />
            </>
          )}
        </div>

        {/* Main grid */}
        <div className="grid gap-5 lg:grid-cols-[1.7fr_1fr]">
          {/* Recent renders */}
          <div>
            <div className="mb-3.5 flex items-center justify-between">
              <h2 className="text-base">Recent renders</h2>
              <Link
                href="/projects"
                className="flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
              >
                View all <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
            {isLoading ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="aspect-[9/16] w-full rounded-xl" />
                ))}
              </div>
            ) : recent.length ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {recent.map((p, i) => (
                  <ProjectThumb key={p.id} project={p} brand={brand} index={i} />
                ))}
              </div>
            ) : (
              <Card>
                <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
                  <Film className="h-8 w-8 text-muted-foreground/40" />
                  <p className="text-sm text-muted-foreground">
                    No renders yet — start in Studio.
                  </p>
                  <Button size="sm" asChild>
                    <Link href="/studio">
                      <Wand2 className="mr-2 h-4 w-4" /> New video
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Side column */}
          <div className="flex flex-col gap-5">
            {rendering && (
              <Card className="border-spark/20 bg-gradient-to-b from-spark/[0.08] to-transparent">
                <CardContent className="p-4">
                  <div className="mb-2.5 flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-spark/30 bg-spark/10 px-2 py-0.5 text-[11px] font-semibold text-spark">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                      RENDERING
                    </span>
                    <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
                      {Math.round(rendering.renderProgress ?? 0)}%
                    </span>
                  </div>
                  <div className="mb-2 truncate text-[13.5px] font-semibold">
                    {rendering.name}
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-spark/20">
                    <div
                      className="h-full rounded-full bg-spark transition-all"
                      style={{ width: `${rendering.renderProgress ?? 5}%` }}
                    />
                  </div>
                  <p className="mt-2 text-[11.5px] text-muted-foreground">
                    Chrome is rasterizing frames, FFmpeg will encode the mp4.
                  </p>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardContent className="p-4">
                <h2 className="mb-3 text-[15px]">Jump back in</h2>
                <div className="flex flex-col gap-1">
                  <QuickAction
                    icon={Wand2}
                    label="Compose a video"
                    desc="Headline, body, CTA → render"
                    href="/studio"
                  />
                  <QuickAction
                    icon={Layers}
                    label="Browse templates"
                    desc="Motion templates"
                    href="/templates"
                  />
                  <QuickAction
                    icon={Palette}
                    label="Tune your Brand DNA"
                    desc="Colors, type, voice"
                    href="/brand"
                  />
                </div>
              </CardContent>
            </Card>

            {latestReady && (
              <Card>
                <CardContent className="p-4">
                  <h2 className="mb-3 text-[15px]">Latest render</h2>
                  <div className="flex items-center gap-3">
                    <div className="relative aspect-[9/16] w-[54px] shrink-0 overflow-hidden rounded-lg border bg-[#0d1110]">
                      {latestReady.thumbnailUrl ? (
                        <img
                          src={latestReady.thumbnailUrl}
                          alt={latestReady.name}
                          className="absolute inset-0 h-full w-full object-cover"
                        />
                      ) : (
                        <CompositionThumb
                          {...thumbProps(latestReady, brand)}
                          layout="stat"
                        />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold">
                        {latestReady.name}
                      </div>
                      <div className="mt-1.5 flex gap-4">
                        <div>
                          <div
                            className="text-[17px] font-semibold tabular-nums"
                            style={{ fontFamily: "var(--font-display)" }}
                          >
                            {latestReady.duration ?? "—"}
                            {latestReady.duration ? "s" : ""}
                          </div>
                          <div className="text-[10.5px] text-muted-foreground">
                            duration
                          </div>
                        </div>
                        <div>
                          <div className="text-[13px] font-semibold capitalize text-primary">
                            {latestReady.module}
                          </div>
                          <div className="text-[10.5px] text-muted-foreground">
                            template
                          </div>
                        </div>
                      </div>
                    </div>
                    <Button variant="ghost" size="icon" asChild>
                      <Link href="/projects" aria-label="View render">
                        <Play className="h-4 w-4" fill="currentColor" />
                      </Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
}
