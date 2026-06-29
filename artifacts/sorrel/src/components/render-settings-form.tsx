/**
 * RenderSettingsForm — a controlled editor for a project's RenderSettings.
 *
 * `value` / `onChange` make it fully controlled; the parent owns the state.
 * `plan` drives Pro-gating: for Free users, Pro-only options still render and
 * are tagged with a "Pro" badge, but selecting one calls `onUpgrade()` and is
 * NOT applied to state (the control snaps back) — we keep them clickable rather
 * than HTML-`disabled` precisely so the click can surface the upgrade nudge.
 * Self-contained (no data fetching) so Studio and a future Bulk screen can both
 * mount it. The whole form can be hard-`disabled` via the `disabled` prop while
 * the parent is submitting.
 *
 * The gating mirrors the server (see lib/render-settings.ts → proViolations,
 * which tracks assertRenderSettingsAllowed). This is an eager UX gate only; the
 * PATCH endpoint remains authoritative.
 */
import { useRef, useState, type ChangeEvent } from "react";
import { Plus, Trash2, Sparkles, Music, Captions } from "lucide-react";
import { useUpload } from "@workspace/object-storage-web";
import {
  useGenerateCaptions,
  useFinalizeUpload,
  type RenderSettings,
  type RenderTransition,
} from "@workspace/api-client-react";
import {
  QUALITY_OPTIONS,
  FPS_OPTIONS,
  FORMAT_OPTIONS,
  RESOLUTION_OPTIONS,
  TRANSITION_SHADERS,
  EASE_OPTIONS,
  FREE_MAX_TRANSITIONS,
  defaultTransition,
  formatSupportsAlpha,
  shaderLabel,
  isProOnly,
  type RenderQuality,
  type RenderFps,
  type RenderFormat,
  type RenderResolution,
} from "@/lib/render-settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface RenderSettingsFormProps {
  value: RenderSettings;
  onChange: (next: RenderSettings) => void;
  plan: "free" | "pro";
  /** Invoked when a Free user touches a Pro-only control. */
  onUpgrade?: () => void;
  /** Disable the whole form (e.g. while the parent is submitting). */
  disabled?: boolean;
  /**
   * Whether the project's template can host scene transitions (the server
   * derives it from the shipped composition — `Template.supportsTransitions`).
   * `false` disables the picker with an explanatory hint; `undefined` (callers
   * without template context) keeps the picker enabled unchanged.
   */
  supportsTransitions?: boolean;
}

const ProBadge = () => (
  <Badge variant="outline" className="ml-1.5 px-1.5 py-0 text-[10px]">
    Pro
  </Badge>
);

