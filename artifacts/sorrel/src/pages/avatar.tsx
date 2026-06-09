import { useEffect, useRef, useState } from "react";
import { LiveAvatarSession, SessionEvent } from "@heygen/liveavatar-web-sdk";
import { Bot, Loader2, Mic, PhoneOff, Sparkles } from "lucide-react";
import {
  useCreateAvatarSessionToken,
  useGetAvatarUsage,
} from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { UpgradeModal } from "@/components/upgrade-modal";

type Status = "idle" | "connecting" | "live" | "error";

/**
 * Live Avatar (Track F) — a real-time, conversational HeyGen LiveAvatar.
 * A short-lived session token is minted server-side (POST /api/avatar/session-token,
 * which holds LIVEAVATAR_API_KEY); the @heygen/liveavatar-web-sdk LiveAvatarSession
 * opens the WebRTC stream and we attach() the remote tracks to a <video>.
 *
 * This is a SEPARATE product line from the batch render pipeline. Pro-gated;
 * config-gated server-side (503 → we surface a "not enabled" note). Runs in
 * sandbox by default (no credit consumption) until per-minute billing is wired.
 */
export default function AvatarPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const sessionRef = useRef<LiveAvatarSession | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const createToken = useCreateAvatarSessionToken();
  const { data: usage } = useGetAvatarUsage();

  async function start() {
    setError(null);
    setStatus("connecting");
    try {
      const { sessionToken } = await createToken.mutateAsync({ data: {} });
      const session = new LiveAvatarSession(sessionToken, { voiceChat: true });
      sessionRef.current = session;
      session.on(SessionEvent.SESSION_STREAM_READY, () => {
        if (videoRef.current) session.attach(videoRef.current);
        setStatus("live");
      });
      session.on(SessionEvent.SESSION_DISCONNECTED, () => {
        sessionRef.current = null;
        setStatus("idle");
      });
      await session.start();
    } catch (err) {
      const e = err as {
        status?: number;
        data?: { error?: string; reason?: string };
      };
      sessionRef.current = null;
      if (e.data?.reason === "avatar_limit") {
        setError(
          e.data?.error ??
            "You've reached your monthly avatar session limit — it resets next month.",
        );
        setStatus("error");
        return;
      }
      if (e.status === 403) {
        setShowUpgrade(true);
        setStatus("idle");
        return;
      }
      if (e.status === 503) {
        setError("The live avatar isn't enabled on this server yet.");
        setStatus("error");
        return;
      }
      setError(e.data?.error ?? "Could not start the avatar session.");
      setStatus("error");
    }
  }

  async function stop() {
    try {
      await sessionRef.current?.stop();
    } catch {
      /* ignore — we're tearing down anyway */
    }
    sessionRef.current = null;
    setStatus("idle");
  }

  // Tear the session down if the user navigates away while it's live.
  useEffect(() => {
    return () => {
      void sessionRef.current?.stop();
      sessionRef.current = null;
    };
  }, []);

  const connecting = status === "connecting" || createToken.isPending;

  return (
    <Layout>
      <div className="mx-auto max-w-[760px]">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[27px] leading-tight">Live Avatar</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              A real-time, conversational AI avatar — talk to it with your voice.
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-[11.5px] font-semibold text-primary">
            <Sparkles className="h-3.5 w-3.5" /> Beta
          </span>
        </div>

        <Card>
          <CardContent className="flex flex-col items-center gap-4 p-5">
            <div className="relative aspect-[3/4] w-full max-w-[420px] overflow-hidden rounded-xl border bg-secondary">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                className="h-full w-full object-cover"
              />
              {status !== "live" && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
                  {connecting ? (
                    <>
                      <Loader2 className="h-8 w-8 animate-spin text-primary" />
                      <span className="text-sm">Connecting…</span>
                    </>
                  ) : (
                    <>
                      <Bot className="h-10 w-10" />
                      <span className="text-sm">
                        {status === "error"
                          ? "Session ended"
                          : "Ready when you are"}
                      </span>
                    </>
                  )}
                </div>
              )}
              {status === "live" && (
                <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-spark/90 px-2 py-0.5 text-[11px] font-semibold text-white">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                  LIVE
                </span>
              )}
            </div>

            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}

            {status === "live" ? (
              <div className="flex flex-col items-center gap-2">
                <Button type="button" variant="destructive" onClick={stop}>
                  <PhoneOff className="h-4 w-4" /> End conversation
                </Button>
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Mic className="h-3.5 w-3.5" /> Just speak — the avatar listens
                  and replies.
                </p>
              </div>
            ) : (
              <Button
                type="button"
                size="lg"
                onClick={start}
                disabled={connecting}
              >
                {connecting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Connecting…
                  </>
                ) : (
                  <>
                    <Bot className="h-4 w-4" /> Start conversation
                  </>
                )}
              </Button>
            )}

            <p className="text-center text-[11.5px] text-muted-foreground">
              {usage?.sandbox === false
                ? `${usage.used} of ${usage.limit} sessions used this month.`
                : "Sandbox mode — free and unlimited."}
            </p>
          </CardContent>
        </Card>
      </div>
      <UpgradeModal
        open={showUpgrade}
        onOpenChange={setShowUpgrade}
        reason="premium_template"
      />
    </Layout>
  );
}
