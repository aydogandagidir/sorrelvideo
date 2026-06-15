import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Bot, Clapperboard, Loader2, Mic, Send, Sparkles, Zap } from "lucide-react";
import {
  useAvatarChat,
  useCreateAvatarVideo,
} from "@workspace/api-client-react";
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { UpgradeModal } from "@/components/upgrade-modal";

type Msg = { role: "user" | "assistant"; content: string };
type Status = "idle" | "listening" | "thinking" | "speaking" | "error";

/**
 * Live Avatar — the browser-native conversational avatar (Track F, self-hosted
 * path). The browser does speech-to-text + text-to-speech, so there is no GPU
 * and no per-minute SaaS cost; the only server work is the brand-voiced LLM turn
 * (POST /api/avatar/chat), which is a PRO feature (the route 403s Free users —
 * see api-server/src/routes/avatar.ts). A stylized SVG face lip-syncs while it
 * speaks.
 *
 * Voice in (SpeechRecognition) is Chrome/Edge-only — everywhere else the typed
 * input is the path, so the feature degrades gracefully. Voice OUT
 * (speechSynthesis) is available in every modern browser.
 */

// Minimal Web Speech typings (not in the DOM lib across all TS configs).
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult:
    | ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void)
    | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

function speechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Animated, brand-neutral SVG host. Eyes blink; mouth opens while speaking. */
function AvatarFace({ state }: { state: Status }) {
  const speaking = state === "speaking";
  const listening = state === "listening";
  return (
    <div className="relative flex h-44 w-44 items-center justify-center">
      <div
        className={`absolute inset-0 rounded-full bg-primary/20 blur-2xl transition-opacity ${
          speaking || listening ? "opacity-100" : "opacity-40"
        }`}
      />
      {listening && (
        <span className="absolute inset-0 animate-ping rounded-full border-2 border-primary/40" />
      )}
      <svg
        viewBox="0 0 120 120"
        className="relative h-40 w-40"
        role="img"
        aria-label="Avatar"
      >
        <defs>
          <linearGradient id="avahead" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="hsl(var(--primary))" />
            <stop offset="1" stopColor="hsl(var(--spark))" />
          </linearGradient>
        </defs>
        <circle cx="60" cy="60" r="52" fill="url(#avahead)" opacity="0.18" />
        <circle
          cx="60"
          cy="60"
          r="46"
          fill="hsl(var(--card))"
          stroke="url(#avahead)"
          strokeWidth="3"
        />
        {/* eyes */}
        <g className="avatar-eyes" fill="hsl(var(--foreground))">
          <circle cx="45" cy="52" r="5" />
          <circle cx="75" cy="52" r="5" />
        </g>
        {/* mouth: a rounded rect that scales vertically while speaking */}
        <rect
          x="46"
          y="74"
          width="28"
          height={speaking ? 12 : 4}
          rx="6"
          fill="hsl(var(--foreground))"
          className={speaking ? "avatar-mouth-speaking" : ""}
          style={{ transformBox: "fill-box", transformOrigin: "center" }}
        />
      </svg>
      <style>{`
        @keyframes avatarBlink { 0%,92%,100% { transform: scaleY(1); } 96% { transform: scaleY(0.1); } }
        .avatar-eyes { transform-box: fill-box; transform-origin: center; animation: avatarBlink 4.5s infinite; }
        @keyframes avatarTalk { 0%,100% { transform: scaleY(0.5); } 50% { transform: scaleY(1.25); } }
        .avatar-mouth-speaking { animation: avatarTalk 0.28s ease-in-out infinite; }
      `}</style>
    </div>
  );
}

/** The OpenAI speech voices exposed by POST /api/avatar/video. */
const VIDEO_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
] as const;
type VideoVoice = (typeof VIDEO_VOICES)[number];
const MAX_SCRIPT_CHARS = 1200;

/**
 * Script → talking-host video panel: the avatar's render-pipeline value. Type
 * a script, pick a voice, and the backend TTSes it, word-times it, creates a
 * `talking-host` project and auto-starts the render — we land on /projects
 * where the regular polling + video dialog take over.
 */
