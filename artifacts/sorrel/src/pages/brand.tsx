import React, { useState, useEffect } from "react";
import { Layout } from "@/components/layout";
import {
  useListBrandKits,
  useCreateBrandKit,
  useUpdateBrandKitById,
  useDeleteBrandKit,
  useExtractBrand,
  getListBrandKitsQueryKey,
  type BrandKit,
  type BrandKitInput,
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
} from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";

type Voice = "" | "professional" | "playful" | "bold" | "minimal";

interface FormState {
  name: string;
  companyName: string;
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
  primaryColor: "#6366f1",
  secondaryColor: "#1e293b",
  accentColor: "#f59e0b",
  fontFamily: "Inter",
  logoUrl: "",
  brandVoice: "",
  voiceDescription: "",
  sourceUrl: "",
};

const FONT_PRESETS = ["Inter", "Space Mono", "Georgia", "system-ui"];

function toForm(kit: BrandKit): FormState {
  return {
    name: kit.name || "Brand kit",
    companyName: kit.companyName || "",
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

/** Strip an empty brandVoice (backend rejects the placeholder) → BrandKitInput. */
function toPayload(form: FormState): BrandKitInput {
  const { brandVoice, sourceUrl, ...rest } = form;
  const payload: BrandKitInput = { ...rest };
  if (brandVoice) payload.brandVoice = brandVoice;
  if (sourceUrl) payload.sourceUrl = sourceUrl;
  return payload;
}

export default function Brand() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: kits, isLoading, isError } = useListBrandKits();

  const createKit = useCreateBrandKit();
  const updateKit = useUpdateBrandKitById();
  const deleteKit = useDeleteBrandKit();
  const extract = useExtractBrand();

  // "new" = an unsaved draft (e.g. from URL detect); a number = an existing kit.
  const [selectedId, setSelectedId] = useState<number | "new">("new");
  const [form, setForm] = useState<FormState>(BLANK);
  const [detectUrl, setDetectUrl] = useState("");

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListBrandKitsQueryKey() });

  // On first load, select the default kit (listed first) and hydrate the form.
  useEffect(() => {
    if (kits && kits.length > 0 && selectedId === "new" && form === BLANK) {
      setSelectedId(kits[0].id);
      setForm(toForm(kits[0]));
    }
  }, [kits, selectedId, form]);

  function selectKit(kit: BrandKit) {
    setSelectedId(kit.id);
    setForm(toForm(kit));
  }

  function startNew() {
    setSelectedId("new");
    setForm(BLANK);
  }

  const handleChange = (
    e: React.ChangeEvent<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >,
  ) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  function handleDetect(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = detectUrl.trim();
    if (!trimmed || extract.isPending) return;
    const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    extract.mutate(
      { data: { url } },
      {
        onSuccess: (brand) => {
          // Detected brand becomes a NEW draft — review, then Save to create it.
          setSelectedId("new");
          let host = trimmed;
          try {
            host = new URL(url).hostname.replace(/^www\./, "");
          } catch {
            /* keep raw */
          }
          setForm({
            name: host.slice(0, 80) || "Detected brand",
            companyName: brand.companyName || "",
            primaryColor: brand.primaryColor,
            secondaryColor: brand.secondaryColor,
            accentColor: brand.accentColor || "#f59e0b",
            fontFamily: brand.fontFamily || "Inter",
            logoUrl: brand.logoUrl || "",
            brandVoice: "",
            voiceDescription: "",
            sourceUrl: brand.sourceUrl,
          });
          toast({
            title: "Brand detected",
            description: "Review the colors & name below, then save the kit.",
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
      toast({ title: "Brand kit saved" });
    };
    const onError = () =>
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to save the brand kit. Please try again.",
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
          toast({ title: "Brand kit deleted" });
        },
      },
    );
  }

  const selectedKit =
    selectedId !== "new" ? kits?.find((k) => k.id === selectedId) : undefined;
  const saving = createKit.isPending || updateKit.isPending;
  const fontOptions = FONT_PRESETS.includes(form.fontFamily)
    ? FONT_PRESETS
    : [form.fontFamily, ...FONT_PRESETS];

  if (isError) {
    return (
      <Layout>
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>
            Failed to load brand kits. Please try again later.
          </AlertDescription>
        </Alert>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Brand Kit</h1>
          <p className="text-muted-foreground">
            Manage your visual identity. Keep several kits and pick a default.
          </p>
        </div>
        <Button variant="outline" onClick={startNew} disabled={isLoading}>
          <Plus className="mr-2 h-4 w-4" /> New kit
        </Button>
      </div>

      {/* Kit switcher */}
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
                title="Delete this kit"
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
              <Plus className="mr-1.5 h-3 w-3" /> New kit (unsaved)
            </Button>
          )}
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-8">
        <div className="space-y-6">
          {/* Auto-detect from a website */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Sparkles className="h-5 w-5 text-primary" />
                Build from a website
              </CardTitle>
              <CardDescription>
                Paste a URL — we detect the colors, logo, font and name.
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
                      Detecting…
                    </>
                  ) : (
                    <>
                      <Sparkles className="mr-2 h-4 w-4" /> Detect
                    </>
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>

          {isLoading ? (
            <Card>
              <CardContent className="space-y-6 pt-6">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="space-y-2">
                    <Skeleton className="h-4 w-20" />
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
                    <span>{selectedId === "new" ? "New brand kit" : "Edit kit"}</span>
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
                        <Check className="h-3.5 w-3.5" /> Default kit
                      </span>
                    )}
                  </CardTitle>
                  <CardDescription>
                    Configure brand styling used across your videos.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-2">
                    <Label htmlFor="name">Kit name</Label>
                    <Input
                      id="name"
                      name="name"
                      value={form.name}
                      onChange={handleChange}
                      placeholder="My brand"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="companyName">Company Name</Label>
                    <Input
                      id="companyName"
                      name="companyName"
                      value={form.companyName}
                      onChange={handleChange}
                      placeholder="Acme Corp"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Logo</Label>
                    <div className="flex items-center gap-4">
                      <div className="w-20 h-20 rounded-md border bg-muted flex items-center justify-center overflow-hidden">
                        {form.logoUrl ? (
                          <img
                            src={form.logoUrl}
                            alt="Logo preview"
                            className="w-full h-full object-contain p-2"
                          />
                        ) : (
                          <ImageIcon className="h-8 w-8 text-muted-foreground/50" />
                        )}
                      </div>
                      <Input
                        id="logoUrl"
                        name="logoUrl"
                        value={form.logoUrl}
                        onChange={handleChange}
                        placeholder="https://example.com/logo.png"
                        className="flex-1"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="fontFamily">Typography</Label>
                    <select
                      id="fontFamily"
                      name="fontFamily"
                      value={form.fontFamily}
                      onChange={handleChange}
                      className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {fontOptions.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-3 gap-4">
                    {(
                      [
                        ["primaryColor", "Primary"],
                        ["secondaryColor", "Secondary"],
                        ["accentColor", "Accent"],
                      ] as const
                    ).map(([key, label]) => (
                      <div key={key} className="space-y-2">
                        <Label htmlFor={key}>{label}</Label>
                        <div className="flex gap-2">
                          <Input
                            type="color"
                            id={key}
                            name={key}
                            value={form[key]}
                            onChange={handleChange}
                            className="w-12 h-10 p-1 px-1 cursor-pointer"
                          />
                          <Input
                            value={form[key]}
                            onChange={handleChange}
                            name={key}
                            className="flex-1 font-mono uppercase"
                          />
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="space-y-2 pt-2 border-t">
                    <Label htmlFor="brandVoice">Brand voice</Label>
                    <select
                      id="brandVoice"
                      name="brandVoice"
                      value={form.brandVoice}
                      onChange={handleChange}
                      className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <option value="">— Choose a tone —</option>
                      <option value="professional">Professional</option>
                      <option value="playful">Playful</option>
                      <option value="bold">Bold</option>
                      <option value="minimal">Minimal</option>
                    </select>
                    <p className="text-xs text-muted-foreground">
                      Feeds the AI copy suggester. Optional.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="voiceDescription">Voice notes</Label>
                    <Textarea
                      id="voiceDescription"
                      name="voiceDescription"
                      rows={3}
                      maxLength={500}
                      value={form.voiceDescription}
                      onChange={handleChange}
                      placeholder="Optional: e.g. 'We're clinical, no exclamation marks, plural pronouns only.'"
                    />
                  </div>

                  <Button type="submit" className="w-full" disabled={saving}>
                    {saving ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="mr-2 h-4 w-4" />
                    )}
                    {selectedId === "new" ? "Create brand kit" : "Save brand kit"}
                  </Button>
                </CardContent>
              </Card>
            </form>
          )}
        </div>

        {/* Live Preview */}
        <div className="lg:sticky lg:top-8 h-fit">
          <Card className="overflow-hidden border-2">
            <CardHeader className="bg-muted/50 border-b">
              <CardTitle className="text-sm font-medium flex items-center justify-between">
                <span>Live Preview</span>
                <span className="text-xs text-muted-foreground font-normal">
                  Video Title Card
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div
                className="aspect-video w-full flex flex-col items-center justify-center p-8 relative transition-colors duration-500"
                style={{
                  background: `linear-gradient(135deg, ${form.primaryColor}, ${form.secondaryColor})`,
                }}
              >
                <div className="z-10 flex flex-col items-center text-center gap-6">
                  {form.logoUrl ? (
                    <img
                      src={form.logoUrl}
                      alt="Logo"
                      className="h-16 object-contain"
                    />
                  ) : (
                    <div
                      className="w-16 h-16 rounded-full flex items-center justify-center text-2xl font-bold"
                      style={{
                        backgroundColor: "rgba(255,255,255,0.15)",
                        color: "#fff",
                      }}
                    >
                      {form.companyName
                        ? form.companyName.charAt(0).toUpperCase()
                        : "A"}
                    </div>
                  )}

                  <div
                    className="text-4xl font-bold text-white"
                    style={{ fontFamily: form.fontFamily }}
                  >
                    {form.companyName || "Your Brand"}
                  </div>

                  <div
                    className="px-4 py-1 rounded-full text-sm font-medium"
                    style={{ backgroundColor: form.accentColor, color: "#0b0b0f" }}
                  >
                    New Feature Announcement
                  </div>
                </div>

                <div className="absolute bottom-0 left-0 w-full h-2 bg-black/10">
                  <div
                    className="h-full w-1/3"
                    style={{ backgroundColor: form.accentColor }}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
          {form.sourceUrl && (
            <p className="text-xs text-muted-foreground mt-2 text-center">
              Detected from {form.sourceUrl}
            </p>
          )}
        </div>
      </div>
    </Layout>
  );
}
