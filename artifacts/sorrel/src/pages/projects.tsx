import React, { useState, useEffect, useRef } from "react";
import { useSearch } from "wouter";
import { cn } from "@/lib/utils";
import { Layout } from "@/components/layout";
import {
  useListProjects,
  useCreateProject,
  useDeleteProject,
  useStartProjectRender,
  useUpdateProjectRenderSettings,
  useGetBrandKit,
  getListProjectsQueryKey,
  type Project,
  type BrandKit,
} from "@workspace/api-client-react";
import {
  ASPECT_PRESETS,
  aspectRatioFor,
  baseAspect,
  DEFAULT_RENDER_SETTINGS,
} from "@/lib/render-settings";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CompositionThumb } from "@/components/composition";
import { HoverPlayVideo } from "@/components/hover-play-video";
import {
  AlertCircle,
  Film,
  Play,
  Trash2,
  Plus,
  Loader2,
  Clapperboard,
  Download,
  Share2,
  RotateCcw,
  Search,
  PencilRuler,
} from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { UpgradeModal } from "@/components/upgrade-modal";

const DEFAULT_ACCENT = "#cdfb45";
const COMP_BG = "#0d1110";
const FILTERS = ["All", "Ready", "Rendering", "Draft", "Failed"] as const;

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
 * The REAL captured-site screenshot a website→video project carries in its
 * compositionVars (a data URI). When present it is what the video actually
 * shows — so previews/placeholders render IT instead of the generic mock card
 * (which fabricates a letter badge + "Learn more" CTA and reads off-brand,
 * exactly the "this doesn't look like my site" complaint).
 */
function captureImageSrc(project: Project): string | null {
  const v = (project.compositionVars ?? {}) as Record<string, unknown>;
  const img = v["capture.image"];
  return typeof img === "string" && img.startsWith("data:image/") ? img : null;
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
    failed: {
      cls: "bg-red-500/15 text-red-400 border-red-500/25",
      label: "Failed",
    },
    draft: {
      cls: "bg-secondary text-muted-foreground border-border",
      label: "Draft",
    },
  };
  const s = map[status] ?? map.draft;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold backdrop-blur",
        s.cls,
      )}
    >
      <span
        className={cn("h-1.5 w-1.5 rounded-full bg-current", s.live && "animate-pulse")}
      />
      {s.label}
    </span>
  );
}

/** Poll the projects list every `intervalMs` while `active`. */
function useProjectPolling(active: boolean, intervalMs = 3000) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
    }, intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, queryClient]);
}

function RenderRing({ progress }: { progress: number }) {
  const C = 119; // 2πr, r=19
  return (
    <div className="relative h-[46px] w-[46px]">
      <svg width="46" height="46" viewBox="0 0 46 46" className="-rotate-90">
        <circle cx="23" cy="23" r="19" fill="none" stroke="rgba(255,255,255,.15)" strokeWidth="4" />
        <circle
          cx="23"
          cy="23"
          r="19"
          fill="none"
          stroke="hsl(var(--spark))"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - progress / 100)}
          style={{ transition: "stroke-dashoffset .5s ease" }}
        />
      </svg>
      <span className="absolute inset-0 grid place-items-center font-mono text-[11px] font-bold text-white">
        {Math.round(progress)}
      </span>
    </div>
  );
}

