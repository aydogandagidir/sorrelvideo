import React, { useState, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import { Layout } from "@/components/layout";
import {
  useListBrandKits,
  useCreateBrandKit,
  useUpdateBrandKitById,
  useDeleteBrandKit,
  useExtractBrand,
  useGenerateVideoIdeas,
  useCreateProject,
  getListBrandKitsQueryKey,
  type BrandKit,
  type BrandKitInput,
  type VideoIdea,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertCircle,
  Save,
  Loader2,
  Image as ImageIcon,
  Sparkles,
  Plus,
  Trash2,
  Star,
  Check,
  Dna,
  Clapperboard,
  X,
} from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { CompositionThumb } from "@/components/composition";
import { cn } from "@/lib/utils";

type Voice = "" | "professional" | "playful" | "bold" | "minimal";

interface FormState {
  name: string;
  companyName: string;
  tagline: string;
  description: string;
  valueProposition: string;
  targetAudience: string;
  industry: string;
  imageStyle: string;
  keywords: string[];
  personality: string[];
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  fontFamily: string;
  logoUrl: string;
  brandVoice: Voice;
  voiceDescription: string;
  sourceUrl: string;
}

const BLANK: FormState = {
  name: "My brand",
  companyName: "",
  tagline: "",
  description: "",
  valueProposition: "",
  targetAudience: "",
  industry: "",
  imageStyle: "",
  keywords: [],
  personality: [],
  primaryColor: "#6366f1",
  secondaryColor: "#1e293b",
  accentColor: "#f59e0b",
  fontFamily: "Inter",
  logoUrl: "",
  brandVoice: "",
  voiceDescription: "",
  sourceUrl: "",
};

const HANDOFF_FONTS = ["Space Grotesk", "Inter", "Space Mono"];
const QUICK_PALETTES: [string, string, string][] = [
  ["#cdfb45", "#0d1110", "#ff4d1c"],
  ["#7cdcff", "#0a1016", "#ff8fab"],
  ["#f5d76e", "#14110a", "#4ade80"],
  ["#c084fc", "#120a16", "#cdfb45"],
];

/** One key→value row in the live-preview summary. */
function Row({ k, v, font }: { k: string; v: string; font?: string }) {
  return (
    <div className="flex items-center justify-between text-[12.5px]">
      <span className="text-muted-foreground">{k}</span>
      <span
        className="font-semibold capitalize"
        style={font ? { fontFamily: font } : undefined}
      >
        {v}
      </span>
    </div>
  );
}

function toForm(kit: BrandKit): FormState {
  return {
    name: kit.name || "Brand kit",
    companyName: kit.companyName || "",
    tagline: kit.tagline || "",
    description: kit.description || "",
    valueProposition: kit.valueProposition || "",
    targetAudience: kit.targetAudience || "",
    industry: kit.industry || "",
    imageStyle: kit.imageStyle || "",
    keywords: kit.keywords ?? [],
    personality: kit.personality ?? [],
    primaryColor: kit.primaryColor || "#6366f1",
    secondaryColor: kit.secondaryColor || "#1e293b",
    accentColor: kit.accentColor || "#f59e0b",
    fontFamily: kit.fontFamily || "Inter",
    logoUrl: kit.logoUrl || "",
    brandVoice: (kit.brandVoice as Voice) || "",
    voiceDescription: kit.voiceDescription || "",
    sourceUrl: kit.sourceUrl || "",
  };
}

/** Build a BrandKitInput, dropping the empty brandVoice placeholder. */
function toPayload(form: FormState): BrandKitInput {
  const { brandVoice, sourceUrl, ...rest } = form;
  const payload: BrandKitInput = { ...rest };
  if (brandVoice) payload.brandVoice = brandVoice;
  if (sourceUrl) payload.sourceUrl = sourceUrl;
  return payload;
}

/** A tag/chip editor backed by a string[]. Enter or comma commits a chip. */
function ChipInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    const t = draft.trim().replace(/,$/, "").trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setDraft("");
  };
  return (
    <div>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {value.map((c) => (
            <span
              key={c}
              className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-0.5 text-xs"
            >
              {c}
              <button
                type="button"
                onClick={() => onChange(value.filter((x) => x !== c))}
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${c}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
      />
    </div>
  );
}

export default function Brand() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const { data: kits, isLoading, isError } = useListBrandKits();

  const createKit = useCreateBrandKit();
  const updateKit = useUpdateBrandKitById();
  const deleteKit = useDeleteBrandKit();
  const extract = useExtractBrand();
  const videoIdeas = useGenerateVideoIdeas();
  const createProject = useCreateProject();

  const [selectedId, setSelectedId] = useState<number | "new">("new");
  const [form, setForm] = useState<FormState>(BLANK);
  const [detectUrl, setDetectUrl] = useState("");
  const [ideas, setIdeas] = useState<VideoIdea[]>([]);
  const hydrated = useRef(false);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListBrandKitsQueryKey() });

  // Hydrate ONCE from the default kit (listed first). User actions (selectKit /
  // startNew) set the form directly and must not be clobbered by this effect.
  useEffect(() => {
    if (!hydrated.current && kits && kits.length > 0) {
      hydrated.current = true;
      setSelectedId(kits[0].id);
      setForm(toForm(kits[0]));
    }
  }, [kits]);

  function selectKit(kit: BrandKit) {
    setSelectedId(kit.id);
    setForm(toForm(kit));
    setIdeas([]);
  }

  function startNew() {
    setSelectedId("new");
    setForm(BLANK);
    setIdeas([]);
  }

  const set = <K extends keyof FormState>(key: K, val: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: val }));

  const handleChange = (
    e: React.ChangeEvent<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >,
  ) => set(e.target.name as keyof FormState, e.target.value as never);

  function handleDetect(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = detectUrl.trim();
    if (!trimmed || extract.isPending) return;
    const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    extract.mutate(
      { data: { url } },
      {
        onSuccess: (b) => {
          setSelectedId("new");
          setIdeas([]);
          let host = trimmed;
          try {
            host = new URL(url).hostname.replace(/^www\./, "");
          } catch {
            /* keep raw */
          }
          setForm({
            ...BLANK,
            name: host.slice(0, 80) || "Detected brand",
            companyName: b.companyName || "",
            tagline: b.tagline || "",
            description: b.description || "",
            valueProposition: b.valueProposition || "",
            targetAudience: b.targetAudience || "",
            industry: b.industry || "",
            imageStyle: b.imageStyle || "",
            keywords: b.keywords ?? [],
            personality: b.personality ?? [],
            primaryColor: b.primaryColor,
            secondaryColor: b.secondaryColor,
            accentColor: b.accentColor || "#f59e0b",
            fontFamily: b.fontFamily || "Inter",
            logoUrl: b.logoUrl || "",
            sourceUrl: b.sourceUrl,
          });
          toast({
            title: "Brand DNA detected",
            description: "Review & tweak the DNA below, then save it.",
          });
        },
        onError: () =>
          toast({
            variant: "destructive",
            title: "Couldn't detect a brand",
            description:
              "Make sure the URL is a public, reachable site, then try again.",
          }),
      },
    );
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const payload = toPayload(form);
    const onSuccess = (saved: BrandKit) => {
      invalidate();
      setSelectedId(saved.id);
      toast({ title: "Brand DNA saved" });
    };
    const onError = () =>
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to save. Please try again.",
      });
    if (selectedId === "new") {
      createKit.mutate({ data: payload }, { onSuccess, onError });
    } else {
      updateKit.mutate({ id: selectedId, data: payload }, { onSuccess, onError });
    }
  }

  function makeDefault(kit: BrandKit) {
    updateKit.mutate(
      { id: kit.id, data: { isDefault: true } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: `“${kit.name}” is now your default` });
        },
      },
    );
  }

  function removeKit(kit: BrandKit) {
    deleteKit.mutate(
      { id: kit.id },
      {
        onSuccess: () => {
          invalidate();
          if (selectedId === kit.id) startNew();
          toast({ title: "Brand DNA deleted" });
        },
      },
    );
  }

  function handleGenerateIdeas() {
    if (selectedId === "new") return;
    videoIdeas.mutate(
      { id: selectedId },
      {
        onSuccess: (res) => setIdeas(res.ideas),
        onError: () =>
          toast({
            variant: "destructive",
            title: "Couldn't generate ideas",
            description: "Save the DNA first, then try again.",
          }),
      },
    );
  }

  function createFromIdea(idea: VideoIdea) {
    createProject.mutate(
      {
        data: {
          name: idea.title,
          module: idea.module,
          brandKitId: selectedId === "new" ? undefined : selectedId,
          compositionVars: {
            "user.headline": idea.headline,
            "user.bodyText": idea.bodyText,
            "user.ctaText": idea.ctaText,
          },
        },
      },
      {
        onSuccess: (project) => setLocation(`/projects?focus=${project.id}`),
        onError: () =>
          toast({
            variant: "destructive",
            title: "Couldn't create the video",
            description: "Please try again.",
          }),
      },
    );
  }

  const selectedKit =
    selectedId !== "new" ? kits?.find((k) => k.id === selectedId) : undefined;
  const saving = createKit.isPending || updateKit.isPending;
  const fontButtons =
    form.fontFamily && !HANDOFF_FONTS.includes(form.fontFamily)
      ? [form.fontFamily, ...HANDOFF_FONTS]
      : HANDOFF_FONTS;

  if (isError) {
    return (
      <Layout>
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>
            Failed to load your Brand DNA. Please try again later.
          </AlertDescription>
        </Alert>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Dna className="h-7 w-7 text-primary" />
            Brand DNA
          </h1>
          <p className="text-muted-foreground">
            Your brand’s identity, voice and look — detected from your site and
            used to keep every video on-brand.
          </p>
        </div>
        <Button variant="outline" onClick={startNew} disabled={isLoading}>
          <Plus className="mr-2 h-4 w-4" /> New DNA
        </Button>
      </div>

      {/* DNA switcher */}
      {isLoading ? (
        <Skeleton className="h-9 w-full max-w-md mb-6" />
      ) : (
        <div className="flex flex-wrap gap-2 mb-6">
          {kits?.map((kit) => (
            <div key={kit.id} className="flex items-center">
              <Button
                variant={selectedId === kit.id ? "default" : "outline"}
                size="sm"
                onClick={() => selectKit(kit)}
                className="rounded-r-none"
              >
                <span
                  className="mr-2 h-3 w-3 rounded-full border"
                  style={{ backgroundColor: kit.primaryColor }}
                />
                {kit.name}
                {kit.isDefault && (
                  <Star className="ml-1.5 h-3 w-3 fill-current opacity-80" />
                )}
              </Button>
              <Button
                variant={selectedId === kit.id ? "default" : "outline"}
                size="sm"
                className="rounded-l-none border-l-0 px-2"
                title="Delete this DNA"
                disabled={deleteKit.isPending}
                onClick={() => removeKit(kit)}
                aria-label={`Delete ${kit.name}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          {selectedId === "new" && (
            <Button variant="default" size="sm" disabled>
              <Plus className="mr-1.5 h-3 w-3" /> New DNA (unsaved)
            </Button>
          )}
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-8">
        <div className="space-y-6">
          {/* Detect from a website */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Sparkles className="h-5 w-5 text-primary" />
                Build DNA from a website
              </CardTitle>
              <CardDescription>
                Paste a URL — we read the copy, colors, fonts, logo & imagery and
                draft a full Brand DNA.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleDetect} className="flex gap-2">
                <Input
                  type="text"
                  inputMode="url"
                  placeholder="yourcompany.com"
                  value={detectUrl}
                  onChange={(e) => setDetectUrl(e.target.value)}
                  disabled={extract.isPending}
                  aria-label="Website URL to detect a brand from"
                />
                <Button
                  type="submit"
                  disabled={extract.isPending || !detectUrl.trim()}
                  className="shrink-0"
                >
                  {extract.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Analyzing…
                    </>
                  ) : (
                    <>
                      <Sparkles className="mr-2 h-4 w-4" /> Analyze
                    </>
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>

          {isLoading ? (
            <Card>
              <CardContent className="space-y-6 pt-6">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="space-y-2">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : (
            <form onSubmit={handleSave}>
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between">
                    <span>{selectedId === "new" ? "New Brand DNA" : "Edit DNA"}</span>
                    {selectedKit && !selectedKit.isDefault && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => makeDefault(selectedKit)}
                        disabled={updateKit.isPending}
                      >
                        <Star className="mr-1.5 h-3.5 w-3.5" /> Make default
                      </Button>
                    )}
                    {selectedKit?.isDefault && (
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Check className="h-3.5 w-3.5" /> Default
                      </span>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* ── Identity ── */}
                  <div className="space-y-4">
                    <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                      Identity
                    </h3>
                    <div className="grid sm:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="name">DNA name</Label>
                        <Input id="name" name="name" value={form.name} onChange={handleChange} placeholder="My brand" />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="companyName">Company name</Label>
                        <Input id="companyName" name="companyName" value={form.companyName} onChange={handleChange} placeholder="Acme Corp" />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="tagline">Tagline</Label>
                      <Input id="tagline" name="tagline" value={form.tagline} onChange={handleChange} placeholder="The fastest way to ship video" />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="description">What you do</Label>
                      <Textarea id="description" name="description" rows={2} maxLength={400} value={form.description} onChange={handleChange} placeholder="One or two sentences about the business." />
                    </div>
                    <div className="grid sm:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="valueProposition">Value proposition</Label>
                        <Textarea id="valueProposition" name="valueProposition" rows={2} maxLength={280} value={form.valueProposition} onChange={handleChange} placeholder="The core promise / USP." />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="targetAudience">Target audience</Label>
                        <Textarea id="targetAudience" name="targetAudience" rows={2} maxLength={280} value={form.targetAudience} onChange={handleChange} placeholder="Who it's for." />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="industry">Industry</Label>
                      <Input id="industry" name="industry" value={form.industry} onChange={handleChange} placeholder="e.g. SaaS, coffee roaster" />
                    </div>
                  </div>

                  {/* ── Voice & personality ── */}
                  <div className="space-y-4 pt-2 border-t">
                    <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                      Voice &amp; personality
                    </h3>
                    <div className="space-y-2">
                      <Label htmlFor="brandVoice">Tone</Label>
                      <select
                        id="brandVoice"
                        name="brandVoice"
                        value={form.brandVoice}
                        onChange={handleChange}
                        className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                      >
                        <option value="">— Choose a tone —</option>
                        <option value="professional">Professional</option>
                        <option value="playful">Playful</option>
                        <option value="bold">Bold</option>
                        <option value="minimal">Minimal</option>
                      </select>
                    </div>
                    <div className="space-y-2">
                      <Label>Personality</Label>
                      <ChipInput
                        value={form.personality}
                        onChange={(v) => set("personality", v)}
                        placeholder="Add a trait (e.g. bold) and press Enter"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="voiceDescription">Voice notes</Label>
                      <Textarea id="voiceDescription" name="voiceDescription" rows={2} maxLength={500} value={form.voiceDescription} onChange={handleChange} placeholder="Optional: 'No exclamation marks, plural pronouns only.'" />
                    </div>
                  </div>

                  {/* ── Visual ── */}
                  <div className="space-y-4 pt-2 border-t">
                    <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                      Visual identity
                    </h3>
                    <div className="space-y-2">
                      <Label>Logo</Label>
                      <div className="flex items-center gap-4">
                        <div className="w-16 h-16 rounded-md border bg-muted flex items-center justify-center overflow-hidden shrink-0">
                          {form.logoUrl ? (
                            <img src={form.logoUrl} alt="Logo preview" className="w-full h-full object-contain p-2" />
                          ) : (
                            <ImageIcon className="h-7 w-7 text-muted-foreground/50" />
                          )}
                        </div>
                        <Input id="logoUrl" name="logoUrl" value={form.logoUrl} onChange={handleChange} placeholder="https://example.com/logo.png" className="flex-1" />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label>Typography</Label>
                      <div className="flex gap-2">
                        {fontButtons.map((f) => (
                          <button
                            key={f}
                            type="button"
                            onClick={() => set("fontFamily", f)}
                            className={cn(
                              "flex-1 rounded-md border px-2 py-2.5 text-center transition-colors",
                              form.fontFamily === f
                                ? "border-primary bg-primary/10"
                                : "border-border bg-secondary hover:border-muted-foreground/40",
                            )}
                            style={{ fontFamily: f }}
                          >
                            <span className="text-lg leading-none">Ag</span>
                            <span
                              className="mt-1 block truncate text-[10px] text-muted-foreground"
                              style={{ fontFamily: "var(--font-sans)" }}
                            >
                              {f}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="space-y-3">
                      <Label>Palette</Label>
                      <div className="flex gap-3">
                        {(
                          [
                            ["primaryColor", "Primary"],
                            ["secondaryColor", "Background"],
                            ["accentColor", "Accent"],
                          ] as const
                        ).map(([key, label]) => (
                          <div key={key} className="flex-1">
                            <div
                              className="relative h-16 w-full overflow-hidden rounded-lg border"
                              style={{ background: form[key] }}
                            >
                              <input
                                type="color"
                                name={key}
                                value={form[key]}
                                onChange={handleChange}
                                aria-label={`${label} color`}
                                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                              />
                            </div>
                            <div className="mt-1.5 flex items-center justify-between">
                              <span className="text-xs font-semibold">{label}</span>
                              <span className="font-mono text-[11px] uppercase text-muted-foreground">
                                {form[key]}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div>
                        <div className="mb-2 text-[11.5px] text-muted-foreground">
                          Quick palettes
                        </div>
                        <div className="flex gap-2">
                          {QUICK_PALETTES.map((pal, i) => (
                            <button
                              key={i}
                              type="button"
                              aria-label={`Apply palette ${i + 1}`}
                              onClick={() =>
                                setForm((d) => ({
                                  ...d,
                                  primaryColor: pal[0],
                                  secondaryColor: pal[1],
                                  accentColor: pal[2],
                                }))
                              }
                              className="flex h-[30px] w-16 overflow-hidden rounded-lg border transition-transform hover:-translate-y-0.5"
                            >
                              {pal.map((c, j) => (
                                <span key={j} className="flex-1" style={{ background: c }} />
                              ))}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* ── Themes ── */}
                  <div className="space-y-4 pt-2 border-t">
                    <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                      Themes
                    </h3>
                    <div className="space-y-2">
                      <Label>Keywords</Label>
                      <ChipInput
                        value={form.keywords}
                        onChange={(v) => set("keywords", v)}
                        placeholder="Add a keyword and press Enter"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="imageStyle">Imagery style</Label>
                      <Input id="imageStyle" name="imageStyle" value={form.imageStyle} onChange={handleChange} placeholder="e.g. warm, candid lifestyle photography" />
                    </div>
                  </div>

                  <Button type="submit" className="w-full" disabled={saving}>
                    {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                    {selectedId === "new" ? "Create Brand DNA" : "Save Brand DNA"}
                  </Button>
                </CardContent>
              </Card>
            </form>
          )}
        </div>

        {/* Right column: preview + video ideas */}
        <div className="lg:sticky lg:top-8 h-fit space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                Live brand preview
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                  LIVE
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="relative mx-auto aspect-[9/16] w-full max-w-[240px] overflow-hidden rounded-[14px] border bg-[#0d1110]">
                <CompositionThumb
                  vars={{
                    headline:
                      (form.companyName || "Your brand").split(" ")[0] +
                      ",\nin motion.",
                    body: form.tagline || form.description || "",
                    cta: form.keywords[0] || "Shop now",
                  }}
                  brand={{
                    companyName: form.companyName || "Your brand",
                    logoMark: (form.companyName || "S").charAt(0).toUpperCase(),
                  }}
                  accent={form.primaryColor}
                  bg="#0d1110"
                  layout="center"
                  chrome
                />
              </div>
              <div className="space-y-1.5 border-t pt-3">
                <Row k="Company" v={form.companyName || "—"} />
                <Row k="Voice" v={form.brandVoice || "—"} />
                <Row k="Font" v={form.fontFamily} font={form.fontFamily} />
              </div>
              {form.sourceUrl && (
                <p className="text-center text-xs text-muted-foreground">
                  Detected from {form.sourceUrl}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Video ideas (Pomelli-style campaign ideas) */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Clapperboard className="h-5 w-5 text-primary" />
                Video ideas
              </CardTitle>
              <CardDescription>
                On-brand video concepts generated from this DNA — one click to a
                project.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={handleGenerateIdeas}
                disabled={selectedId === "new" || videoIdeas.isPending}
                title={selectedId === "new" ? "Save the DNA first" : undefined}
              >
                {videoIdeas.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generating…
                  </>
                ) : (
                  <>
                    <Sparkles className="mr-2 h-4 w-4" /> Generate video ideas
                  </>
                )}
              </Button>
              {selectedId === "new" && (
                <p className="text-xs text-muted-foreground">
                  Save this DNA to generate ideas from it.
                </p>
              )}
              {ideas.map((idea, i) => (
                <div key={i} className="rounded-lg border p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-medium text-sm">{idea.title}</div>
                    <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {idea.module}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{idea.description}</p>
                  <p className="text-xs">
                    <span className="font-medium">{idea.headline.replace(/\n/g, " ")}</span>
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    className="w-full"
                    onClick={() => createFromIdea(idea)}
                    disabled={createProject.isPending}
                  >
                    <Clapperboard className="mr-2 h-3.5 w-3.5" /> Create this video
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </Layout>
  );
}
