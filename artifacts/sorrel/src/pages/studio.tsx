import { useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { Loader2, Sparkles, Rocket } from "lucide-react";
import {
  useAiSuggest,
  useCreateProject,
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
import { CompositionPlayer } from "@/components/composition";
import {
  DEFAULT_RENDER_SETTINGS,
  proViolations,
  ASPECT_PRESETS,
  aspectRatioFor,
  baseAspect,
  type RenderSettings,
} from "@/lib/render-settings";
import { cn } from "@/lib/utils";
import { useBillingInfo } from "@/hooks/useBilling";

const DEFAULT_ACCENT = "#cdfb45";
const COMP_BG = "#0d1110";
const DEFAULT_HEADLINE = "Make something\nthey'll remember.";
const DEFAULT_BODY =
  "Sorrel turns a template, your brand kit, and a few sentences into branded video — ready to ship.";
const DEFAULT_CTA = "Try it free";

export default function StudioPage() {
  const [, setLocation] = useLocation();
  const { data: brandKit } = useGetBrandKit();
  const { data: billing } = useBillingInfo();
  const createProject = useCreateProject();
  const startRender = useStartProjectRender();
  const queryClient = useQueryClient();
  const updateRenderSettings = useUpdateProjectRenderSettings();
  const aiSuggest = useAiSuggest();

  const plan = billing?.plan ?? "free";

  const aiLimit = billing?.aiLimit ?? null;
  const aiCount = billing?.aiCount ?? 0;
  const aiRemaining = aiLimit != null ? Math.max(aiLimit - aiCount, 0) : null;
  const aiNearCap = aiRemaining != null && aiRemaining <= 2;

  const [name, setName] = useState("Untitled Studio Project");
  const [aiPrompt, setAiPrompt] = useState("");
  const [headline, setHeadline] = useState(DEFAULT_HEADLINE);
  const [bodyText, setBodyText] = useState(DEFAULT_BODY);
  const [ctaText, setCtaText] = useState(DEFAULT_CTA);
  const [renderSettings, setRenderSettings] = useState<RenderSettings>(
    DEFAULT_RENDER_SETTINGS,
  );
  const [error, setError] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [upgradeReason, setUpgradeReason] = useState<
    "render_limit" | "premium_template" | "ai_limit" | "render_quality"
  >("ai_limit");
  const [isSubmitting, setIsSubmitting] = useState(false);

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
  const previewAspect = aspectRatioFor(renderSettings.resolution);
  const selectedAspect = baseAspect(renderSettings.resolution);
  const ratioLabel =
    ASPECT_PRESETS.find((p) => p.value === selectedAspect)?.ratio ?? "9:16";
  const pickAspect = (value: RenderSettings["resolution"]) =>
    setRenderSettings((s) => ({ ...s, resolution: value }));

  async function handleAiSuggest() {
    setAiError(null);
    const trimmed = aiPrompt.trim();
    if (trimmed.length < 3) {
      setAiError("Tell the AI what you'd like a video about (min 3 chars).");
      return;
    }
    try {
      const result = await aiSuggest.mutateAsync({ data: { prompt: trimmed } });
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
      setAiError(anyErr.data?.error ?? anyErr.message ?? "AI suggestion failed");
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

    setIsSubmitting(true);
    try {
      const project = await createProject.mutateAsync({
        data: {
          name: name.trim() || "Untitled Studio Project",
          module: "studio",
          compositionVars,
        },
      });
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
            {/* AI brief */}
            <Card className="relative overflow-hidden border-primary/20 bg-gradient-to-b from-primary/[0.05] to-transparent">
              {aiSuggest.isPending && (
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
                    <div className="text-[13.5px] font-semibold">AI brief</div>
                    <div className="text-[11.5px] text-muted-foreground">
                      Describe it — we draft the headline, body &amp; CTA.
                    </div>
                  </div>
                </div>
                <Textarea
                  rows={2}
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  maxLength={500}
                  placeholder="e.g. promote our limited spring roast to existing subscribers"
                  disabled={aiSuggest.isPending}
                />
                {aiError && (
                  <p className="mt-2 text-sm text-destructive" role="alert">
                    {aiError}
                  </p>
                )}
                <div className="mt-2.5 flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    onClick={handleAiSuggest}
                    disabled={aiSuggest.isPending}
                  >
                    {aiSuggest.isPending ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" /> Drafting…
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-4 w-4" /> Fill with AI
                      </>
                    )}
                  </Button>
                  <span className="text-[11.5px] text-muted-foreground">
                    Brand voice:{" "}
                    <span className="capitalize text-foreground/80">
                      {brandKit?.brandVoice ?? "default"}
                    </span>
                  </span>
                </div>
                {aiRemaining != null && (
                  <p
                    className={`mt-2 text-xs ${aiNearCap ? "text-amber-500" : "text-muted-foreground"}`}
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
                    studio
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
                  <CompositionPlayer
                    vars={{ headline, body: bodyText, cta: ctaText }}
                    brand={brandForComp}
                    accent={accent}
                    bg={COMP_BG}
                    layout="center"
                    aspect={previewAspect}
                    ratioLabel={ratioLabel}
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