function ScriptToVideoPanel({
  onUpgradeRequired,
}: {
  onUpgradeRequired: () => void;
}) {
  const [script, setScript] = useState("");
  const [voice, setVoice] = useState<VideoVoice>("alloy");
  const [error, setError] = useState<string | null>(null);
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const createVideo = useCreateAvatarVideo();

  const ready = script.trim().length >= 10 && !createVideo.isPending;

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!ready) return;
    setError(null);
    try {
      const res = await createVideo.mutateAsync({ data: { script, voice } });
      if (!res.renderStarted && res.renderMessage) {
        toast({ title: "Saved as draft", description: res.renderMessage });
      }
      setLocation(`/projects?focus=${res.project.id}`);
    } catch (err) {
      const e2 = err as { status?: number; data?: { error?: string } };
      if (e2.status === 403) {
        onUpgradeRequired();
        return;
      }
      if (e2.status === 503) {
        setError(
          "Text-to-speech isn't enabled on this server yet — an admin needs to set an OpenAI key.",
        );
        return;
      }
      setError(e2.data?.error ?? "Couldn't create the video. Try again.");
    }
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clapperboard className="h-5 w-5 text-primary" />
          Script → video
        </CardTitle>
        <CardDescription>
          Your host reads the script aloud — branded, lip-synced, with karaoke
          captions — and renders straight to MP4.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <Textarea
            value={script}
            onChange={(e) => setScript(e.target.value.slice(0, MAX_SCRIPT_CHARS))}
            placeholder="Hi! Here's what makes our product different…"
            rows={5}
            disabled={createVideo.isPending}
            aria-label="Video script"
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Select
                value={voice}
                onValueChange={(v) => setVoice(v as VideoVoice)}
                disabled={createVideo.isPending}
              >
                <SelectTrigger className="w-[130px]" aria-label="Voice">
                  <SelectValue placeholder="Voice" />
                </SelectTrigger>
                <SelectContent>
                  {VIDEO_VOICES.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v.charAt(0).toUpperCase() + v.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-[11px] text-muted-foreground">
                {script.length}/{MAX_SCRIPT_CHARS}
              </span>
            </div>
            <Button type="submit" disabled={!ready}>
              {createVideo.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating…
                </>
              ) : (
                <>
                  <Sparkles className="mr-2 h-4 w-4" />
                  Create video
                </>
              )}
            </Button>
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <p className="text-[11px] text-muted-foreground">
            Uses 1 AI credit per video; the render uses your monthly renders.
            Voiced in your brand&apos;s tone when a Brand DNA is set.
          </p>
        </form>
      </CardContent>
    </Card>
  );
}

