import { useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { Loader2, Sparkles, Wand2 } from "lucide-react";
import {
  useAiSuggest,
  useCreateProject,
  useGetBrandKit,
  useStartProjectRender,
  useUpdateProjectRenderSettings,
} from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { UpgradeModal } from "@/components/upgrade-modal";
import { RenderSettingsForm } from "@/components/render-settings-form";
import {
  DEFAULT_RENDER_SETTINGS,
  proViolations,
  type RenderSettings,
} from "@/lib/render-settings";
import { useBillingInfo } from "@/hooks/useBilling";

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
  const updateRenderSettings = useUpdateProjectRenderSettings();
  const aiSuggest = useAiSuggest();

  const plan = billing?.plan ?? "free";

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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    // Eager client-side gate: a Free user who picked a Pro-only render setting
    // is nudged to upgrade before we create a draft. The server PATCH below is
    // still authoritative (handles the 403 path too).
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
          compositionVars: {
            "user.headline": headline,
            "user.bodyText": bodyText,
            "user.ctaText": ctaText,
          },
        },
      });
      // Persist the chosen render settings before rendering so the job picks
      // them up. The endpoint re-validates Pro gating server-side.
      await updateRenderSettings.mutateAsync({
        id: project.id,
        data: renderSettings,
      });
      // Kick off the render, then jump to Projects (which polls it to "ready").
      // Navigate only after the render call resolves so the card lands in
      // "rendering", not "draft".
      await startRender.mutateAsync({ id: project.id });
      setLocation(`/projects?focus=${project.id}`);
    } catch (err) {
      const anyErr = err as {
        status?: number;
        data?: { reason?: string; error?: string };
        message?: string;
      };
      const errorMsg = anyErr.data?.error ?? anyErr.message ?? "";
      // Render or render-settings blocked by plan limits — show the upgrade
      // modal in place. Any draft is already saved and waiting on Projects.
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
      // Surface upgrade_required as an upgrade modal; everything else as text.
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

  const swatches = [
    { label: "Primary", color: brandKit?.primaryColor ?? "#6366f1" },
    { label: "Secondary", color: brandKit?.secondaryColor ?? "#1e293b" },
    { label: "Accent", color: brandKit?.accentColor ?? "#f59e0b" },
  ];

  return (
    <Layout>
      <div className="container mx-auto p-6 lg:p-10 space-y-8">
        <header className="flex items-center gap-3">
          <Wand2 className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-semibold">Studio</h1>
            <p className="text-sm text-muted-foreground">
              Fill in a few lines, we&apos;ll apply your brand kit and render
              the video.
            </p>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Compose</CardTitle>
              <CardDescription>
                Write the brief yourself, or describe it to the AI and let it
                draft the copy.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2 rounded-lg border border-primary/20 bg-primary/5 p-4">
                <Label htmlFor="aiPrompt" className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-primary" />
                  AI brief
                </Label>
                <Textarea
                  id="aiPrompt"
                  rows={2}
                  placeholder="e.g. promote our new Q3 marketing automation product to small-business owners"
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  maxLength={500}
                  disabled={aiSuggest.isPending}
                />
                {aiError && (
                  <p className="text-sm text-destructive" role="alert">
                    {aiError}
                  </p>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleAiSuggest}
                  disabled={aiSuggest.isPending}
                >
                  {aiSuggest.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Generating…
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-4 w-4" />
                      Fill with AI
                    </>
                  )}
                </Button>
              </div>

              <form onSubmit={handleSubmit} className="space-y-5" noValidate>
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

                <div className="space-y-4 border-t pt-5">
                  <div>
                    <h2 className="text-sm font-semibold">Render settings</h2>
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
                </div>

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
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Working…
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-4 w-4" />
                      Create &amp; render
                    </>
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Brand preview</CardTitle>
              <CardDescription>
                Edit on the Brand Kit page — Studio + AI pull live values at
                render time.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                  Company
                </p>
                <p className="text-lg font-semibold">
                  {brandKit?.companyName ?? "Your Brand"}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                  Palette
                </p>
                <div className="flex gap-2">
                  {swatches.map((s) => (
                    <div
                      key={s.label}
                      className="flex flex-col items-center gap-1"
                    >
                      <span
                        className="h-12 w-12 rounded-md border"
                        style={{ background: s.color }}
                        title={s.color}
                        aria-label={`${s.label} swatch`}
                      />
                      <span className="text-[10px] text-muted-foreground">
                        {s.label}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                  Voice
                </p>
                <p className="text-sm capitalize">
                  {brandKit?.brandVoice ?? "—"}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                  Font
                </p>
                <p
                  className="text-base"
                  style={{ fontFamily: brandKit?.fontFamily ?? "Inter" }}
                >
                  {brandKit?.fontFamily ?? "Inter"} — quick brown fox
                </p>
              </div>
            </CardContent>
          </Card>
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
