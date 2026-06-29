import { useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  Scissors,
  Loader2,
  Sparkles,
  UploadCloud,
  Film,
  Zap,
} from "lucide-react";
import { useSmartTrim, useFinalizeUpload } from "@workspace/api-client-react";
import { useUpload } from "@workspace/object-storage-web";
import { Layout } from "@/components/layout";
import { useBillingInfo } from "@/hooks/useBilling";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { UpgradeModal } from "@/components/upgrade-modal";

/** Silence sensitivity → the pause length (ms) above which dead air is cut. */
const SENSITIVITY_MS: Record<string, number> = {
  light: 1000,
  balanced: 600,
  aggressive: 350,
};

const MAX_VIDEO_MB = 500;

/**
 * Smart Trim — upload a raw talking-head clip and get back a tightened, branded
 * MP4. Whisper word-times the audio, an EDL drops filler words ("um", "uh") and
 * over-long silences, and the backend FFmpeg-cuts the survivors (POST
 * /api/smart-trim, which auto-renders). We land on /projects where the regular
 * polling + video dialog take over.
 *
 * Upload is the storage two-phase flow: request-url + PUT (useUpload) THEN
 * finalize (stamps the owner ACL — without it the render can't read the source).
 */
export default function SmartTrimPage() {
  const [file, setFile] = useState<File | null>(null);
  const [removeFillers, setRemoveFillers] = useState(true);
  const [removeSilences, setRemoveSilences] = useState(true);
  const [sensitivity, setSensitivity] = useState("balanced");
  const [captions, setCaptions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [upgradeReason, setUpgradeReason] = useState<"ai_limit" | "general">(
    "ai_limit",
  );

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { data: billing } = useBillingInfo();
  const isPro = billing?.plan === "pro";

  const { uploadFile, isUploading } = useUpload();
  const finalize = useFinalizeUpload();
  const create = useSmartTrim();

  const busy = isUploading || finalize.isPending || create.isPending;
  const ready = file !== null && !busy;

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>): void {
    const f = e.target.files?.[0] ?? null;
    setError(null);
    if (f && f.size > MAX_VIDEO_MB * 1024 * 1024) {
      setFile(null);
      setError(`That file is over ${MAX_VIDEO_MB}MB — please pick a smaller clip.`);
      return;
    }
    setFile(f);
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!ready || !file) return;
    setError(null);
    try {
      const up = await uploadFile(file);
      if (!up) {
        setError("Could not upload the video. Check your connection and retry.");
        return;
      }
      // Stamp owner ACL — until finalized the object fails closed on read, so
      // the render couldn't fetch it.
      await finalize.mutateAsync({ data: { objectPath: up.objectPath } });

      const res = await create.mutateAsync({
        data: {
          videoObjectPath: up.objectPath,
          removeFillers,
          removeSilences,
          silenceThresholdMs: SENSITIVITY_MS[sensitivity],
          // Captions are Pro — only request when entitled (the backend would
          // otherwise drop them, but this keeps the request honest).
          captions: captions && isPro,
        },
      });
      if (!res.renderStarted && res.renderMessage) {
        toast({ title: "Saved as draft", description: res.renderMessage });
      }
      setLocation(`/projects?focus=${res.project.id}`);
    } catch (err) {
      const e2 = err as { status?: number; data?: { error?: string } };
      if (e2.status === 403) {
        setUpgradeReason("ai_limit");
        setShowUpgrade(true);
        return;
      }
      if (e2.status === 503) {
        setError(
          "Smart Trim isn't enabled on this server yet — an admin needs to set a transcription key.",
        );
        return;
      }
      if (e2.status === 413) {
        setError("That video is too large or too long (max 500MB / 30 minutes).");
        return;
      }
      if (e2.status === 502) {
        setError("We couldn't transcribe that video. Try a clearer clip.");
        return;
      }
      setError(e2.data?.error ?? "Couldn't process the video. Try again.");
    }
  }

  const busyLabel = isUploading
    ? "Uploading…"
    : finalize.isPending
      ? "Finalizing…"
      : "Trimming…";

  return (
    <Layout>
      <div className="mx-auto max-w-[760px]">
        <div className="mb-6">
          <h1 className="flex items-center gap-2 text-[27px] leading-tight">
            <Scissors className="h-6 w-6 text-primary" />
            Smart Trim
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload a raw talking-head clip — we cut the “um”s, “uh”s and dead air,
            then render a tightened, branded MP4.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Film className="h-5 w-5 text-primary" />
              Your footage
            </CardTitle>
            <CardDescription>
              MP4, MOV or WebM, up to {MAX_VIDEO_MB}MB / 30 minutes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
              {/* File picker */}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
                className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-secondary/40 px-4 py-8 text-center transition-colors hover:border-primary/50 hover:bg-secondary/70 disabled:opacity-60"
              >
                <UploadCloud className="h-7 w-7 text-muted-foreground" />
                {file ? (
                  <span className="text-sm font-medium text-foreground">
                    {file.name}
                  </span>
                ) : (
                  <span className="text-sm text-muted-foreground">
                    Click to choose a video
                  </span>
                )}
                {file && (
                  <span className="text-[11px] text-muted-foreground">
                    {(file.size / (1024 * 1024)).toFixed(1)} MB
                  </span>
                )}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                className="hidden"
                onChange={onPickFile}
              />

              {/* Options */}
              <div className="flex flex-col gap-4 rounded-lg border border-border p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <Label htmlFor="st-fillers" className="text-sm">
                      Remove filler words
                    </Label>
                    <p className="text-[11px] text-muted-foreground">
                      Cuts “um”, “uh”, “er” and similar.
                    </p>
                  </div>
                  <Switch
                    id="st-fillers"
                    checked={removeFillers}
                    onCheckedChange={setRemoveFillers}
                    disabled={busy}
                  />
                </div>

                <div className="flex items-center justify-between gap-4">
                  <div>
                    <Label htmlFor="st-silences" className="text-sm">
                      Remove long silences
                    </Label>
                    <p className="text-[11px] text-muted-foreground">
                      Trims dead air between sentences.
                    </p>
                  </div>
                  <Switch
                    id="st-silences"
                    checked={removeSilences}
                    onCheckedChange={setRemoveSilences}
                    disabled={busy}
                  />
                </div>

                <div className="flex items-center justify-between gap-4">
                  <div>
                    <Label className="text-sm">Silence sensitivity</Label>
                    <p className="text-[11px] text-muted-foreground">
                      How aggressively pauses are cut.
                    </p>
                  </div>
                  <Select
                    value={sensitivity}
                    onValueChange={setSensitivity}
                    disabled={busy || !removeSilences}
                  >
                    <SelectTrigger
                      className="w-[140px]"
                      aria-label="Silence sensitivity"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="light">Light</SelectItem>
                      <SelectItem value="balanced">Balanced</SelectItem>
                      <SelectItem value="aggressive">Aggressive</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center justify-between gap-4">
                  <div>
                    <Label htmlFor="st-captions" className="flex items-center gap-1.5 text-sm">
                      Burn captions
                      <span className="inline-flex items-center gap-1 rounded-full border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                        <Zap className="h-3 w-3" /> Pro
                      </span>
                    </Label>
                    <p className="text-[11px] text-muted-foreground">
                      2-word karaoke captions in your brand colour.
                    </p>
                  </div>
                  <Switch
                    id="st-captions"
                    checked={captions && isPro}
                    onCheckedChange={(v) => {
                      if (v && !isPro) {
                        setUpgradeReason("general");
                        setShowUpgrade(true);
                        return;
                      }
                      setCaptions(v);
                    }}
                    disabled={busy}
                  />
                </div>
              </div>

              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}

              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] text-muted-foreground">
                  Uses 1 AI credit; the render uses your monthly renders.
                </p>
                <Button type="submit" disabled={!ready}>
                  {busy ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {busyLabel}
                    </>
                  ) : (
                    <>
                      <Sparkles className="mr-2 h-4 w-4" />
                      Trim &amp; render
                    </>
                  )}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
      <UpgradeModal
        open={showUpgrade}
        onOpenChange={setShowUpgrade}
        reason={upgradeReason}
      />
    </Layout>
  );
}
