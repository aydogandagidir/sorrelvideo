/**
 * LiveAvatar session-token service (Track F) — mints a short-lived HeyGen
 * LiveAvatar session token server-side so the API key never reaches the browser.
 * The frontend feeds the token to `@heygen/liveavatar-web-sdk`'s
 * `LiveAvatarSession` to open a real-time, conversational avatar stream.
 *
 * Mirrors the reference flow (liveavatar-web-sdk apps/demo start-session route):
 * POST {LIVEAVATAR_API_URL}/v1/sessions/token with X-API-KEY → { data: {
 * session_token, session_id } }.
 *
 * CONFIG-GATED: needs `LIVEAVATAR_API_KEY`. Avatar/voice/context default to the
 * reference sandbox avatar so it works out-of-the-box in sandbox; override via
 * env. When the key is unset the route 503s and the UI hides the feature.
 *
 * SEPARATE product line: this does NOT touch the batch render pipeline (BullMQ /
 * FFmpeg / Hyperframes). Per-minute billing is DEFERRED — see routes/avatar.ts.
 */
import { logger } from "../lib/logger";

export interface LiveAvatarSessionToken {
  sessionToken: string;
  sessionId: string;
  /** Whether the session was created in sandbox mode (no credit consumption). */
  sandbox: boolean;
}

/** No LiveAvatar API key configured → the route maps this to 503. */
export class LiveAvatarNotConfiguredError extends Error {
  readonly status = 503 as const;
  constructor() {
    super("Live avatar is not configured");
    this.name = "LiveAvatarNotConfiguredError";
  }
}

/** Upstream LiveAvatar failure; `status` is the HTTP code the route returns. */
export class LiveAvatarError extends Error {
  constructor(
    message: string,
    readonly status: 502 = 502,
  ) {
    super(message);
    this.name = "LiveAvatarError";
  }
}

/** Whether a LiveAvatar API key is configured (used to gate + hide the UI). */
export function isLiveAvatarConfigured(): boolean {
  return Boolean(process.env.LIVEAVATAR_API_KEY);
}

/** Whether sessions run in sandbox mode (no credit consumption) — the default. */
export function isLiveAvatarSandbox(): boolean {
  return (process.env.LIVEAVATAR_SANDBOX ?? "true") !== "false";
}

const DEFAULT_API_URL = "https://api.liveavatar.com";
// Reference sandbox avatar/voice/context (liveavatar-web-sdk demo) so a fresh
// LIVEAVATAR_API_KEY works immediately in sandbox; override via env for prod.
const DEFAULT_AVATAR_ID = "dd73ea75-1218-4ef3-92ce-606d5f7fbc0a";
const DEFAULT_VOICE_ID = "c2527536-6d1f-4412-a643-53a3497dada9";
const DEFAULT_CONTEXT_ID = "5b9dba8a-aa31-11f0-a6ee-066a7fa2e369";

export interface MintTokenOptions {
  pushToTalk?: boolean;
}

/**
 * Mint a FULL-mode LiveAvatar session token. Throws
 * LiveAvatarNotConfiguredError (no key) or LiveAvatarError (upstream failure).
 */
export async function mintSessionToken(
  opts: MintTokenOptions = {},
): Promise<LiveAvatarSessionToken> {
  const apiKey = process.env.LIVEAVATAR_API_KEY;
  if (!apiKey) throw new LiveAvatarNotConfiguredError();

  const apiUrl = process.env.LIVEAVATAR_API_URL ?? DEFAULT_API_URL;
  const avatarId = process.env.LIVEAVATAR_AVATAR_ID ?? DEFAULT_AVATAR_ID;
  const voiceId = process.env.LIVEAVATAR_VOICE_ID ?? DEFAULT_VOICE_ID;
  const contextId = process.env.LIVEAVATAR_CONTEXT_ID ?? DEFAULT_CONTEXT_ID;
  const language = process.env.LIVEAVATAR_LANGUAGE ?? "en";
  // Sandbox by default (no credit consumption); set LIVEAVATAR_SANDBOX=false for live.
  const isSandbox = isLiveAvatarSandbox();

  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(`${apiUrl}/v1/sessions/token`, {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "FULL",
        avatar_id: avatarId,
        avatar_persona: {
          voice_id: voiceId,
          context_id: contextId,
          language,
        },
        ...(opts.pushToTalk ? { interactivity_type: "PUSH_TO_TALK" } : {}),
        is_sandbox: isSandbox,
      }),
    });
  } catch (err) {
    logger.error({ err }, "LiveAvatar token request threw");
    throw new LiveAvatarError("Live avatar service unavailable");
  }

  if (!res.ok) {
    logger.error({ status: res.status }, "LiveAvatar token API returned error");
    throw new LiveAvatarError("Could not start an avatar session");
  }

  const data = (await res.json()) as {
    data?: { session_token?: string; session_id?: string };
  };
  const sessionToken = data.data?.session_token;
  if (!sessionToken) throw new LiveAvatarError("Avatar session token missing");
  return {
    sessionToken,
    sessionId: data.data?.session_id ?? "",
    sandbox: isSandbox,
  };
}
