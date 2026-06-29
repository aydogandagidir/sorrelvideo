/**
 * Smart Trim orchestrator (the footage-cleanup analogue of talkingHostService).
 * Takes a user-uploaded raw video object, word-times its audio with Whisper,
 * computes an EDL (filler + silence removal), persists a `smart-trim` project,
 * and auto-starts its render — which `executeRender` routes to the FFmpeg trim
 * branch (runSmartTrimRender) instead of the Hyperframes producer.
 *
 * Mirrors talking-host's economics: ONE AI unit is charged AFTER transcription
 * succeeds (a provider failure never burns a Free unit), and a render-quota block
 * degrades to a saved draft rather than failing the creation. Burned captions are
 * Pro-only and silently dropped for Free so the trim still renders (a Free
 * caption request must not strand the just-paid draft at the render-time gate).
 */
import fs from "fs";
import os from "os";
import path from "path";
import { eq } from "drizzle-orm";
import {
  db,
  projectsTable,
  usersTable,
  DEFAULT_RENDER_SETTINGS,
  type RenderCaptionWord,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { assertSafeCompositionVars } from "../lib/compositionVars";
import { ObjectStorageService } from "../lib/objectStorage";
import { ObjectPermission } from "../lib/objectAcl";
import { getBrandKit, getDefaultBrandKit } from "./brandKitService";
import { checkAndIncrementAiCount, getUserPlan } from "./billingService";
import {
  transcribeBuffer,
  TranscriptionError,
} from "./transcriptionService";
import {
  computeKeepSegments,
  remapWordsToTrimmed,
  totalKeptDuration,
} from "../lib/smartTrimEdl";
import {
  extractAudio,
  encodeSmartTrimPayload,
  SMART_TRIM_MODULE,
  VideoTrimError,
} from "./videoTrimService";
import { startProjectRender } from "./renderStartService";

/** Source bigger than this is rejected before download (re-encode is heavy). */
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
/** Source longer than this is rejected (render cost; Whisper caps audio at 25MB). */
const MAX_SOURCE_SECONDS = 30 * 60;

/** A caller-facing Smart Trim failure; `status` is the HTTP code the route returns. */
export class SmartTrimError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 413 = 400,
  ) {
    super(message);
    this.name = "SmartTrimError";
  }
}

export interface SmartTrimOptions {
  videoObjectPath: string;
  removeFillers?: boolean;
  removeSilences?: boolean;
  silenceThresholdMs?: number;
  captions?: boolean;
  brandKitId?: number;
}

type ProjectRow = typeof projectsTable.$inferSelect;

export interface CreateSmartTrimResult {
  project: ProjectRow;
  /** False → created as a draft (e.g. render quota exhausted). */
  renderStarted: boolean;
  /** User-facing explanation when the render did not start. */
  renderMessage: string | null;
}

async function getPlanForUser(userId: string): Promise<"free" | "pro"> {
  const [u] = await db
    .select({ stripeCustomerId: usersTable.stripeCustomerId })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return getUserPlan(u?.stripeCustomerId ?? null);
}

