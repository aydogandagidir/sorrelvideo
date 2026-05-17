import { useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { Loader2, Sparkles, Wand2 } from "lucide-react";
import { useCreateProject, useGetBrandKit } from "@workspace/api-client-react";
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

const DEFAULT_HEADLINE = "Make something\nthey'll remember.";
const DEFAULT_BODY =
  "Sorrel turns a template, your brand kit, and a few sentences into branded video — ready to ship.";
const DEFAULT_CTA = "Try it free";

export default function StudioPage() {
  const [, setLocation] = useLocation();
  const { data: brandKit } = useGetBrandKit();
  const createProject = useCreateProject();

  const [name, setName] = useState("Untitled Studio Project");
  const [headline, setHeadline] = useState(DEFAULT_HEADLINE);
  const [bodyText, setBodyText] = useState(DEFAULT_BODY);
  const [ctaText, setCtaText] = useState(DEFAULT_CTA);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
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
      setLocation(`/projects?focus=${project.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create project");
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
                These fields fill placeholders in the Studio template. Render
                starts immediately on submit.
              </CardDescription>
            </CardHeader>
            <CardContent>
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
                {error && (
                  <p className="text-sm text-destructive" role="alert">
                    {error}
                  </p>
                )}
                <Button
                  type="submit"
                  size="lg"
                  className="w-full"
                  disabled={createProject.isPending}
                >
                  {createProject.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Creating project…
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
                Edit on the Brand Kit page — Studio pulls live values at render
                time.
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
    </Layout>
  );
}