function ProjectCard({
  project,
  brand,
  focused,
  onOpen,
  index,
}: {
  project: Project;
  brand?: BrandKit;
  focused: boolean;
  onOpen: () => void;
  index: number;
}) {
  const isRendering = project.status === "rendering";
  useProjectPolling(isRendering);

  const cardRef = useRef<HTMLDivElement>(null);
  const didFocus = useRef(false);
  const [highlight, setHighlight] = useState(false);
  useEffect(() => {
    if (!focused || didFocus.current) return;
    didFocus.current = true;
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlight(true);
    const t = setTimeout(() => setHighlight(false), 2500);
    return () => clearTimeout(t);
  }, [focused]);

  const showImg = project.status === "ready" && project.thumbnailUrl;
  const layouts = ["center", "grid", "stat", "quote", "sweep"] as const;

  return (
    <div ref={cardRef}>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "block w-full text-left",
          "group/card transition-transform",
          highlight && "rounded-xl ring-2 ring-primary ring-offset-2 ring-offset-background",
        )}
      >
        <div className="relative aspect-[9/16] overflow-hidden rounded-xl border bg-[#0d1110] transition-all duration-200 group-hover/card:-translate-y-1 group-hover/card:border-primary/40 group-hover/card:shadow-xl">
          {project.status === "ready" ? (
            <HoverPlayVideo videoSrc={`/api/projects/${project.id}/video`}>
              {showImg ? (
                <img
                  src={project.thumbnailUrl ?? undefined}
                  alt={project.name}
                  className="absolute inset-0 h-full w-full object-cover"
                />
              ) : captureImageSrc(project) ? (
                <img
                  src={captureImageSrc(project) ?? undefined}
                  alt={project.name}
                  className="absolute inset-0 h-full w-full object-cover object-top"
                />
              ) : (
                <CompositionThumb
                  {...thumbProps(project, brand)}
                  layout={layouts[index % layouts.length]}
                />
              )}
            </HoverPlayVideo>
          ) : captureImageSrc(project) ? (
            <img
              src={captureImageSrc(project) ?? undefined}
              alt={project.name}
              className="absolute inset-0 h-full w-full object-cover object-top"
            />
          ) : (
            <CompositionThumb
              {...thumbProps(project, brand)}
              layout={layouts[index % layouts.length]}
            />
          )}

          {isRendering && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-black/60 backdrop-blur-[3px]">
              <RenderRing progress={project.renderProgress ?? 0} />
              <span className="text-[11px] font-semibold text-white/80">
                Rendering mp4…
              </span>
            </div>
          )}
          {project.status === "failed" && (
            <div className="absolute inset-0 grid place-items-center bg-black/55">
              <div className="text-center">
                <AlertCircle className="mx-auto h-5 w-5 text-red-400" />
                <div className="mt-1 text-[11px] text-white">Render failed</div>
              </div>
            </div>
          )}
          {project.status === "ready" && (
            <div className="pointer-events-none absolute inset-0 flex items-end justify-center bg-gradient-to-t from-black/70 to-transparent pb-4 opacity-0 transition-opacity group-hover/card:opacity-100">
              <span className="grid h-12 w-12 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg">
                <Play className="h-5 w-5" fill="currentColor" />
              </span>
            </div>
          )}

          <div className="pointer-events-none absolute left-2 top-2">
            <StatusDot status={project.status} />
          </div>
          {project.duration ? (
            <div className="pointer-events-none absolute right-2 top-2 rounded bg-black/45 px-1.5 py-0.5 font-mono text-[10px] font-bold text-white/85">
              {project.duration}s
            </div>
          ) : null}
        </div>
        <div className="mt-2">
          <div className="truncate text-[13px] font-semibold">{project.name}</div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>{new Date(project.updatedAt).toLocaleDateString()}</span>
            <span className="capitalize">· {project.module}</span>
          </div>
        </div>
      </button>
    </div>
  );
}