export default function AvatarPage() {
  const [started, setStarted] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [upgradeReason, setUpgradeReason] = useState<"avatar" | "ai_limit">(
    "avatar",
  );

  const chat = useAvatarChat();
  const recogRef = useRef<SpeechRecognitionLike | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sttSupported = speechRecognitionCtor() !== null;
  const { data: billing } = useBillingInfo();
  const isPro = billing?.plan === "pro";

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, status]);

  // Tear down speech on unmount so a reply doesn't keep talking after navigation.
  useEffect(() => {
    return () => {
      window.speechSynthesis?.cancel();
      recogRef.current?.stop();
    };
  }, []);

  const speak = useCallback((text: string) => {
    const synth = window.speechSynthesis;
    if (!synth) {
      setStatus("idle");
      return;
    }
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1;
    u.onend = () => setStatus("idle");
    u.onerror = () => setStatus("idle");
    setStatus("speaking");
    synth.speak(u);
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || chat.isPending) return;
      setError(null);
      setDraft("");
      const next: Msg[] = [...messages, { role: "user", content: trimmed }];
      setMessages(next);
      setStatus("thinking");
      try {
        const res = await chat.mutateAsync({ data: { messages: next } });
        setMessages((m) => [...m, { role: "assistant", content: res.reply }]);
        speak(res.reply);
      } catch (err) {
        const e = err as { status?: number; data?: { error?: string } };
        if (e.status === 403) {
          setUpgradeReason("avatar");
          setShowUpgrade(true);
          setStatus("idle");
          return;
        }
        if (e.status === 503) {
          setError(
            "The avatar isn't enabled on this server yet — an admin needs to set an AI key.",
          );
          setStatus("error");
          return;
        }
        setError(e.data?.error ?? "The avatar could not reply. Try again.");
        setStatus("error");
      }
    },
    [messages, chat, speak],
  );

  const listen = useCallback(() => {
    const Ctor = speechRecognitionCtor();
    if (!Ctor || chat.isPending) return;
    window.speechSynthesis?.cancel();
    const r = new Ctor();
    recogRef.current = r;
    r.lang = "en-US";
    r.continuous = false;
    r.interimResults = false;
    r.onresult = (e) => {
      const transcript = e.results?.[0]?.[0]?.transcript ?? "";
      if (transcript.trim()) void send(transcript);
      else setStatus("idle");
    };
    r.onerror = () => setStatus("idle");
    r.onend = () => setStatus((s) => (s === "listening" ? "idle" : s));
    setStatus("listening");
    r.start();
  }, [send, chat.isPending]);

  function start() {
    setStarted(true);
    const greeting =
      "Hi! I'm your brand's assistant. Tap the mic and talk, or type below — ask me anything.";
    setMessages([{ role: "assistant", content: greeting }]);
    speak(greeting);
  }

  const statusLabel: Record<Status, string> = {
    idle: "Ready",
    listening: "Listening…",
    thinking: "Thinking…",
    speaking: "Speaking…",
    error: "Ready",
  };

  return (
    <Layout>
      <div className="mx-auto max-w-[760px]">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[27px] leading-tight">Live Avatar</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              A real-time, conversational AI host — talk to it with your voice.
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-[11.5px] font-semibold text-primary">
            <Zap className="h-3.5 w-3.5" /> Pro
          </span>
        </div>

        <Card>
          <CardContent className="flex flex-col items-center gap-5 p-5">
            <AvatarFace state={status} />

            {!started ? (
              <>
                {isPro ? (
                  <Button type="button" size="lg" onClick={start}>
                    <Bot className="h-4 w-4" /> Start conversation
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="lg"
                    onClick={() => {
                      setUpgradeReason("avatar");
                      setShowUpgrade(true);
                    }}
                  >
                    <Zap className="h-4 w-4" /> Unlock with Pro
                  </Button>
                )}
                <p className="text-center text-[11.5px] text-muted-foreground">
                  {isPro
                    ? "Answered in your brand voice — voiced by your browser, no credits used."
                    : "The Live Avatar is a Pro feature. Upgrade to talk to your brand's AI host live."}
                </p>
              </>
            ) : (
              <>
                <span className="text-xs font-medium text-muted-foreground">
                  {chat.isPending ? "Thinking…" : statusLabel[status]}
                </span>

                <div
                  ref={scrollRef}
                  className="flex max-h-[260px] w-full flex-col gap-2 overflow-y-auto"
                >
                  {messages.map((m, i) => (
                    <div
                      key={i}
                      className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm ${
                        m.role === "user"
                          ? "self-end bg-primary/15 text-foreground"
                          : "self-start bg-secondary text-foreground"
                      }`}
                    >
                      {m.content}
                    </div>
                  ))}
                </div>

                {error && (
                  <p className="text-sm text-destructive" role="alert">
                    {error}
                  </p>
                )}

                <form
                  className="flex w-full items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send(draft);
                  }}
                >
                  {sttSupported && (
                    <Button
                      type="button"
                      variant={status === "listening" ? "default" : "outline"}
                      size="icon"
                      onClick={listen}
                      disabled={chat.isPending}
                      aria-label="Talk"
                      title="Tap and speak"
                    >
                      <Mic className="h-4 w-4" />
                    </Button>
                  )}
                  <Input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={
                      sttSupported ? "Tap the mic or type…" : "Type a message…"
                    }
                    disabled={chat.isPending}
                  />
                  <Button
                    type="submit"
                    size="icon"
                    disabled={chat.isPending || !draft.trim()}
                    aria-label="Send"
                  >
                    {chat.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                  </Button>
                </form>

                {!sttSupported && (
                  <p className="text-center text-[11px] text-muted-foreground">
                    Voice input needs Chrome or Edge — typing works everywhere.
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <ScriptToVideoPanel
          onUpgradeRequired={() => {
            setUpgradeReason("ai_limit");
            setShowUpgrade(true);
          }}
        />
      </div>
      <UpgradeModal
        open={showUpgrade}
        onOpenChange={setShowUpgrade}
        reason={upgradeReason}
      />
    </Layout>
  );
}
