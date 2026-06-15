import React, { useState } from "react";
import { useLocation } from "wouter";
import { Layout } from "@/components/layout";
import {
  useWebsiteToVideo,
  useListBrandKits,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Globe, Loader2, Sparkles } from "lucide-react";

// Preset video lengths (seconds) + "Auto". Auto omits duration so the backend
// scales the length to the captured page height — a calm, COMPLETE scroll
// through the whole site (the fix for "too short / shows it too briefly").
type DurationChoice = "auto" | number;
const DURATIONS: DurationChoice[] = ["auto", 10, 20, 30, 45];

export default function WebsiteToVideo(): React.JSX.Element {
  const [url, setUrl] = useState("");
  const [duration, setDuration] = useState<DurationChoice>("auto");
  // "" = automatic (reuse a configured default, else detect); "detect" = always
  // detect fresh; a number = a specific kit id.
  const [brandChoice, setBrandChoice] = useState<"" | "detect" | number>("");
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const { data: kits } = useListBrandKits();

  const createVideo = useWebsiteToVideo({
    mutation: {
      onSuccess: (project) => setLocation(`/projects?focus=${project.id}`),
      // Branch on the backend status so the message matches the real failure
      // (rate-limit, SSRF/invalid-URL reject, capture failure) instead of one
      // misleading "make sure the URL is reachable" for every case.
      onError: (err) => {
        const e = err as { status?: number; data?: { error?: string } };
        const description =
          e.status === 429
            ? "You're capturing sites too quickly — wait a minute and try again."
            : e.status === 400
              ? (e.data?.error ??
                "That URL can't be captured. Use a public site and try again.")
              : e.status === 502
                ? "We couldn't load that site. Make sure it's public and reachable, then try again."
                : "Something went wrong creating the video. Please try again.";
        toast({
          variant: "destructive",
          title: "Couldn't create the video",
          description,
        });
      },
    },
  });

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed || createVideo.isPending) return;
    // Be forgiving: accept "example.com" and default it to https://.
    const full = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    // Catch obvious junk before a slow Chrome round-trip: must parse to a URL
    // with a dotted hostname.
    let hostname = "";
    try {
      hostname = new URL(full).hostname;
    } catch {
      hostname = "";
    }
    if (!hostname.includes(".")) {
      toast({
        variant: "destructive",
        title: "Enter a valid website URL",
        description: "For example, yourcompany.com",
      });
      return;
    }
    createVideo.mutate({
      data: {
        url: full,
        ...(duration !== "auto" ? { duration } : {}),
        ...(brandChoice === "detect"
          ? { autoBrand: true }
          : typeof brandChoice === "number"
            ? { brandKitId: brandChoice }
            : {}),
      },
    });
  }

  return (
    <Layout>
      <div className="max-w-2xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Globe className="h-7 w-7 text-primary" />
            Website → Video
          </h1>
          <p className="text-muted-foreground mt-1">
            Paste any URL. We capture the page and turn it into a branded
            showcase video — ready to render and download.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Turn a website into a video</CardTitle>
            <CardDescription>
              Works with your live site, a landing page, or a product page.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex gap-2">
                <Input
                  type="text"
                  inputMode="url"
                  placeholder="yourcompany.com"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={createVideo.isPending}
                  aria-label="Website URL"
                  autoFocus
                />
                <Button
                  type="submit"
                  disabled={createVideo.isPending || !url.trim()}
                  className="shrink-0"
                >
                  {createVideo.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Capturing…
                    </>
                  ) : (
                    <>
                      <Sparkles className="mr-2 h-4 w-4" />
                      Create video
                    </>
                  )}
                </Button>
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Video length</span>
                <div className="flex gap-2">
                  {DURATIONS.map((d) => (
                    <Button
                      key={String(d)}
                      type="button"
                      variant={duration === d ? "default" : "outline"}
                      size="sm"
                      onClick={() => setDuration(d)}
                      disabled={createVideo.isPending}
                      className="flex-1"
                      aria-pressed={duration === d}
                    >
                      {d === "auto" ? "Auto" : `${d}s`}
                    </Button>
                  ))}
                </div>
                <span className="text-xs text-muted-foreground">
                  Auto scales the length to the page so the whole site scrolls
                  through calmly. Pick a fixed length to override.
                </span>
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">Brand</span>
                <select
                  value={String(brandChoice)}
                  onChange={(e) => {
                    const v = e.target.value;
                    setBrandChoice(
                      v === "" || v === "detect" ? (v as "" | "detect") : Number(v),
                    );
                  }}
                  disabled={createVideo.isPending}
                  aria-label="Brand kit"
                  className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="">Automatic — use my brand, else detect</option>
                  <option value="detect">Detect this site&apos;s brand (new kit)</option>
                  {kits?.map((k) => (
                    <option key={k.id} value={k.id}>
                      Use “{k.name}”{k.isDefault ? " (default)" : ""}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-muted-foreground">
                  {kits && kits.length > 0
                    ? "Automatic uses your default brand kit, or detects one from the site if you have none."
                    : "No brand kit yet — we’ll detect one from your site and save it to your Brand Kit."}
                </span>
              </div>

              {createVideo.isPending && (
                <p className="text-sm text-muted-foreground">
                  Loading the site and capturing a screenshot — this takes a few
                  seconds.
                </p>
              )}
            </form>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