export function RenderSettingsForm({
  value,
  onChange,
  plan,
  onUpgrade,
  disabled = false,
  supportsTransitions,
}: RenderSettingsFormProps) {
  const isFree = plan === "free";
  const transitionsUnsupported = supportsTransitions === false;
  const patch = (partial: Partial<RenderSettings>) =>
    onChange({ ...value, ...partial });

  const transitions = value.transitions ?? [];
  const alphaSupported = formatSupportsAlpha(value.format);

  // Uploads are a THREE-step flow: request-url + PUT (useUpload), then FINALIZE
  // to stamp the owner ACL. Skipping finalize leaves the object with no ACL, and
  // the server's canAccessObject fails closed — so the render-time owner check
  // silently drops background audio (rendering silent) and transcribeObject 404s
  // the caption job. We finalize in the handlers below before using the path.
  const finalizeUpload = useFinalizeUpload();

  // Background audio (Track C): upload → finalize → store the objectPath on the
  // settings; the render pipeline resolves + injects it as an <audio> to mux.
  const audioInputRef = useRef<HTMLInputElement>(null);
  const {
    uploadFile: uploadAudio,
    isUploading: audioUploading,
    error: audioError,
  } = useUpload();
  const audioBusy = audioUploading || finalizeUpload.isPending;

  // A Free user clicking a locked option: nudge to upgrade rather than mutate.
  const gate = (locked: boolean): boolean => {
    if (locked && isFree) {
      onUpgrade?.();
      return true;
    }
    return false;
  };

  function setQuality(next: RenderQuality) {
    if (gate(isProOnly("quality", next))) return;
    patch({ quality: next });
  }
  function setFps(next: RenderFps) {
    if (gate(isProOnly("fps", next))) return;
    patch({ fps: next });
  }
  function setFormat(next: RenderFormat) {
    if (gate(isProOnly("format", next))) return;
    // Dropping to a non-alpha format can't keep transparency on.
    patch({
      format: next,
      transparent: formatSupportsAlpha(next) ? value.transparent : false,
    });
  }
  function setResolution(next: RenderResolution) {
    if (gate(isProOnly("resolution", next))) return;
    patch({ resolution: next });
  }
  function setTransparent(next: boolean) {
    if (gate(isProOnly("transparent", next))) return;
    patch({ transparent: next });
  }
  function setWatermark(nextWatermark: boolean) {
    // watermark=false is the Pro action (removing it).
    if (gate(isProOnly("watermark", nextWatermark))) return;
    patch({ watermark: nextWatermark });
  }

  function pickAudio() {
    // Background audio is a Pro feature in its entirety.
    if (gate(isProOnly("backgroundAudio", true))) return;
    audioInputRef.current?.click();
  }
  async function onAudioFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file after a remove
    if (!file) return;
    const res = await uploadAudio(file); // sets audioError + returns null on failure
    if (!res) return;
    try {
      // Stamp the owner ACL before the path is persisted, else the render can't
      // read it (canAccessObject fails closed → background audio renders silent).
      await finalizeUpload.mutateAsync({ data: { objectPath: res.objectPath } });
    } catch {
      return; // don't store an unreadable path — leave the track unattached
    }
    patch({ backgroundAudio: { objectPath: res.objectPath, volume: 50 } });
  }
  function setAudioVolume(next: number) {
    if (!value.backgroundAudio) return;
    patch({ backgroundAudio: { ...value.backgroundAudio, volume: next } });
  }

  // Auto-captions (Track E2): upload a voiceover → Whisper transcribes it to
  // word-timed captions → store on settings.captions (the render burns them in).
  const captionInputRef = useRef<HTMLInputElement>(null);
  const [captionError, setCaptionError] = useState<string | null>(null);
  const generateCaptions = useGenerateCaptions();
  const { uploadFile: uploadCaptionAudio, isUploading: captionUploading } =
    useUpload({ onError: () => setCaptionError("Audio upload failed.") });
  function pickCaptionAudio() {
    if (gate(isProOnly("captions", true))) return;
    setCaptionError(null);
    captionInputRef.current?.click();
  }
  async function onCaptionAudioFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setCaptionError(null);
    const res = await uploadCaptionAudio(file);
    if (!res) return; // upload failed; onError already set captionError
    try {
      // Finalize (owner ACL) BEFORE transcription — transcribeObject re-checks
      // ownership and 404s an un-finalized object.
      await finalizeUpload.mutateAsync({ data: { objectPath: res.objectPath } });
      const result = await generateCaptions.mutateAsync({
        data: { audioObjectPath: res.objectPath },
      });
      patch({ captions: { words: result.words } });
    } catch (err) {
      const e = err as { status?: number; data?: { error?: string } };
      if (e.status === 403) onUpgrade?.();
      else if (e.status === 503)
        setCaptionError("Auto-captions aren't enabled on this server.");
      else setCaptionError(e.data?.error ?? "Could not generate captions.");
    }
  }
  const captionWordCount = value.captions?.words?.length ?? 0;
  const captionBusy =
    captionUploading || finalizeUpload.isPending || generateCaptions.isPending;

  function addTransition() {
    const nextLen = transitions.length + 1;
    if (gate(isProOnly("transitions", nextLen))) return;
    patch({ transitions: [...transitions, defaultTransition()] });
  }
  function updateTransition(index: number, partial: Partial<RenderTransition>) {
    patch({
      transitions: transitions.map((t, i) =>
        i === index ? { ...t, ...partial } : t,
      ),
    });
  }
  function removeTransition(index: number) {
    patch({ transitions: transitions.filter((_, i) => i !== index) });
  }

  return (
    <TooltipProvider>
      <div className="space-y-6" aria-disabled={disabled}>
        {/* Quality */}
        <fieldset className="space-y-2" disabled={disabled}>
          <Label id="rs-quality-label">Quality</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            value={value.quality}
            onValueChange={(v) => v && setQuality(v as RenderQuality)}
            className="justify-start"
            aria-labelledby="rs-quality-label"
          >
            {QUALITY_OPTIONS.map((opt) => {
              const locked = isFree && isProOnly("quality", opt.value);
              return (
                <ToggleGroupItem
                  key={opt.value}
                  value={opt.value}
                  // Keep clickable when locked so the upgrade nudge can fire.
                  data-locked={locked}
                  className="data-[locked=true]:opacity-60"
                  aria-label={`${opt.label}${locked ? " (Pro)" : ""}`}
                >
                  {opt.label}
                  {locked && <ProBadge />}
                </ToggleGroupItem>
              );
            })}
          </ToggleGroup>
        </fieldset>

        {/* Format + Resolution */}
        <div className="grid gap-4 sm:grid-cols-2">
          <fieldset className="space-y-2" disabled={disabled}>
            <Label htmlFor="rs-format">Format</Label>
            <Select
              value={value.format}
              onValueChange={(v) => setFormat(v as RenderFormat)}
            >
              <SelectTrigger id="rs-format">
                <SelectValue placeholder="Format" />
              </SelectTrigger>
              <SelectContent>
                {FORMAT_OPTIONS.map((opt) => {
                  const locked = isFree && isProOnly("format", opt.value);
                  return (
                    // Kept selectable on purpose: the root onValueChange routes
                    // a locked pick to onUpgrade() instead of applying it.
                    <SelectItem key={opt.value} value={opt.value}>
                      <span className="flex items-center">
                        {opt.label}
                        {opt.hint && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {opt.hint}
                          </span>
                        )}
                        {locked && <ProBadge />}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </fieldset>

          <fieldset className="space-y-2" disabled={disabled}>
            <Label htmlFor="rs-resolution">Resolution</Label>
            <Select
              value={value.resolution}
              onValueChange={(v) => setResolution(v as RenderResolution)}
            >
              <SelectTrigger id="rs-resolution">
                <SelectValue placeholder="Resolution" />
              </SelectTrigger>
              <SelectContent>
                {RESOLUTION_OPTIONS.map((opt) => {
                  const locked = isFree && isProOnly("resolution", opt.value);
                  return (
                    // Kept selectable on purpose: the root onValueChange routes
                    // a locked pick to onUpgrade() instead of applying it.
                    <SelectItem key={opt.value} value={opt.value}>
                      <span className="flex items-center">
                        {opt.label}
                        {opt.hint && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {opt.hint}
                          </span>
                        )}
                        {locked && <ProBadge />}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </fieldset>
        </div>

        {/* Frame rate */}
        <fieldset className="space-y-2" disabled={disabled}>
          <Label id="rs-fps-label">Frame rate</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            value={String(value.fps)}
            onValueChange={(v) => v && setFps(Number(v) as RenderFps)}
            className="justify-start"
            aria-labelledby="rs-fps-label"
          >
            {FPS_OPTIONS.map((opt) => {
              const locked = isFree && isProOnly("fps", opt.value);
              return (
                <ToggleGroupItem
                  key={opt.value}
                  value={String(opt.value)}
                  data-locked={locked}
                  className="data-[locked=true]:opacity-60"
                  aria-label={`${opt.label} fps${locked ? " (Pro)" : ""}`}
                >
                  {opt.label}
                  {locked && <ProBadge />}
                </ToggleGroupItem>
              );
            })}
          </ToggleGroup>
          <p className="text-xs text-muted-foreground">Frames per second.</p>
        </fieldset>

        {/* Transparency + watermark switches */}
        <div className="space-y-4 rounded-lg border p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-0.5">
              <Label
                htmlFor="rs-transparent"
                className="flex items-center gap-1"
              >
                Transparent background
                {isFree && <ProBadge />}
              </Label>
              <p className="text-xs text-muted-foreground">
                {alphaSupported
                  ? "Render with a transparent (alpha) background."
                  : "Only available for WebM, MOV, or PNG sequence."}
              </p>
            </div>
            {alphaSupported ? (
              <Switch
                id="rs-transparent"
                checked={value.transparent}
                disabled={disabled}
                onCheckedChange={setTransparent}
                aria-label="Transparent background"
              />
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* span wrapper so the tooltip works on a disabled control */}
                  <span tabIndex={0}>
                    <Switch
                      id="rs-transparent"
                      checked={false}
                      disabled
                      aria-label="Transparent background (unavailable for this format)"
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  Switch to WebM, MOV, or PNG sequence to enable transparency.
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="rs-watermark" className="flex items-center gap-1">
                Remove watermark
                {isFree && <ProBadge />}
              </Label>
              <p className="text-xs text-muted-foreground">
                Free renders include a Sorrel watermark.
              </p>
            </div>
            <Switch
              id="rs-watermark"
              // The switch represents "remove watermark" → inverse of watermark.
              checked={!value.watermark}
              disabled={disabled}
              onCheckedChange={(checked) => setWatermark(!checked)}
              aria-label="Remove watermark"
            />
          </div>
        </div>

        {/* Background audio (Pro) */}
        <fieldset
          className="space-y-3 rounded-lg border p-4"
          disabled={disabled}
        >
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-2">
              <Music className="h-4 w-4 text-primary" />
              Background audio
              {isFree && <ProBadge />}
            </Label>
            {value.backgroundAudio && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => patch({ backgroundAudio: null })}
                aria-label="Remove background audio"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>

          <input
            ref={audioInputRef}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={onAudioFile}
          />

          {value.backgroundAudio ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Music track attached — looped and trimmed to your video length.
              </p>
              <div className="flex items-center justify-between">
                <Label htmlFor="rs-audio-volume">Volume</Label>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {value.backgroundAudio.volume}%
                </span>
              </div>
              <Slider
                id="rs-audio-volume"
                min={0}
                max={100}
                step={1}
                value={[value.backgroundAudio.volume]}
                onValueChange={([v]) => setAudioVolume(v)}
                aria-label="Background audio volume"
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={pickAudio}
                disabled={disabled || audioBusy}
              >
                <Plus className="h-4 w-4" />
                {audioBusy ? "Uploading…" : "Upload music"}
              </Button>
              {audioError && (
                <p className="text-xs text-destructive">{audioError.message}</p>
              )}
              <p className="text-xs text-muted-foreground">
                MP3, WAV, or M4A — plays under your video.
              </p>
            </div>
          )}
        </fieldset>

        {/* Captions (Pro) — auto-generated from a voiceover via Whisper */}
        <fieldset
          className="space-y-3 rounded-lg border p-4"
          disabled={disabled}
        >
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-2">
              <Captions className="h-4 w-4 text-primary" />
              Captions
              {isFree && <ProBadge />}
            </Label>
            {captionWordCount > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => patch({ captions: null })}
                aria-label="Remove captions"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>

          <input
            ref={captionInputRef}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={onCaptionAudioFile}
          />

          {captionWordCount > 0 ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {captionWordCount} words captioned — revealed word by word, in
                sync.
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="rs-caption-style" className="text-xs">
                  Caption style
                </Label>
                <Select
                  value={value.captions?.style ?? "classic"}
                  onValueChange={(v) =>
                    patch({
                      captions: {
                        ...(value.captions ?? { words: [] }),
                        // "classic" is the default — drop the key so the resolved
                        // settings stay byte-identical (mirrors the server).
                        ...(v === "classic"
                          ? { style: undefined }
                          : {
                              style: v as NonNullable<
                                RenderSettings["captions"]
                              >["style"],
                            }),
                      },
                    })
                  }
                >
                  <SelectTrigger id="rs-caption-style">
                    <SelectValue placeholder="Caption style" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="classic">Classic</SelectItem>
                    <SelectItem value="pill-karaoke">Pill karaoke</SelectItem>
                    <SelectItem value="neon-accent">Neon accent</SelectItem>
                    <SelectItem value="kinetic-slam">Kinetic slam</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={pickCaptionAudio}
                disabled={disabled || captionBusy}
              >
                <Captions className="h-4 w-4" />
                {captionUploading || finalizeUpload.isPending
                  ? "Uploading…"
                  : generateCaptions.isPending
                    ? "Transcribing…"
                    : "Auto-caption from audio"}
              </Button>
              {captionError && (
                <p className="text-xs text-destructive">{captionError}</p>
              )}
              <p className="text-xs text-muted-foreground">
                Upload a voiceover — we transcribe it to word-timed captions.
              </p>
            </div>
          )}
        </fieldset>

        {/* Transitions */}
        <fieldset
          className="space-y-3"
          disabled={disabled || transitionsUnsupported}
        >
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              Transitions
            </Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addTransition}
              disabled={transitionsUnsupported}
            >
              <Plus className="h-4 w-4" />
              Add transition
            </Button>
          </div>

          {transitionsUnsupported && (
            <p
              className="text-xs text-muted-foreground"
              data-testid="transitions-unsupported-hint"
            >
              This template doesn&apos;t have scene transitions yet — try Brand
              Story for a real shader transition.
            </p>
          )}

          {isFree && !transitionsUnsupported && (
            <p className="text-xs text-muted-foreground">
              Free plan supports up to {FREE_MAX_TRANSITIONS} transition.
              <span className="ml-1 inline-flex items-center">
                More <ProBadge />
              </span>
            </p>
          )}

          {transitions.length === 0 ? (
            <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
              {transitionsUnsupported
                ? "Transitions are unavailable for this template."
                : "No transitions yet. Add one to blend between scenes."}
            </p>
          ) : (
            <Tabs defaultValue="0" className="w-full">
              <TabsList className="flex h-auto flex-wrap">
                {transitions.map((_, i) => (
                  <TabsTrigger key={i} value={String(i)}>
                    #{i + 1}
                  </TabsTrigger>
                ))}
              </TabsList>
              {transitions.map((transition, index) => (
                <TabsContent
                  key={index}
                  value={String(index)}
                  className="space-y-4 rounded-lg border p-4"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">
                      Transition {index + 1}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeTransition(index)}
                      aria-label={`Remove transition ${index + 1}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor={`rs-tr-shader-${index}`}>Shader</Label>
                      <Select
                        value={transition.shader}
                        onValueChange={(v) =>
                          updateTransition(index, { shader: v })
                        }
                      >
                        <SelectTrigger id={`rs-tr-shader-${index}`}>
                          <SelectValue placeholder="Shader" />
                        </SelectTrigger>
                        <SelectContent>
                          {TRANSITION_SHADERS.map((shader) => (
                            <SelectItem key={shader} value={shader}>
                              {shaderLabel(shader)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor={`rs-tr-ease-${index}`}>Easing</Label>
                      <Select
                        value={transition.ease}
                        onValueChange={(v) =>
                          updateTransition(index, { ease: v })
                        }
                      >
                        <SelectTrigger id={`rs-tr-ease-${index}`}>
                          <SelectValue placeholder="Easing" />
                        </SelectTrigger>
                        <SelectContent>
                          {EASE_OPTIONS.map((ease) => (
                            <SelectItem key={ease} value={ease}>
                              {ease}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor={`rs-tr-time-${index}`}>Start time</Label>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {transition.time.toFixed(1)}s
                      </span>
                    </div>
                    <Slider
                      id={`rs-tr-time-${index}`}
                      min={0}
                      max={30}
                      step={0.1}
                      value={[transition.time]}
                      onValueChange={([v]) =>
                        updateTransition(index, { time: v })
                      }
                      aria-label={`Transition ${index + 1} start time in seconds`}
                      aria-valuetext={`${transition.time.toFixed(1)} seconds`}
                    />
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor={`rs-tr-duration-${index}`}>
                        Duration
                      </Label>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {transition.duration.toFixed(1)}s
                      </span>
                    </div>
                    <Slider
                      id={`rs-tr-duration-${index}`}
                      min={0.1}
                      max={5}
                      step={0.1}
                      value={[transition.duration]}
                      onValueChange={([v]) =>
                        updateTransition(index, { duration: v })
                      }
                      aria-label={`Transition ${index + 1} duration in seconds`}
                      aria-valuetext={`${transition.duration.toFixed(1)} seconds`}
                    />
                  </div>
                </TabsContent>
              ))}
            </Tabs>
          )}
        </fieldset>
      </div>
    </TooltipProvider>
  );
}
