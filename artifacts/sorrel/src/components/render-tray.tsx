import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  useListProjects,
  useGetBrandKit,
  getListProjectsQueryKey,
  type Project,
  type BrandKit,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Check, ChevronUp, ArrowRight } from "lucide-react";
import { CompositionThumb } from "@/components/composition";
import { cn } from "@/lib/utils";

const DEFAULT_ACCENT = "#cdfb45";
const COMP_BG = "#0d1110";
const DONE_FLOURISH_MS = 4500;

function progressLabel(pct: number): string {
  if (pct < 25) return "Applying brand…";
  if (pct < 70) return "Rasterizing frames…";
  if (pct < 95) return "Encoding mp4…";
  return "Finalizing…";
}

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

/**
 * Global, persistent render-activity tray (bottom-right) — a faithful port of the
 * handoff's render-tray. Shows every in-flight render with live progress, and a
 * brief "Ready to ship" flourish the moment one completes. Wired to the real
 * project list (polls while anything is rendering); clicking a row jumps to it
 * in Projects.
 */
export function RenderTray() {
  const [location, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { data: projects } = useListProjects();
  const { data: brand } = useGetBrandKit();
  const [collapsed, setCollapsed] = useState(false);
  const [doneIds, setDoneIds] = useState<number[]>([]);

  const rendering = projects?.filter((p) => p.status === "rendering") ?? [];
  const renderingCount = rendering.length;

  // Poll the project list while anything is rendering so progress stays live
  // even on pages that don't poll themselves.
  useEffect(() => {
    if (renderingCount === 0) return;
    const timer = setInterval(() => {
      void queryClient.invalidateQueries({
        queryKey: getListProjectsQueryKey(),
      });
    }, 3000);
    return () => clearInterval(timer);
  }, [renderingCount, queryClient]);

  // Detect rendering → ready transitions and flourish the freshly-done ones.
  const prevRendering = useRef<number[]>([]);
  useEffect(() => {
    if (!projects) return;
    const cur = projects.filter((p) => p.status === "rendering").map((p) => p.id);
    const finished = prevRendering.current.filter((id) => {
      const p = projects.find((x) => x.id === id);
      return p && p.status === "ready";
    });
    if (finished.length) {
      setDoneIds((d) => [...new Set([...d, ...finished])]);
      finished.forEach((id) =>
        setTimeout(
          () => setDoneIds((d) => d.filter((x) => x !== id)),
          DONE_FLOURISH_MS,
        ),
      );
    }
    prevRendering.current = cur;
  }, [projects]);

  const doneProjects =
    projects?.filter((p) => doneIds.includes(p.id) && p.status === "ready") ?? [];

  // Rendering first, then the freshly-completed ones, de-duped.
  const seen = new Set<number>();
  const items = [...rendering, ...doneProjects].filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  // Redundant on the Projects page, which already lists every render in full.
  if (location.startsWith("/projects")) return null;
  if (items.length === 0) return null;

  return (
    <div className="fixed bottom-5 right-5 z-50 w-80 overflow-hidden rounded-xl border bg-card shadow-2xl duration-300 animate-in slide-in-from-bottom-2 fade-in">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className={cn(
          "flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left",
          !collapsed && "border-b",
        )}
      >
        <span className="grid h-[22px] w-[22px] place-items-center">
          {renderingCount > 0 ? (
            <Loader2 className="h-4 w-4 animate-spin text-spark" />
          ) : (
            <Check className="h-4 w-4 text-green-500" />
          )}
        </span>
        <span className="flex-1 text-[13px] font-semibold">
          {renderingCount > 0
            ? `Producing ${renderingCount} video${renderingCount > 1 ? "s" : ""}`
            : "Renders complete"}
        </span>
        {renderingCount > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-spark/30 bg-spark/10 px-2 py-0.5 text-[10px] font-semibold text-spark">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
            LIVE
          </span>
        )}
        <ChevronUp
          className={cn(
            "h-3.5 w-3.5 text-muted-foreground transition-transform",
            collapsed ? "rotate-180" : "",
          )}
        />
      </button>

      {!collapsed && (
        <div className="flex max-h-80 flex-col gap-1.5 overflow-y-auto p-2">
          {items.map((p) => {
            const done = !rendering.some((r) => r.id === p.id);
            const pct = Math.round(p.renderProgress ?? 0);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setLocation(`/projects?focus=${p.id}`)}
                className="flex items-center gap-3 rounded-lg border bg-background p-2 text-left transition-colors hover:border-primary/40"
              >
                <div className="relative h-[60px] w-[34px] shrink-0 overflow-hidden rounded-md border bg-[#0d1110]">
                  <CompositionThumb {...thumbProps(p, brand)} frame={0.62} />
                  {done && (
                    <div className="absolute inset-0 grid place-items-center bg-black/45 duration-300 animate-in fade-in">
                      <span className="grid h-5 w-5 place-items-center rounded-full bg-green-500 text-black duration-300 animate-in zoom-in">
                        <Check className="h-3 w-3" strokeWidth={3} />
                      </span>
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-semibold">
                    {p.name}
                  </div>
                  {done ? (
                    <div className="mt-0.5 flex items-center gap-1 text-[11px] font-semibold text-green-500">
                      Ready to ship <ArrowRight className="h-2.5 w-2.5" />
                    </div>
                  ) : (
                    <>
                      <div className="my-1 flex items-center justify-between text-[10.5px] text-muted-foreground">
                        <span>{progressLabel(pct)}</span>
                        <span className="font-mono tabular-nums">{pct}%</span>
                      </div>
                      <div className="h-1 overflow-hidden rounded-full bg-secondary">
                        <div
                          className="h-full rounded-full bg-spark transition-all duration-500"
                          style={{
                            width: `${pct}%`,
                            boxShadow: "0 0 8px hsl(var(--spark))",
                          }}
                        />
                      </div>
                    </>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