export async function createSmartTrimVideo(
  userId: string,
  opts: SmartTrimOptions,
): Promise<CreateSmartTrimResult> {
  const objectPath = opts.videoObjectPath;

  // Resolve + owner-check the source, and size-gate BEFORE the expensive download.
  const storage = new ObjectStorageService();
  let file: Awaited<ReturnType<ObjectStorageService["getObjectEntityFile"]>>;
  try {
    file = await storage.getObjectEntityFile(objectPath);
  } catch {
    throw new SmartTrimError("Source video not found", 404);
  }
  const canRead = await storage.canAccessObjectEntity({
    userId,
    objectFile: file,
    requestedPermission: ObjectPermission.READ,
  });
  if (!canRead) throw new SmartTrimError("Source video not found", 404);
  const [meta] = await file.getMetadata();
  if (Number(meta.size ?? 0) > MAX_VIDEO_BYTES) {
    throw new SmartTrimError("Video is too large (max 500MB)", 413);
  }

  // Download → extract a small audio track → transcribe. The temp dir is removed
  // in `finally`; the render branch re-downloads the source fresh (re-validated)
  // so nothing here needs to survive into the (possibly out-of-process) render.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sorrel-smarttrim-"));
  try {
    const srcPath = path.join(tmpDir, "source");
    await file.download({ destination: srcPath });

    const audioPath = path.join(tmpDir, "audio.m4a");
    try {
      await extractAudio(srcPath, audioPath);
    } catch (err) {
      if (err instanceof VideoTrimError) {
        throw new SmartTrimError("That file could not be read as a video", 400);
      }
      throw err;
    }

    const audioBuf = fs.readFileSync(audioPath);
    // transcribeBuffer throws TranscriptionNotConfiguredError (503) /
    // TranscriptionError (413 oversize / 502 provider) — the route maps both.
    const { words, duration } = await transcribeBuffer(audioBuf, "audio/mp4");
    if (words.length === 0) {
      throw new TranscriptionError("Could not transcribe the video", 502);
    }
    const sourceDuration =
      duration && duration > 0 ? duration : words[words.length - 1].end;
    if (sourceDuration > MAX_SOURCE_SECONDS) {
      throw new SmartTrimError("Video is too long (max 30 minutes)", 413);
    }

    // Charge ONE AI unit only after transcription succeeded (talking-host /
    // ai.ts precedent). Throws the standard 403 { reason: "upgrade_required" }.
    await checkAndIncrementAiCount(userId);

    const removeFillers = opts.removeFillers ?? true;
    const segments = computeKeepSegments(words, sourceDuration, {
      removeFillers,
      removeSilences: opts.removeSilences ?? true,
      silenceThresholdSec: (opts.silenceThresholdMs ?? 600) / 1000,
    });

    // Captions are Pro-only; dropping them for Free keeps the trim renderable
    // (the render-time gate would otherwise 403 a Free caption request AFTER the
    // AI unit was spent, stranding the draft).
    const plan = await getPlanForUser(userId);
    const captionWords: RenderCaptionWord[] =
      (opts.captions ?? false) && plan === "pro"
        ? remapWordsToTrimmed(words, segments, { removeFillers })
        : [];

    const kit =
      (opts.brandKitId != null
        ? await getBrandKit(userId, opts.brandKitId)
        : null) ?? (await getDefaultBrandKit(userId));

    const compositionVars: Record<string, string> = {
      "smarttrim.payload": encodeSmartTrimPayload({ source: objectPath, segments }),
    };
    // Defense in depth (mirrors talking-host): base64 is inert, but the write
    // path stays uniformly validated.
    assertSafeCompositionVars(compositionVars);

    const [project] = await db
      .insert(projectsTable)
      .values({
        userId,
        name: "Trimmed video",
        module: SMART_TRIM_MODULE,
        compositionVars,
        brandKitId: kit?.id ?? null,
        renderSettings: {
          ...DEFAULT_RENDER_SETTINGS,
          format: "mp4",
          ...(captionWords.length > 0 ? { captions: { words: captionWords } } : {}),
        },
      })
      .returning();

    logger.info(
      {
        userId,
        projectId: project.id,
        keptSegments: segments.length,
        trimmedDuration: Math.round(totalKeptDuration(segments)),
        sourceDuration: Math.round(sourceDuration),
        captions: captionWords.length,
      },
      "Smart Trim project created",
    );

    // Auto-render. Expected blocks degrade to "saved as draft" — the AI unit
    // already paid for the transcript, so the project must survive.
    const start = await startProjectRender(userId, project);
    if (start.ok) {
      return { project: start.project, renderStarted: true, renderMessage: null };
    }
    if (start.code === "upgrade_required") {
      return {
        project,
        renderStarted: false,
        renderMessage:
          "Your monthly render limit is used up — the trim was saved as a draft.",
      };
    }
    return {
      project,
      renderStarted: false,
      renderMessage:
        "The render couldn't start — open the project and press Render.",
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
