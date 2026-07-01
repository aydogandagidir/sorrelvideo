import { useMemo, useState, useRef, type FormEvent, type ChangeEvent } from "react";
import { useLocation } from "wouter";
import {
  Loader2,
  Sparkles,
  Rocket,
  Film,
  Trash2,
  LayoutTemplate,
} from "lucide-react";
import { useUpload } from "@workspace/object-storage-web";
import {
  useAiSuggest,
  useAiEdit,
  useCreateProject,
  useGenerateProjectAiImage,
  useGetBrandKit,
  useStartProjectRender,
  useUpdateProjectRenderSettings,
  getListProjectsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { UpgradeModal } from "@/components/upgrade-modal";
import { RenderSettingsForm } from "@/components/render-settings-form";
import { AiQuickEdits } from "@/components/ai-quick-edits";
import { HfPlayer } from "@/components/hf-player";
import {
  DEFAULT_RENDER_SETTINGS,
  proViolations,
  ASPECT_PRESETS,
  baseAspect,
  type RenderSettings,
} from "@/lib/render-settings";
import { cn } from "@/lib/utils";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { b64UrlVars } from "@/lib/preview-vars";
import { useBillingInfo } from "@/hooks/useBilling";
import { useToast } from "@/hooks/use-toast";

const DEFAULT_ACCENT = "#cdfb45";
const COMP_BG = "#0d1110";
const DEFAULT_HEADLINE = "Make something\nthey'll remember.";
const DEFAULT_BODY =
  "Sorrel turns a template, your brand kit, and a few sentences into branded video — ready to ship.";
const DEFAULT_CTA = "Try it free";

/**
 * The copy-compatible templates the Studio page can produce: every one takes the
 * same headline + body + CTA and the user's brand, so the Compose fields and the
 * live preview map 1:1 across them (verified against each composition's
 * `{{user.*}}` keys + the render COMPOSITION_MAP). All are Free; only Brand Story
 * is multi-scene, so only it exposes the transition picker. A spotlight clip is a
 * separate path that forces the Video Spotlight template (see below).
 */
const STUDIO_TEMPLATES = [
  {
    module: "studio",
    name: "Studio",
    blurb: "Clean headline, body & CTA",
    supportsTransitions: false,
  },
  {
    module: "product-launch",
    name: "Product Launch",
    blurb: "Bold product reveal",
    supportsTransitions: false,
  },
  {
    module: "brand-promo",
    name: "Brand Promo",
    blurb: "Punchy brand moment",
    supportsTransitions: false,
  },
  {
    module: "social-teaser",
    name: "Social Teaser",
    blurb: "Short scroll-stopping hook",
    supportsTransitions: false,
  },
  {
    module: "brand-story",
    name: "Brand Story",
    blurb: "Two scenes + a transition",
    supportsTransitions: true,
  },
] as const;

type StudioModule = (typeof STUDIO_TEMPLATES)[number]["module"];

/**
 * Modules that host an AI background layer — mirrors the server's
 * AI_BACKGROUND_MODULES (services/aiBackgroundTemplates.ts). Every STUDIO_TEMPLATES
 * copy module currently supports it; the spotlight-clip path (video-spotlight)
 * does not, so the control is hidden when a clip is attached.
 */
const AI_BG_MODULES = new Set<StudioModule>([
  "studio",
  "product-launch",
  "brand-promo",
  "social-teaser",
  "brand-story",
]);

export default function StudioPage() {
  const [, setLocation] = useLocation();
  const { data: brandKit } = useGetBrandKit();
  const { data: billing } = useBillingInfo();
  const createProject = useCreateProject();
  const aiImage = useGenerateProjectAiImage();
  const { toast } = useToast();
  const startRender = useStartProjectRender();
  const queryClient = useQueryClient();
  const updateRenderSettings = useUpdateProjectRenderSettings();
  const aiSuggest = useAiSuggest();
  const aiEdit = useAiEdit();
  // One spinner for both AI actions — they share the card's button + overlay.
  const isAiPending = aiSuggest.isPending || aiEdit.isPending;

  const plan = billing?.plan ?? "free";

  const aiLimit = billing?.aiLimit ?? null;
  const aiCount = billing?.aiCount ?? 0;
  const aiRemaining = aiLimit != null ? Math.max(aiLimit - aiCount, 0) : null;
  const aiNearCap = aiRemaining != null && aiRemaining <= 2;

  const [name, setName] = useState("Untitled Studio Project");
  // "draft" → write copy from a brief (/ai/suggest); "edit" → revise the current
  // copy per an instruction (/ai/edit). Same card, same quota, same undo.
  const [aiMode, setAiMode] = useState<"draft" | "edit">("draft");
  const [aiPrompt, setAiPrompt] = useState("");
  // Optional AI background brief — generated AFTER create (needs a project id),
  // before the auto-render, so it bakes into the first render.
  const [aiBgPrompt, setAiBgPrompt] = useState("");
  const [headline, setHeadline] = useState(DEFAULT_HEADLINE);
  const [bodyText, setBodyText] = useState(DEFAULT_BODY);
  const [ctaText, setCtaText] = useState(DEFAULT_CTA);
  const [renderSettings, setRenderSettings] = useState<RenderSettings>(
    DEFAULT_RENDER_SETTINGS,
  );
  // Which copy-compatible template to produce (STUDIO_TEMPLATES). A spotlight
  // clip overrides this with the Video Spotlight template.
  const [selectedModule, setSelectedModule] = useState<StudioModule>("studio");
  const [error, setError] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [upgradeReason, setUpgradeReason] = useState<
    "render_limit" | "premium_template" | "ai_limit" | "render_quality"
  >("ai_limit");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [aiUndo, setAiUndo] = useState<{
    headline: string;
    bodyText: string;
    ctaText: string;
  } | null>(null);

  // Optional spotlight clip (Track D): when attached, the project is created
  // from the video-spotlight template with the clip pinned as
  // compositionVars["capture.videoObject"]; the render path composites it.
  const [spotlightClip, setSpotlightClip] = useState<{
    objectPath: string;
    name: string;
  } | null>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const {
    uploadFile: uploadClip,
    isUploading: clipUploading,
    error: clipError,
  } = useUpload({
    onSuccess: (res) =>
      setSpotlightClip({ objectPath: res.objectPath, name: res.metadata.name }),
  });
  function pickClip() {
    // Video spotlight is a Pro (premium template) feature.
    if (plan !== "pro") {
      setUpgradeReason("premium_template");
      setShowUpgrade(true);
      return;
    }
    videoInputRef.current?.click();
  }
  async function onClipFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (file) await uploadClip(file);
  }

  const compositionVars: Record<string, string> = {
    "user.headline": headline,
    "user.bodyText": bodyText,
    "user.ctaText": ctaText,
  };

  const accent = brandKit?.primaryColor || DEFAULT_ACCENT;
  const company = brandKit?.companyName || "Your Brand";
  const brandForComp = {
    companyName: company,
    logoMark: company.charAt(0).toUpperCase(),
  };

  // Aspect ratio / publishing format drives both the render resolution and the
  // live preview frame, so the user sees exactly the shape they'll publish.
  const selectedAspect = baseAspect(renderSettings.resolution);
  const ratioLabel =
    ASPECT_PRESETS.find((p) => p.value === selectedAspect)?.ratio ?? "9:16";
  const pickAspect = (value: RenderSettings["resolution"]) =>
    setRenderSettings((s) => ({ ...s, resolution: value }));

  // The template actually produced: a spotlight clip forces Video Spotlight,
  // otherwise the picked copy template. Only multi-scene templates expose the
  // transition picker, and switching to one that can't use transitions clears a
  // stale value so it never lingers in settings.
  const effectiveModule = spotlightClip ? "video-spotlight" : selectedModule;
  const supportsTransitions =
    !spotlightClip &&
    (STUDIO_TEMPLATES.find((t) => t.module === selectedModule)
      ?.supportsTransitions ??
      false);
  // AI background is offered for the copy templates (all support the layer); a
  // spotlight clip forces video-spotlight, which does not host it.
  const supportsAiBg = !spotlightClip && AI_BG_MODULES.has(selectedModule);

  function pickTemplate(module: StudioModule) {
    setSelectedModule(module);
    const supports =
      STUDIO_TEMPLATES.find((t) => t.module === module)?.supportsTransitions ??
      false;
    if (!supports) setRenderSettings((s) => ({ ...s, transitions: undefined }));
  }

  // Live preview: render the REAL composition module via the module-keyed
  // preview route (no project id exists until submit; a spotlight clip's hero is
  // materialized only at render time). Debounce the user.* vars so a burst of
  // keystrokes is one composition fetch; a changed `src` reloads the iframe.
  // Memoize the vars object so its identity is stable while the copy is
  // unchanged — otherwise a fresh literal every render keeps `useDebouncedValue`
  // from ever settling, which re-renders the page every 600ms forever.
  const previewVarsInput = useMemo(
    () => ({ "user.headline": headline, "user.bodyText": bodyText, "user.ctaText": ctaText }),
    [headline, bodyText, ctaText],
  );
  const previewVars = useDebouncedValue(previewVarsInput, 600);
  const previewSrc = `/api/compositions/${effectiveModule}/preview?resolution=${selectedAspect}&vars=${b64UrlVars(previewVars)}`;

  function undoAiFill() {
    if (!aiUndo) return;
    setHeadline(aiUndo.headline);
    setBodyText(aiUndo.bodyText);
    setCtaText(aiUndo.ctaText);
    setAiUndo(null);
  }

  async function handleAiAction(explicitInstruction?: string) {
    setAiError(null);
    // A quick-edit chip passes its instruction directly and is always an edit;
    // the button uses the textarea + the Draft/Edit toggle.
    const isQuickEdit = explicitInstruction !== undefined;
    const doEdit = isQuickEdit || aiMode === "edit";
    const trimmed = (explicitInstruction ?? aiPrompt).trim();
    if (trimmed.length < 3) {
      setAiError(
        doEdit
          ? "Tell the AI what to change (min 3 chars)."
          : "Tell the AI what you'd like a video about (min 3 chars).",
      );
      return;
    }
    try {
      // Draft writes from a brief; edit revises the copy that's on screen now.
      const result = doEdit
        ? await aiEdit.mutateAsync({
            data: {
              instruction: trimmed,
              current: { headline, bodyText, ctaText },
            },
          })
        : await aiSuggest.mutateAsync({ data: { prompt: trimmed } });
      // Stash the pre-change copy so a one-click overwrite is undoable.
      setAiUndo({ headline, bodyText, ctaText });
      setHeadline(result.headline);
      setBodyText(result.bodyText);
      setCtaText(result.ctaText);
    } catch (err) {
      const anyErr = err as {
        status?: number;
        data?: { reason?: string; error?: string };
        message?: string;
      };
      if (anyErr.status === 403 && anyErr.data?.reason === "upgrade_required") {
        setUpgradeReason("ai_limit");
        setShowUpgrade(true);
        return;
      }
      if (anyErr.status === 429) {
        setAiError("Slow down a bit — try again in a minute.");
        return;
      }
      setAiError(
        anyErr.data?.error ??
          anyErr.message ??
          (doEdit ? "AI edit failed" : "AI suggestion failed"),
      );
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (plan !== "pro" && proViolations(renderSettings).length > 0) {
      setUpgradeReason("render_quality");
      setShowUpgrade(true);
      return;
    }
    if (spotlightClip && plan !== "pro") {
      setUpgradeReason("premium_template");
      setShowUpgrade(true);
      return;
    }

    setIsSubmitting(true);
    try {
      const project = await createProject.mutateAsync({
        data: {
          name: name.trim() || "Untitled Studio Project",
          module: effectiveModule,
          compositionVars: spotlightClip
            ? {
                ...compositionVars,
                "capture.videoObject": spotlightClip.objectPath,
              }
            : compositionVars,
        },
      });
      // Optional AI background: needs the project id and must land BEFORE the
      // auto-render so it bakes into the first render. Best-effort — a quota /
      // provider failure must not block the video; render it without the
      // background and tell the user (a toast survives the navigation below).
      if (supportsAiBg && aiBgPrompt.trim()) {
        try {
          await aiImage.mutateAsync({
            id: project.id,
            data: { prompt: aiBgPrompt.trim() },
          });
        } catch (bgErr) {
          const e = bgErr as { status?: number; data?: { reason?: string } };
          toast({
            title:
              e.status === 403 && e.data?.reason === "upgrade_required"
                ? "AI arka plan atlandı — AI limitin dolu"
                : "AI arka plan üretilemedi — video arka plansız oluşturuldu",
            variant: "destructive",
          });
        }
      }
      await updateRenderSettings.mutateAsync({
        id: project.id,
        data: renderSettings,
      });
      await startRender.mutateAsync({ id: project.id });
      // Prime the shared project cache so the global RenderTray's poll wakes
      // immediately (it only starts polling once it sees a rendering project).
      await queryClient.invalidateQueries({
        queryKey: getListProjectsQueryKey(),
      });
      setLocation(`/projects?focus=${project.id}`);
    } catch (err) {
      const anyErr = err as {
        status?: number;
        data?: { reason?: string; error?: string };
        message?: string;
      };
      const errorMsg = anyErr.data?.error ?? anyErr.message ?? "";
      if (anyErr.status === 403 && anyErr.data?.reason === "upgrade_required") {
        const lower = errorMsg.toLowerCase();
        setUpgradeReason(
          lower.includes("template")
            ? "premium_template"
            : lower.includes("pro plan")
              ? "render_quality"
              : "render_limit",
        );
        setShowUpgrade(true);
        return;
      }
      if (anyErr.status === 429) {
        setError("Slow down a bit — try again in a minute.");
        return;
      }
      setError(errorMsg || "Could not create or render project");
    } finally {
      setIsSubmitting(false);
    }
  }

  const swatches = [
    brandKit?.primaryColor ?? "#6366f1",
    brandKit?.secondaryColor ?? "#1e293b",
    brandKit?.accentColor ?? "#f59e0b",
  ];

  return (
    <Layout>
      <div className="mx-auto max-w-[1180px]">
        {/* Page head */}
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[27px] leading-tight">Studio</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Write a few lines — Sorrel applies your Brand DNA and renders a
              vertical video.
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-[11.5px] font-semibold text-primary">
            <Sparkles className="h-3.5 w-3.5" /> AI ready
          </span>
        </div>

        <div className="grid items-start gap-5 lg:grid-cols-[1.55fr_1fr]">
          {/* Compose column */}
          <div className="flex flex-col gap-5">
            {/* Template picker — the copy-compatible templates Studio can make */}
            <Card>
              <CardContent className="p-4">
                <div className="mb-2.5 flex items-center gap-2">
                  <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary/15 text-primary">
                    <LayoutTemplate className="h-4 w-4" />
                  </span>
                  <div>
                    <div className="text-[13.5px] font-semibold">Template</div>
                    <div className="text-[11.5px] text-muted-foreground">
                      Pick a style — your copy &amp; brand fill it in.
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {STUDIO_TEMPLATES.map((t) => {
                    const on = !spotlightClip && t.module === selectedModule;
                    return (
                      <button
                        key={t.module}
                        type="button"
                        onClick={() => pickTemplate(t.module)}
                        disabled={!!spotlightClip}
                        aria-pressed={on}
                        className={cn(
                          "rounded-lg border p-2.5 text-left transition-colors disabled:opacity-50",
                          on
                            ? "border-primary bg-primary/10"
                            : "hover:border-primary/40",
                        )}
                      >
                        <div
                          className={cn(
                            "text-[12.5px] font-semibold",
                            on && "text-primary",
                          )}
                        >
                          {t.name}
                        </div>
                        <div className="text-[10.5px] text-muted-foreground">
                          {t.blurb}
                        </div>
                      </button>
                    );
                  })}
                </div>
                {spotlightClip && (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Your spotlight clip uses the Video Spotlight template — remove
                    it to pick another.
                  </p>
                )}
              </CardContent>
            </Card>

            {/* AI brief */}
            <Card className="relative overflow-hidden border-primary/20 bg-gradient-to-b from-primary/[0.05] to-transparent">
              {isAiPending && (
                <div
                  className="pointer-events-none absolute inset-0"
                  style={{
                    background:
                      "linear-gradient(90deg, transparent, hsl(var(--primary)/0.12), transparent)",
                    backgroundSize: "200% 100%",
                    animation: "shimmer 1.2s linear infinite",
                  }}
                />
              )}
              <CardContent className="p-4">
                <div className="mb-2.5 flex items-center gap-2">
                  <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary/15 text-primary">
                    <Sparkles className="h-4 w-4" />
                  </span>
                  <div>
                    <div className="text-[13.5px] font-semibold">
                      {aiMode === "edit" ? "AI edit" : "AI brief"}
                    </div>
                    <div className="text-[11.5px] text-muted-foreground">
                      {aiMode === "edit"
                        ? "Tell us what to change — we revise your current copy."
                        : "Describe it — we draft the headline, body & CTA."}
                    </div>
                  </div>
                  {/* Draft (write from a brief) vs Edit (revise current copy) */}
                  <div
                    className="ml-auto inline-flex rounded-lg border p-0.5 text-[11.5px] font-semibold"
                    role="tablist"
                    aria-label="AI mode"
                  >
                    {(["draft", "edit"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        role="tab"
                        aria-selected={aiMode === m}
                        onClick={() => {
                          setAiMode(m);
                          setAiError(null);
                        }}
                        className={cn(
                          "rounded-md px-2.5 py-1 capitalize transition-colors",
                          aiMode === m
                            ? "bg-primary/15 text-primary"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>
                <Textarea
                  rows={2}
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  maxLength={500}
                  placeholder={
                    aiMode === "edit"
                      ? "e.g. make the headline punchier and mention free shipping"
                      : "e.g. promote our limited spring roast to existing subscribers"
                  }
                  disabled={isAiPending}
                />
                {aiMode === "edit" && (
                  <div className="mt-2">
                    <AiQuickEdits
                      onPick={(ins) => void handleAiAction(ins)}
                      disabled={isAiPending}
                    />
                  </div>
                )}
                {aiError && (
                  <p className="mt-2 text-sm text-destructive" role="alert">
                    {aiError}
                  </p>
                )}
                <div className="mt-2.5 flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    onClick={() => void handleAiAction()}
                    disabled={isAiPending}
                  >
                    {isAiPending ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {aiMode === "edit" ? "Editing…" : "Drafting…"}
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-4 w-4" />
                        {aiMode === "edit" ? "Edit with AI" : "Fill with AI"}
                      </>
                    )}
                  </Button>
                  {aiUndo && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={undoAiFill}
                    >
                      Undo AI change
                    </Button>
                  )}
                  <span className="text-[11.5px] text-muted-foreground">
                    Brand voice:{" "}
                    <span className="capitalize text-foreground/80">
                      {brandKit?.brandVoice ?? "default"}
                    </span>
                  </span>
                </div>
                {aiRemaining != null && (
                  <p
                    className={`mt-2 text-xs ${aiNearCap ? "text-warning" : "text-muted-foreground"}`}
                  >
                    {aiRemaining > 0
                      ? `${aiRemaining} AI ${aiRemaining === 1 ? "draft" : "drafts"} left this month`
                      : "You're out of AI drafts this month — upgrade to Pro for unlimited."}
                  </p>
                )}
              </CardContent>
            </Card>

            <form onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate>
              {/* Compose */}
              <Card>
                <CardContent className="flex flex-col gap-4 p-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-[15px]">Compose</h2>
                    <span className="text-[11.5px] text-muted-foreground">
                      Edits reflect live →
                    </span>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="name">Project name</Label>
                    <Input
                      id="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      maxLength={120}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="headline">Headline</Label>
                    <Textarea
                      id="headline"
                      rows={2}
                      value={headline}
                      onChange={(e) => setHeadline(e.target.value)}
                      maxLength={140}
                    />
                    <p className="text-xs text-muted-foreground">
                      Line breaks render as a new line in the video.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="bodyText">Body</Label>
                    <Textarea
                      id="bodyText"
                      rows={3}
                      value={bodyText}
                      onChange={(e) => setBodyText(e.target.value)}
                      maxLength={400}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ctaText">Call to action</Label>
                    <Input
                      id="ctaText"
                      value={ctaText}
                      onChange={(e) => setCtaText(e.target.value)}
                      maxLength={48}
                    />
                  </div>
                  {supportsAiBg && (
                    <div className="space-y-2">
                      <Label htmlFor="aiBg" className="flex items-center gap-1.5">
                        <Sparkles className="h-3.5 w-3.5 text-primary" /> AI arka
                        plan{" "}
                        <span className="font-normal text-muted-foreground">
                          (opsiyonel)
                        </span>
                      </Label>
                      <Textarea
                        id="aiBg"
                        rows={2}
                        value={aiBgPrompt}
                        onChange={(e) => setAiBgPrompt(e.target.value)}
                        maxLength={500}
                        placeholder="örn. koyu degrade üzerinde soyut yeşil ışık çizgileri"
                      />
                      <p className="text-[11.5px] text-muted-foreground">
                        Oluştururken markana uygun bir görsel üretilip yazının
                        arkasına konur (canlı önizlemede görünmez).
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Spotlight clip (optional, Pro — Track D) */}
              <Card>
                <CardContent className="flex flex-col gap-3 p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Film className="h-4 w-4 text-primary" />
                      <h2 className="text-[15px]">Spotlight clip</h2>
                      {plan !== "pro" && (
                        <span className="rounded border px-1.5 py-0 text-[10px] font-semibold text-muted-foreground">
                          Pro
                        </span>
                      )}
                    </div>
                    {spotlightClip && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setSpotlightClip(null)}
                        aria-label="Remove clip"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                  <input
                    ref={videoInputRef}
                    type="file"
                    accept="video/mp4,video/quicktime,video/webm"
                    className="hidden"
                    onChange={onClipFile}
                  />
                  {spotlightClip ? (
                    <p className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {spotlightClip.name}
                      </span>{" "}
                      — rendered as the hero behind your headline. Uses the Video
                      Spotlight template.
                    </p>
                  ) : (
                    <div className="space-y-1.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={pickClip}
                        disabled={isSubmitting || clipUploading}
                      >
                        <Film className="h-4 w-4" />
                        {clipUploading ? "Uploading…" : "Upload a clip"}
                      </Button>
                      {clipError && (
                        <p className="text-xs text-destructive">
                          {clipError.message}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        Optional. MP4/MOV/WebM — your footage becomes the hero,
                        framed with your brand.
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Render settings */}
              <Card>
                <CardContent className="flex flex-col gap-4 p-4">
                  <div>
                    <h2 className="text-[15px]">Render settings</h2>
                    <p className="text-xs text-muted-foreground">
                      Output format, quality, and transitions for this render.
                    </p>
                  </div>
                  <RenderSettingsForm
                    value={renderSettings}
                    onChange={setRenderSettings}
                    plan={plan}
                    disabled={isSubmitting}
                    // Only multi-scene templates can composite a transition. The
                    // picker enables it for Brand Story and disables it for the
                    // single-scene templates (and the spotlight-clip path).
                    supportsTransitions={supportsTransitions}
                    onUpgrade={() => {
                      setUpgradeReason("render_quality");
                      setShowUpgrade(true);
                    }}
                  />
                </CardContent>
              </Card>

              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              <Button
                type="submit"
                size="lg"
                className="w-full"
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Queuing render…
                  </>
                ) : (
                  <>
                    <Rocket className="h-4 w-4" /> Create &amp; render
                  </>
                )}
              </Button>
            </form>
          </div>

          {/* Preview column */}
          <div className="flex flex-col gap-5 lg:sticky lg:top-20">
            <Card>
              <CardContent className="flex flex-col gap-3 p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <h2 className="text-[15px]">Live preview</h2>
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                      LIVE
                    </span>
                  </div>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {effectiveModule}
                  </span>
                </div>
                {/* Format / platform — sets the render aspect AND the preview shape */}
                <div className="flex flex-wrap justify-center gap-2">
                  {ASPECT_PRESETS.map((p) => {
                    const on = p.value === selectedAspect;
                    return (
                      <button
                        key={p.value}
                        type="button"
                        onClick={() => pickAspect(p.value)}
                        className={cn(
                          "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-left transition-colors",
                          on
                            ? "border-primary bg-primary/10"
                            : "hover:border-primary/40",
                        )}
                      >
                        <span
                          className={cn(
                            "rounded-[2px] border-2",
                            on ? "border-primary" : "border-muted-foreground/50",
                            p.value === "portrait"
                              ? "h-4 w-2.5"
                              : p.value === "landscape"
                                ? "h-2.5 w-4"
                                : "h-3.5 w-3.5",
                          )}
                        />
                        <span className="leading-tight">
                          <span
                            className={cn(
                              "block font-mono text-[11px] font-semibold",
                              on && "text-primary",
                            )}
                          >
                            {p.ratio}
                          </span>
                          <span className="block text-[9px] text-muted-foreground">
                            {p.label}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="mx-auto w-full max-w-[300px] md:max-w-[380px] lg:max-w-[420px]">
                  {/* No autoplay/loop: the composition's t=0 frame is its
                      intro-start (all copy at opacity 0 — a dark frame), so an
                      auto-loop strobes dark→content→dark every cycle. Held at
                      its content-visible CSS default instead; `controls` lets
                      the user play/scrub the intro on demand (matches the
                      projects detail preview). */}
                  <HfPlayer
                    src={previewSrc}
                    aspect={ratioLabel}
                    muted
                    controls
                    className="w-full overflow-hidden rounded-xl border"
                  />
                </div>
                <p className="m-0 text-center text-[11.5px] text-muted-foreground">
                  This is the live template, not the final mp4. Scrub before you
                  spend a render.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="flex flex-col gap-3 p-4">
                <h2 className="text-sm">Brand DNA applied</h2>
                <div className="flex items-center gap-2.5">
                  <div
                    className="grid h-[34px] w-[34px] place-items-center rounded-lg font-bold"
                    style={{
                      background: accent,
                      color: COMP_BG,
                      fontFamily: "var(--font-display)",
                    }}
                  >
                    {brandForComp.logoMark}
                  </div>
                  <div>
                    <div className="text-[13px] font-semibold">{company}</div>
                    <div className="text-[11px] capitalize text-muted-foreground">
                      {brandKit?.fontFamily ?? "Inter"} ·{" "}
                      {brandKit?.brandVoice ?? "default"}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setLocation("/brand")}
                    className="ml-auto text-xs font-semibold text-primary"
                  >
                    Edit
                  </button>
                </div>
                <div className="flex gap-1.5">
                  {swatches.map((c, i) => (
                    <div
                      key={i}
                      className="h-[30px] flex-1 rounded-md border"
                      style={{ background: c }}
                    />
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
      <UpgradeModal
        open={showUpgrade}
        onOpenChange={setShowUpgrade}
        reason={upgradeReason}
      />
    </Layout>
  );
}
