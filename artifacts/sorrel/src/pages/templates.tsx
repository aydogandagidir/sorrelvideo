import React, { useRef, useState } from "react";
import { Layout } from "@/components/layout";
import { useListTemplates } from "@workspace/api-client-react";
import type { Template } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, Clock, Lock, Play, Tag } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { UpgradeModal } from "@/components/upgrade-modal";
import { HfPlayer, type HfPlayerHandle } from "@/components/hf-player";
import { useBillingInfo } from "@/hooks/useBilling";

// NOTE: importing the 9 official Hyperframes starter compositions is DEFERRED —
// their HTML isn't vendored into this repo yet and sourcing them needs an
// asset/licensing decision. This wave wires live hover-preview for Sorrel's
// EXISTING templates/compositions only (each template's `module` maps to a
// composition the backend serves at /api/templates/:id/composition).

/** Backend live-preview endpoint for a template's brand-neutral base composition. */
function compositionSrc(templateId: number): string {
  return `/api/templates/${templateId}/composition`;
}

/**
 * One gallery card. Owns its own hover/focus state and an imperative handle to
 * its <HfPlayer> so hovering plays the live composition and leaving pauses it.
 *
 * The player is LAZY-mounted: it only mounts on first hover/focus (then stays
 * mounted, just play/pause toggled) so the gallery doesn't spin up an iframe per
 * template on initial load. Until then — and as the poster underneath the player
 * — we show the existing static thumbnail.
 */
function TemplateCard({
  template,
  isPro,
  onLockedClick,
}: {
  template: Template;
  isPro: boolean;
  onLockedClick: () => void;
}): React.JSX.Element {
  const playerRef = useRef<HfPlayerHandle>(null);
  // Mount the player only after the card has been hovered/focused once.
  const [activated, setActivated] = useState(false);
  // Drives the crossfade: reveal the player only once it's actually playing.
  const [playing, setPlaying] = useState(false);

  const locked = template.isPremium && !isPro;

  function startPreview(): void {
    setActivated(true);
    // If already mounted, kick playback immediately; a freshly-mounted player
    // autoplays on ready (see autoplay prop), so this is a no-op the first time.
    playerRef.current?.play();
    setPlaying(true);
  }

  function stopPreview(): void {
    playerRef.current?.pause();
    setPlaying(false);
  }

  return (
    <Card className="overflow-hidden flex flex-col transition-all hover:border-primary/50">
      {/* Live-preview media region. Group hover/focus toggles playback; the
          player crossfades in over the static thumbnail poster. Keyboard users
          get the same behavior via focus/blur, and a visible "hover to preview"
          affordance keeps it discoverable. */}
      <div
        className="group relative w-full overflow-hidden bg-muted aspect-[9/16] max-h-72"
        onPointerEnter={startPreview}
        onPointerLeave={stopPreview}
        onFocus={startPreview}
        onBlur={stopPreview}
        tabIndex={0}
        role="img"
        aria-label={`${template.name} preview`}
      >
        {/* Poster: the existing static thumbnail, always rendered underneath. */}
        {template.thumbnailUrl ? (
          <img
            src={template.thumbnailUrl}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 object-cover w-full h-full"
          />
        ) : (
          <div className="absolute inset-0 w-full h-full flex items-center justify-center text-muted-foreground">
            No preview
          </div>
        )}

        {/* The live composition player, mounted lazily on first interaction and
            faded in only once it's playing so we never flash a loading frame. */}
        {activated && (
          <div
            className={
              "absolute inset-0 transition-opacity duration-200 " +
              (playing ? "opacity-100" : "opacity-0")
            }
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

        {/* Hover hint — hidden while the live preview is showing. */}
        <div
          className={
            "pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 p-2 text-xs font-medium text-white bg-gradient-to-t from-black/60 to-transparent transition-opacity " +
            (playing ? "opacity-0" : "opacity-100 group-hover:opacity-0")
          }
        >
          <Play className="h-3 w-3 fill-current" />
          Hover to preview
        </div>

        {template.isPremium && (
          <Badge className="absolute top-3 right-3 bg-primary text-primary-foreground">Premium</Badge>
        )}
      </div>

      <CardHeader>
        <CardTitle className="line-clamp-1">{template.name}</CardTitle>
        <CardDescription className="line-clamp-2 min-h-10">
          {template.description || "No description provided."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1">
        <div className="flex flex-wrap gap-2 mb-4">
          <Badge variant="outline" className="capitalize">{template.module}</Badge>
          <Badge variant="secondary" className="capitalize">{template.category}</Badge>
        </div>
        <div className="flex items-center text-sm text-muted-foreground gap-4">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {template.duration}s
          </span>
          {template.tags && template.tags.length > 0 && (
            <span className="flex items-center gap-1 line-clamp-1">
              <Tag className="h-3 w-3" />
              {template.tags.join(", ")}
            </span>
          )}
        </div>
      </CardContent>
      <CardFooter className="pt-0">
        {locked ? (
          <Button className="w-full" variant="outline" onClick={onLockedClick}>
            <Lock className="mr-2 h-4 w-4" />
            Unlock Template
          </Button>
        ) : (
          <Button className="w-full">Use Template</Button>
        )}
      </CardFooter>
    </Card>
  );
}

export default function Templates() {
  const { data: templates, isLoading, isError } = useListTemplates();
  const { data: billing } = useBillingInfo();
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const isPro = billing?.plan === "pro";

  if (isError) {
    return (
      <Layout>
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>Failed to load templates. Please try again later.</AlertDescription>
        </Alert>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Templates</h1>
          <p className="text-muted-foreground">Browse and use predefined video layouts.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {isLoading ? (
          Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="overflow-hidden flex flex-col">
              <Skeleton className="aspect-[9/16] max-h-72 w-full rounded-none" />
              <CardHeader>
                <Skeleton className="h-5 w-2/3 mb-2" />
                <Skeleton className="h-4 w-full" />
              </CardHeader>
              <CardContent className="flex-1">
                <div className="flex gap-2">
                  <Skeleton className="h-5 w-16 rounded-full" />
                  <Skeleton className="h-5 w-16 rounded-full" />
                </div>
              </CardContent>
            </Card>
          ))
        ) : templates?.length ? (
          templates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              isPro={isPro}
              onLockedClick={() => setUpgradeOpen(true)}
            />
          ))
        ) : (
          <div className="col-span-full text-center py-12 text-muted-foreground border rounded-lg border-dashed">
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
