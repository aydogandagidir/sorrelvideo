import React, { useRef, useState } from "react";
import { Layout } from "@/components/layout";
import { useListTemplates, useUseTemplate } from "@workspace/api-client-react";
import type { Template } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, Clock, Loader2, Lock, Play, Zap } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { UpgradeModal } from "@/components/upgrade-modal";
import { HfPlayer, type HfPlayerHandle } from "@/components/hf-player";
import { useBillingInfo } from "@/hooks/useBilling";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

// Platform templates are seeded from the Apache-2.0 Hyperframes registry. Each
// template's `module` maps to a composition the backend serves at
// /api/templates/:id/composition for the live hover-preview; "Use Template"
// creates a project from it via POST /api/templates/:id/use.

function compositionSrc(templateId: number): string {
  return `/api/templates/${templateId}/composition`;
}

function TemplateCard({
  template,
  isPro,
  onLockedClick,
  onUse,
  using,
}: {
  template: Template;
  isPro: boolean;
  onLockedClick: () => void;
  onUse: () => void;
  using: boolean;
}): React.JSX.Element {
  const playerRef = useRef<HfPlayerHandle>(null);
  const [activated, setActivated] = useState(false);
  const [playing, setPlaying] = useState(false);
  const locked = template.isPremium && !isPro;
  // A "demo" template carries no brand/content placeholders (customizable === false)
  // — it renders a fixed sample regardless of brand/content; label it honestly.
  const isDemo = template.customizable === false;

  function startPreview(): void {
    setActivated(true);
    playerRef.current?.play();
    setPlaying(true);
  }
  function stopPreview(): void {
    playerRef.current?.pause();
    setPlaying(false);
  }

  return (
    <Card className="group flex flex-col overflow-hidden p-0 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg">
      {/* Live-preview media: hover/focus plays the real composition over the
          static thumbnail poster. */}
      <div
        className="relative aspect-[9/16] w-full overflow-hidden bg-[#0d1110]"
        onPointerEnter={startPreview}
        onPointerLeave={stopPreview}
        onFocus={startPreview}
        onBlur={stopPreview}
        tabIndex={0}
        role="img"
        aria-label={`${template.name} preview`}
      >
        {template.thumbnailUrl ? (
          <img
            src={template.thumbnailUrl}
            alt=""
            aria-hidden="true"
            // The gallery now lists ~75 templates; lazy/async decoding keeps
            // off-screen posters from all fetching+decoding on first paint.
            loading="lazy"
            decoding="async"
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
            No preview
          </div>
        )}

        {activated && (
          <div
            className={cn(
              "absolute inset-0 transition-opacity duration-200",
              playing ? "opacity-100" : "opacity-0",
            )}
          >
            <HfPlayer
              ref={playerRef}
              src={compositionSrc(template.id)}
              muted
              loop
              autoplay
              controls={false}
              aspect="9:16"
              className="h-full w-full rounded-none border-0"
              onReady={() => setPlaying(true)}
            />
          </div>
        )}

        {/* Badges */}
        <div className="absolute left-2.5 top-2.5 flex gap-1.5">
          <span className="rounded-full border border-border bg-black/45 px-2 py-0.5 text-[11px] font-semibold capitalize text-white/90 backdrop-blur">
            {template.category}
          </span>
          {isDemo && (
            <span className="rounded-full border border-warning/30 bg-warning/15 px-2 py-0.5 text-[11px] font-semibold text-warning backdrop-blur">
              Demo
            </span>
          )}
          {template.isPremium && (
            <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary backdrop-blur">
              <Zap className="h-3 w-3" /> Premium
            </span>
          )}
        </div>
        <div className="absolute right-2.5 top-2.5 rounded bg-black/45 px-1.5 py-0.5 font-mono text-[10px] font-bold text-white/85">
          {template.duration}s
        </div>

        {/* Hover-to-preview hint */}
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/60 to-transparent p-2 text-xs font-medium text-white transition-opacity",
            playing ? "opacity-0" : "opacity-100 group-hover:opacity-0",
          )}
        >
          <Play className="h-3 w-3 fill-current" /> Hover to preview
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col gap-1.5 p-3.5">
        <div className="text-sm font-semibold">{template.name}</div>
        <p className="line-clamp-2 min-h-[2.4em] text-[12px] leading-snug text-muted-foreground">
          {template.description || "No description provided."}
        </p>
        {isDemo && (
          <p className="text-[11px] leading-snug text-warning/90">
            Renders a fixed sample — open in Studio to edit its code/content.
          </p>
        )}
        <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
          <Clock className="h-3 w-3" />
          {template.duration}s
        </div>
        <div className="mt-2">
          {locked ? (
            <Button className="w-full" variant="outline" onClick={onLockedClick}>
              <Lock className="mr-2 h-4 w-4" /> Unlock Template
            </Button>
          ) : (
            <Button className="w-full" onClick={onUse} disabled={using}>
              {using ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creating…
                </>
              ) : (
                "Use Template"
              )}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

export default function Templates() {
  const { data: templates, isLoading, isError } = useListTemplates();
  const { data: billing } = useBillingInfo();
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [category, setCategory] = useState("All");
  const [showDemos, setShowDemos] = useState(false);
  const isPro = billing?.plan === "pro";
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const useTemplateMut = useUseTemplate({
    mutation: {
      onSuccess: (project) => setLocation(`/projects?focus=${project.id}`),
      onError: () =>
        toast({
          variant: "destructive",
          title: "Couldn't create the project",
          description: "Please try again in a moment.",
        }),
    },
  });

  const categories = [
    "All",
    ...Array.from(new Set((templates ?? []).map((t) => t.category))),
  ];
  const inCategory =
    category === "All"
      ? (templates ?? [])
      : (templates ?? []).filter((t) => t.category === category);
  // "Demo" templates carry no brand/content placeholders, so they render a fixed
  // sample regardless of brand/content. Hide them by default — "Use Template"
  // then surfaces only templates that produce a TAILORED video; a toggle reveals
  // the demos (labeled) for use as code starting points in Studio.
  const demoCount = inCategory.filter((t) => t.customizable === false).length;
  const list = showDemos
    ? inCategory
    : inCategory.filter((t) => t.customizable !== false);

  if (isError) {
    return (
      <Layout>
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>
            Failed to load templates. Please try again later.
          </AlertDescription>
        </Alert>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="mx-auto max-w-[1180px]">
        <div className="mb-6">
          <h1 className="text-[27px] leading-tight">Templates</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Motion templates rendered by the Hyperframes engine. Customizable
            templates flow your Brand DNA + copy in automatically; “Demo”
            templates render a fixed sample you can then edit in Studio.
          </p>
        </div>

        {!isLoading && templates?.length ? (
          <div className="mb-5 flex flex-wrap gap-2">
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={category === c}
                onClick={() => setCategory(c)}
                className={cn(
                  "rounded-full border px-3.5 py-1.5 text-[12.5px] font-semibold capitalize transition-colors",
                  category === c
                    ? "border-transparent bg-foreground text-background"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {c}
              </button>
            ))}
          </div>
        ) : null}

        {!isLoading && demoCount > 0 ? (
          <div className="mb-5 -mt-2.5">
            <button
              type="button"
              onClick={() => setShowDemos((v) => !v)}
              className="text-[12.5px] font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {showDemos
                ? "Hide demo templates"
                : `Show ${demoCount} demo template${demoCount === 1 ? "" : "s"} (fixed sample — edit in Studio)`}
            </button>
          </div>
        ) : null}

        {isLoading ? (
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Card key={i} className="overflow-hidden p-0">
                <Skeleton className="aspect-[9/16] w-full rounded-none" />
                <div className="space-y-2 p-3.5">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-9 w-full" />
                </div>
              </Card>
            ))}
          </div>
        ) : list.length ? (
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-4">
            {list.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                isPro={isPro}
                onLockedClick={() => setUpgradeOpen(true)}
                onUse={() => useTemplateMut.mutate({ id: template.id })}
                using={
                  useTemplateMut.isPending &&
                  useTemplateMut.variables?.id === template.id
                }
              />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed py-12 text-center text-muted-foreground">
            No templates found.
          </div>
        )}
      </div>

      <UpgradeModal
        open={upgradeOpen}
        onOpenChange={setUpgradeOpen}
        reason="premium_template"
      />
    </Layout>
  );
}
