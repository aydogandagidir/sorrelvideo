/**
 * Script → talking-host video orchestrator: TTS the script (ttsService),
 * word-time it (transcriptionService), charge ONE AI unit (after provider
 * success — the routes/ai.ts precedent), persist the narration, create a
 * `talking-host` project, and auto-start its render (startProjectRender).
 *
 * Narration persistence is belt-and-braces: the MP3 is ALWAYS written to
 * `renders/<projectId>/voice.mp3` (dev works with zero GCS config; the
 * creation-time render reads it directly) AND uploaded to a private GCS object
 * when storage is configured (durable across container restarts, so a
 * re-render keeps its voice). `RenderSettings.voiceover` carries the object
 * path (or null) + the speech start offset.
 *
 * A render-quota block does NOT fail the creation: the AI unit bought a real
 * narration, so the project survives as a draft and the caller surfaces
 * `renderStarted: false` + `renderMessage`.
 */
import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import {
  db,
  projectsTable,
  DEFAULT_RENDER_SETTINGS,
  type BrandKit,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { assertSafeCompositionVars } from "../lib/compositionVars";
import { ObjectStorageService } from "../lib/objectStorage";
import { getBrandKit, getDefaultBrandKit } from "./brandKitService";
import { checkAndIncrementAiCount } from "./billingService";
import {
  DEFAULT_TTS_VOICE,
  synthesizeSpeech,
  type TtsVoice,
} from "./ttsService";
import {
  transcribeBuffer,
  TranscriptionError,
  type TranscriptWord,
} from "./transcriptionService";
import { renderDirFor, VOICEOVER_FILENAME } from "./renderService";
import { startProjectRender } from "./renderStartService";

export const HOST_MODULE = "talking-host";
/** Seconds before speech starts — the host scales in first. */
export const HOST_INTRO_SECONDS = 0.9;
/** Seconds after the last word — captions clear, the host settles. */
export const HOST_OUTRO_SECONDS = 1.4;
/** ≈90s of speech; also enforced by the OpenAPI schema (maxLength). */
export const MAX_SCRIPT_CHARS = 1200;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Encode the composition payload: base64(JSON({ intro, outro, words:
 * [[text, start, end], …] })). Base64 survives the {{key}} substitution's
 * markup-escaping byte-identical, so no quoting/escaping hazard can corrupt it.
 */
export function buildHostPayload(
  words: TranscriptWord[],
  intro: number,
  outro: number,
): string {
  const compact = words.map((w) => [w.text, round2(w.start), round2(w.end)]);
  const json = JSON.stringify({ intro, outro, words: compact });
  return Buffer.from(json, "utf-8").toString("base64");
}

/**
 * Composition duration: intro + audio + outro, where audio prefers Whisper's
 * reported clip duration and falls back to the last word's end. Clamped to a
 * sane 3–120s window (the script-length cap bounds it anyway) and rounded to
 * one decimal — it lands in `data-duration="…"`.
 */
export function computeHostDuration(
  words: TranscriptWord[],
  whisperDuration: number | null,
): number {
  const lastEnd = words.length > 0 ? words[words.length - 1].end : 0;
  const audio =
    whisperDuration !== null && whisperDuration > 0
      ? whisperDuration
      : lastEnd > 0
        ? lastEnd
        : 3;
  const total = HOST_INTRO_SECONDS + audio + HOST_OUTRO_SECONDS;
  return Math.round(Math.max(3, Math.min(120, total)) * 10) / 10;
}

/** Project name from the script's opening words (~48 chars, word-trimmed). */
export function hostProjectName(script: string): string {
  const collapsed = script.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 48) return collapsed || "Talking host video";
  const cut = collapsed.slice(0, 48);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 24 ? lastSpace : 48).trimEnd()}…`;
}

const VOICE_TONES: Record<string, string> = {
  professional: "clear, confident and professional",
  playful: "upbeat, playful and friendly",
  bold: "energetic, bold and punchy",
  minimal: "calm, measured and understated",
};

/**
 * Map the brand kit's voice/personality to a TTS `instructions` line
 * (gpt-4o-mini-tts tone steering). Undefined when the kit carries no voice
 * signal — the model's default delivery is fine.
 */
export function buildVoiceInstructions(
  kit: Pick<BrandKit, "brandVoice" | "personality" | "voiceDescription"> | null,
): string | undefined {
  if (!kit) return undefined;
  const parts: string[] = [];
  const tone = kit.brandVoice ? VOICE_TONES[kit.brandVoice] : undefined;
  if (tone) parts.push(`Speak in a ${tone} tone.`);
  const personality = (kit.personality ?? []).filter(
    (p) => typeof p === "string" && p.trim().length > 0,
  );
  if (personality.length > 0) {
    parts.push(`Brand personality: ${personality.slice(0, 4).join(", ")}.`);
  }
  if (kit.voiceDescription && kit.voiceDescription.trim().length > 0) {
    parts.push(kit.voiceDescription.trim().slice(0, 200));
  }
  if (parts.length === 0) return undefined;
  return parts.join(" ").slice(0, 400);
}

type ProjectRow = typeof projectsTable.$inferSelect;

export interface CreateTalkingHostResult {
  project: ProjectRow;
  /** False → created as a draft (e.g. render quota exhausted). */
  renderStarted: boolean;
  /** User-facing explanation when the render did not start. */
  renderMessage: string | null;
}

export async function createTalkingHostVideo(
  userId: string,
  opts: { script: string; voice?: TtsVoice; brandKitId?: number },
): Promise<CreateTalkingHostResult> {
  const script = opts.script.replace(/\s+/g, " ").trim();

  // Brand kit (cheap, BEFORE any paid call): explicit kit when owned, else the
  // user's default, else none — the same resolution renderService applies at
  // render time, so what styles the TTS tone also styles the frame.
  const kit =
    (opts.brandKitId != null
      ? await getBrandKit(userId, opts.brandKitId)
      : null) ?? (await getDefaultBrandKit(userId));
  const instructions = buildVoiceInstructions(kit);

  // Paid provider calls — failures here must NOT charge the AI unit.
  const mp3 = await synthesizeSpeech({
    input: script,
    voice: opts.voice ?? DEFAULT_TTS_VOICE,
    instructions,
  });
  const { words, duration: audioDuration } = await transcribeBuffer(
    mp3,
    "audio/mpeg",
  );
  if (words.length === 0) {
    // A host with no word timings can't lip-sync or caption — treat exactly
    // like a provider failure (502), before any quota charge.
    throw new TranscriptionError("Could not time the narration", 502);
  }

  // Charge ONE AI unit only after both providers succeeded (ai.ts precedent —
  // a provider 502 must not burn a Free user's monthly unit). Throws the
  // standard 403 { reason: "upgrade_required" } shape when out of quota.
  await checkAndIncrementAiCount(userId);

  // Durable copy (best-effort): GCS unconfigured / upload failure degrades to
  // the local render-dir file only.
  let objectPath: string | null = null;
  try {
    objectPath = await new ObjectStorageService().uploadPrivateObject(
      mp3,
      "audio/mpeg",
      { owner: userId, visibility: "private" },
    );
  } catch (err) {
    logger.warn(
      { err, userId },
      "Voiceover GCS upload unavailable; keeping the local copy only",
    );
  }

  const payload = buildHostPayload(words, HOST_INTRO_SECONDS, HOST_OUTRO_SECONDS);
  const duration = computeHostDuration(words, audioDuration);
  const compositionVars: Record<string, string> = {
    "host.payload": payload,
    duration: String(duration),
  };
  // Defense in depth, mirroring websiteToVideoService — host.payload is
  // unconstrained (base64), but the write path stays uniformly validated.
  assertSafeCompositionVars(compositionVars);

  const [project] = await db
    .insert(projectsTable)
    .values({
      userId,
      name: hostProjectName(script),
      module: HOST_MODULE,
      compositionVars,
      brandKitId: kit?.id ?? null,
      renderSettings: {
        ...DEFAULT_RENDER_SETTINGS,
        resolution: "portrait",
        voiceover: {
          objectPath,
          startAt: HOST_INTRO_SECONDS,
          volume: 100,
        },
      },
    })
    .returning();

  // Stage the narration as the render-dir sibling the pipeline prefers. If even
  // this fails AND there is no durable copy, the project could never render —
  // remove it and surface the failure instead of stranding a dead row.
  try {
    const dir = renderDirFor(project.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, VOICEOVER_FILENAME), mp3);
  } catch (err) {
    if (!objectPath) {
      logger.error(
        { err, userId, projectId: project.id },
        "Could not persist the narration anywhere; rolling back the project",
      );
      await db
        .delete(projectsTable)
        .where(eq(projectsTable.id, project.id))
        .catch(() => undefined);
      throw new Error("Could not store the narration audio");
    }
    logger.warn(
      { err, userId, projectId: project.id },
      "Could not write the local narration copy; render will use the GCS copy",
    );
  }

  // Auto-render. Expected blocks degrade to "saved as draft" — the AI unit
  // already bought a real narration, so the project must survive.
  const start = await startProjectRender(userId, project);
  if (start.ok) {
    return { project: start.project, renderStarted: true, renderMessage: null };
  }
  if (start.code === "upgrade_required") {
    return {
      project,
      renderStarted: false,
      renderMessage:
        "Your monthly render limit is used up — the video was saved as a draft.",
    };
  }
  return {
    project,
    renderStarted: false,
    renderMessage:
      "The render couldn't start — open the project and press Render.",
  };
}
