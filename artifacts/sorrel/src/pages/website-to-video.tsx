import React, { useState } from "react";
import { useLocation } from "wouter";
import { Layout } from "@/components/layout";
import { useWebsiteToVideo } from "@workspace/api-client-react";
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

// Preset video lengths (seconds). The backend clamps to 3–60; these are the
// quick picks. The page scroll stretches to fill, so longer = more leisurely.
const DURATIONS = [5, 10, 15, 30] as const;

export default function WebsiteToVideo(): React.JSX.Element {
  const [url, setUrl] = useState("");
  const [duration, setDuration] = useState<number>(10);
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const createVideo = useWebsiteToVideo({
    mutation: {
      onSuccess: (project) => setLocation(`/projects?focus=${project.id}`),
      onError: () =>
        toast({
          variant: "destructive",
          title: "Couldn't create the video",
          description:
            "Make sure the URL is a public, reachable site, then try again.",
        }),
    },
  });

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed || createVideo.isPending) return;
    // Be forgiving: accept "example.com" and default it to https://.
    const full = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    createVideo.mutate({ data: { url: full, duration } });
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
                      key={d}
                      type="button"
                      variant={duration === d ? "default" : "outline"}
                      size="sm"
                      onClick={() => setDuration(d)}
                      disabled={createVideo.isPending}
                      className="flex-1"
                      aria-pressed={duration === d}
                    >
                      {d}s
                    </Button>
                  ))}
                </div>
                <span className="text-xs text-muted-foreground">
                  Intro &amp; outro stay fixed; the page scroll fills the rest —
                  longer means a slower, calmer scroll.
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