function ProjectDetail({
  project,
  brand,
  onClose,
}: {
  project: Project;
  brand?: BrandKit;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const deleteProject = useDeleteProject();
  const renderMutation = useStartProjectRender();
  const updateSettings = useUpdateProjectRenderSettings();
  const { toast } = useToast();
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [upgradeReason, setUpgradeReason] = useState<
    "render_limit" | "premium_template"
  >("render_limit");

  const isReady = project.status === "ready";
  const isRendering = project.status === "rendering";
  const videoSrc = project.videoUrl ?? `/api/projects/${project.id}/video`;
  const v = project.compositionVars ?? {};

  // Aspect ratio / publishing format (the project's render resolution).
  const settings = project.renderSettings ?? DEFAULT_RENDER_SETTINGS;
  const aspect = aspectRatioFor(settings.resolution);
  const selectedAspect = baseAspect(settings.resolution);
  const ratioLabel =
    ASPECT_PRESETS.find((p) => p.value === selectedAspect)?.ratio ?? "9:16";
  // Download/share name + MIME track the project's render format. png-sequence
  // streams as a zip (PR: png-seq download); every other format is a single
  // file with its own extension + MIME.
  const [downloadExt, downloadMime] = (
    {
      mp4: ["mp4", "video/mp4"],
      webm: ["webm", "video/webm"],
      mov: ["mov", "video/quicktime"],
      gif: ["gif", "image/gif"],
      "png-sequence": ["zip", "application/zip"],
    } as const
  )[settings.format];
  const baseName =
    (project.name || "video")
      .replace(/[^a-z0-9-_]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "video";
  const downloadName = `${baseName}.${downloadExt}`;

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });

  const handleRender = () =>
    renderMutation.mutate(
      { id: project.id },
      {
        onSuccess: invalidate,
        onError: (err) => {
          const e = err as {
            data?: { reason?: string; error?: string };
            status?: number;
          };
          if (e.data?.reason === "upgrade_required" || e.status === 403) {
            setUpgradeReason(
              (e.data?.error ?? "").toLowerCase().includes("template")
                ? "premium_template"
                : "render_limit",
            );
            setUpgradeOpen(true);
          }
        },
      },
    );

  const handleShare = async () => {
    if (typeof navigator !== "undefined" && typeof navigator.canShare === "function") {
      try {
        const res = await fetch(videoSrc, { credentials: "include" });
        if (res.ok) {
          const blob = await res.blob();
          const file = new File([blob], downloadName, { type: downloadMime });
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: project.name || "Sorrel video" });
            return;
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
      }
    }
    const link = `${window.location.origin}/projects?focus=${project.id}`;
    try {
      await navigator.clipboard.writeText(link);
      toast({ title: "Link copied", description: "Project link copied to your clipboard." });
    } catch {
      toast({ title: "Sharing isn't supported here", description: link });
    }
  };

  const changeAspect = (value: typeof settings.resolution) => {
    if (value === selectedAspect || updateSettings.isPending) return;
    updateSettings.mutate(
      { id: project.id, data: { ...settings, resolution: value } },
      {
        onSuccess: () => {
          invalidate();
          toast({
            title: "Format updated",
            description: isReady
              ? "Re-render to produce the new aspect ratio."
              : "Applied to your next render.",
          });
        },
        onError: () =>
          toast({
            title: "Couldn't change the format",
            description: "Please try again.",
          }),
      },
    );
  };

  // Portrait + square fit by height; landscape fits by width — so every aspect
  // lands as large as possible on the stage without distortion.
  const heightDriven = aspect !== "16 / 9";
  const playerSize = heightDriven
    ? "h-auto w-full max-w-[280px] md:h-full md:max-h-[74vh] md:w-auto md:max-w-none"
    : "h-auto w-full max-w-full";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-[1040px] gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">{project.name}</DialogTitle>
        <div className="grid md:h-[80vh] md:grid-cols-[1fr_360px]">
          {/* Cinematic stage: one large, height-driven player on a dark
              pasteboard, letterboxed (object-contain) so the portrait video
              glows — never a crop. min-w-0 stops a real <video>'s 1920px
              intrinsic width from blowing out the 1fr track (which would push
              the info panel past the modal's clipped edge). */}
          <div className="flex min-h-[55vh] min-w-0 items-center justify-center overflow-hidden bg-[#0b0f0d] p-6 md:min-h-0 md:p-8">
            {isReady ? (
              <video
                src={videoSrc}
                controls
                autoPlay
                playsInline
                style={{ aspectRatio: aspect }}
                className={cn(
                  "rounded-[16px] border border-primary/15 object-contain shadow-[0_24px_70px_rgba(0,0,0,.6)]",
                  playerSize,
                )}
              />
            ) : (
              <div
                style={{ aspectRatio: aspect }}
                className={cn(
                  "relative overflow-hidden rounded-[16px] border border-primary/15 shadow-[0_24px_70px_rgba(0,0,0,.6)]",
                  playerSize,
                )}
              >
                {captureImageSrc(project) ? (
                  // website→video: show the REAL captured site (what the video
                  // scrolls through), never the fabricated mock card.
                  <img
                    src={captureImageSrc(project) ?? undefined}
                    alt={project.name}
                    className="absolute inset-0 h-full w-full object-cover object-top"
                  />
                ) : (
                  <CompositionThumb {...thumbProps(project, brand)} chrome />
                )}
              </div>
            )}
          </div>
          {/* Meta + actions (scrolls independently on short viewports) */}
          <div className="flex min-w-0 flex-col gap-4 overflow-y-auto p-6 md:max-h-[80vh]">
            <div className="pr-8">
              <div className="mb-2">
                <StatusDot status={project.status} />
              </div>
              <h2 className="text-[22px] font-semibold">{project.name}</h2>
              <p className="mt-1 text-[12.5px] text-muted-foreground">
                Updated {new Date(project.updatedAt).toLocaleDateString()}
                {project.duration ? ` · ${project.duration}s` : ""} ·{" "}
                <span className="capitalize">{project.module}</span>
              </p>
            </div>

            {/* Format / platform — pick where this will be posted; sets the
                project's render aspect ratio. */}
            <div>
              <div className="mb-1.5 text-[11.5px] font-bold uppercase tracking-[0.08em] text-muted-foreground/70">
                Format
              </div>
              <div className="grid grid-cols-3 gap-2">
                {ASPECT_PRESETS.map((p) => {
                  const on = p.value === selectedAspect;
                  return (
                    <button
                      key={p.value}
                      type="button"
                      onClick={() => changeAspect(p.value)}
                      disabled={updateSettings.isPending}
                      className={cn(
                        "flex flex-col items-center gap-1.5 rounded-lg border p-2.5 text-center transition-colors disabled:opacity-60",
                        on
                          ? "border-primary bg-primary/10"
                          : "hover:border-primary/40",
                      )}
                    >
                      <span
                        className={cn(
                          "rounded-[3px] border-2",
                          on ? "border-primary" : "border-muted-foreground/50",
                          p.value === "portrait"
                            ? "h-5 w-3"
                            : p.value === "landscape"
                              ? "h-3 w-5"
                              : "h-4 w-4",
                        )}
                      />
                      <span
                        className={cn(
                          "font-mono text-[11px] font-semibold",
                          on && "text-primary",
                        )}
                      >
                        {p.ratio}
                      </span>
                      <span className="text-[9px] leading-tight text-muted-foreground">
                        {p.platforms}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Render-settings summary */}
            <div className="flex flex-wrap gap-1.5">
              {[
                ratioLabel,
                `${settings.fps} fps`,
                settings.quality.replace(/^\w/, (c) => c.toUpperCase()),
                settings.format.toUpperCase(),
              ].map((chip) => (
                <span
                  key={chip}
                  className="rounded-md border bg-secondary/40 px-2 py-1 text-[10.5px] font-medium text-muted-foreground"
                >
                  {chip}
                </span>
              ))}
            </div>

            {/* Brand */}
            {brand && (brand.companyName || brand.name) && (
              <div className="flex items-center gap-2.5 border-t pt-3">
                <span
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-[13px] font-bold"
                  style={{
                    background: brand.primaryColor || "#cdfb45",
                    color: "#0b0f0d",
                  }}
                >
                  {(brand.companyName || brand.name || "S").charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-[12.5px] font-semibold">
                    {brand.companyName || brand.name}
                  </div>
                  <div className="mt-1 flex gap-1">
                    {[
                      brand.primaryColor,
                      brand.secondaryColor,
                      brand.accentColor,
                    ]
                      .filter(Boolean)
                      .map((c, i) => (
                        <span
                          key={i}
                          className="h-3 w-3 rounded-full border border-white/10"
                          style={{ background: c as string }}
                        />
                      ))}
                  </div>
                </div>
              </div>
            )}

            {(v["user.headline"] || v["user.bodyText"] || v["user.ctaText"]) && (
              <div>
                <div className="mb-1.5 text-[11.5px] font-bold uppercase tracking-[0.08em] text-muted-foreground/70">
                  Copy
                </div>
                <div className="flex flex-col gap-2 text-[13.5px]">
                  {v["user.headline"] && (
                    <div>
                      <span className="text-muted-foreground">Headline · </span>
                      {v["user.headline"].replace(/\n/g, " ")}
                    </div>
                  )}
                  {v["user.bodyText"] && (
                    <div>
                      <span className="text-muted-foreground">Body · </span>
                      {v["user.bodyText"]}
                    </div>
                  )}
                  {v["user.ctaText"] && (
                    <div>
                      <span className="text-muted-foreground">CTA · </span>
                      <span className="font-semibold text-primary">
                        {v["user.ctaText"]}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {project.status === "failed" && project.renderError && (
              <p className="text-xs text-destructive">{project.renderError}</p>
            )}

            <div className="mt-auto flex flex-wrap gap-2 pt-2">
              {isReady && (
                <>
                  <Button asChild>
                    <a href={videoSrc} download={downloadName}>
                      <Download className="mr-2 h-4 w-4" />{" "}
                      {settings.format === "png-sequence"
                        ? "Download frames (.zip)"
                        : `Download ${downloadExt}`}
                    </a>
                  </Button>
                  <Button variant="outline" onClick={handleShare}>
                    <Share2 className="mr-2 h-4 w-4" /> Share
                  </Button>
                </>
              )}
              {(isReady || project.status === "failed") && (
                <Button
                  variant={project.status === "failed" ? "default" : "ghost"}
                  onClick={handleRender}
                  disabled={renderMutation.isPending}
                >
                  {renderMutation.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RotateCcw className="mr-2 h-4 w-4" />
                  )}
                  {project.status === "failed" ? "Retry render" : "Re-render"}
                </Button>
              )}
              {project.status === "draft" && (
                <Button onClick={handleRender} disabled={renderMutation.isPending}>
                  {renderMutation.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Clapperboard className="mr-2 h-4 w-4" />
                  )}
                  Render now
                </Button>
              )}
              {isRendering && (
                <Button variant="outline" disabled>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Rendering… {Math.round(project.renderProgress ?? 0)}%
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => {
                  window.location.href = `/editor/#project/${project.id}`;
                }}
              >
                <PencilRuler className="mr-2 h-4 w-4" /> Studio editor
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    disabled={isRendering}
                    aria-label="Delete project"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      Delete &ldquo;{project.name}&rdquo;?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      This permanently removes the project and its rendered
                      video. This can&rsquo;t be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={deleteProject.isPending}>
                      Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                      className={cn(buttonVariants({ variant: "destructive" }))}
                      onClick={() =>
                        deleteProject.mutate(
                          { id: project.id },
                          {
                            onSuccess: () => {
                              invalidate();
                              onClose();
                            },
                          },
                        )
                      }
                      disabled={deleteProject.isPending}
                    >
                      {deleteProject.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="mr-2 h-4 w-4" />
                      )}
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        </div>
      </DialogContent>
      <UpgradeModal
        open={upgradeOpen}
        onOpenChange={setUpgradeOpen}
        reason={upgradeReason}
      />
    </Dialog>
  );
}

export default function Projects() {
  const queryClient = useQueryClient();
  const { data: projects, isLoading, isError } = useListProjects();
  const { data: brand } = useGetBrandKit();
  const createProject = useCreateProject();
  const focusId = Number(new URLSearchParams(useSearch()).get("focus")) || null;

  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");
  const [detailId, setDetailId] = useState<number | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectModule, setNewProjectModule] = useState("studio");

  const hasRendering = projects?.some((p) => p.status === "rendering") ?? false;
  useProjectPolling(hasRendering);

  const readyCount = projects?.filter((p) => p.status === "ready").length ?? 0;
  const renderingCount =
    projects?.filter((p) => p.status === "rendering").length ?? 0;
  const filtered =
    filter === "All"
      ? (projects ?? [])
      : (projects ?? []).filter((p) => p.status === filter.toLowerCase());
  const detail = projects?.find((p) => p.id === detailId) ?? null;

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjectName) return;
    createProject.mutate(
      { data: { name: newProjectName, module: newProjectModule } },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
          setIsCreateOpen(false);
          setNewProjectName("");
        },
      },
    );
  };

  if (isError) {
    return (
      <Layout>
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>
            Failed to load projects. Please try again later.
          </AlertDescription>
        </Alert>
      </Layout>
    );
  }

  const total = projects?.length ?? 0;

  return (
    <Layout>
      <div className="mx-auto max-w-[1180px]">
        {/* Head */}
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[27px] leading-tight">Projects</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {total} videos · {readyCount} ready
              {renderingCount ? ` · ${renderingCount} rendering` : ""}
            </p>
          </div>
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" /> New video
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create New Project</DialogTitle>
                <DialogDescription>
                  Start a new video production project.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCreate}>
                <div className="grid gap-4 py-4">
                  <div className="grid gap-2">
                    <Label htmlFor="name">Project Name</Label>
                    <Input
                      id="name"
                      value={newProjectName}
                      onChange={(e) => setNewProjectName(e.target.value)}
                      placeholder="E.g., Q3 Marketing Promo"
                      autoFocus
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="module">Module</Label>
                    <select
                      id="module"
                      value={newProjectModule}
                      onChange={(e) => setNewProjectModule(e.target.value)}
                      className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                    >
                      <option value="studio">Studio</option>
                      <option value="ai">AI Gen</option>
                      <option value="bulk">Bulk Render</option>
                    </select>
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    type="submit"
                    disabled={!newProjectName || createProject.isPending}
                  >
                    {createProject.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : null}
                    Create Project
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        {/* Filters */}
        <div className="mb-5 flex flex-wrap items-center gap-2">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-[12.5px] font-semibold transition-colors",
                filter === f
                  ? "border-transparent bg-foreground text-background"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {f}
            </button>
          ))}
          <div className="ml-auto hidden h-[34px] w-[180px] items-center gap-2 rounded-md border bg-secondary px-2.5 text-muted-foreground sm:flex">
            <Search className="h-3.5 w-3.5" />
            <span className="text-[12.5px]">Filter projects…</span>
          </div>
        </div>

        {/* Grid */}
        {isLoading ? (
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[9/16] w-full rounded-xl" />
            ))}
          </div>
        ) : filtered.length ? (
          <div
            data-testid="projects-grid"
            className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5"
          >
            {filtered.map((p, i) => (
              <ProjectCard
                key={p.id}
                project={p}
                brand={brand}
                index={i}
                focused={p.id === focusId}
                onOpen={() => setDetailId(p.id)}
              />
            ))}
          </div>
        ) : total === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
              <Film className="h-8 w-8 text-muted-foreground/40" />
              <h3 className="text-lg font-medium">No projects yet</h3>
              <p className="m-0 max-w-sm text-sm text-muted-foreground">
                Create your first video project and hit <strong>Render</strong>{" "}
                to produce a video.
              </p>
              <Button onClick={() => setIsCreateOpen(true)}>
                <Plus className="mr-2 h-4 w-4" /> Create first project
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
              <Film className="h-8 w-8 text-muted-foreground/40" />
              <div className="font-semibold">
                No {filter.toLowerCase()} projects
              </div>
              <p className="m-0 text-sm text-muted-foreground">
                Try another filter or compose a new video.
              </p>
            </CardContent>
          </Card>
        )}

        {detail && (
          <ProjectDetail
            project={detail}
            brand={brand}
            onClose={() => setDetailId(null)}
          />
        )}
      </div>
    </Layout>
  );
}
