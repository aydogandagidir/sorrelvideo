/**
 * Pure EDL (edit decision list) math for the Smart Trim module — the
 * transcript-driven "clean up my raw footage" feature (inspired by
 * browser-use/video-use). Given word-level transcript timings, decide which
 * spans of the SOURCE video to KEEP (dropping filler words + over-long
 * silences), then remap caption words onto the resulting tightened timeline.
 *
 * Kept dependency-free (like `websiteCrop.ts`) so it unit-tests trivially and
 * can't drift from the FFmpeg cut+concat that consumes it (`videoTrimService`).
 * The input is structurally a `TranscriptWord` (see transcriptionService) and
 * the caption output is structurally a `RenderCaptionWord` (see db schema) — we
 * declare local shapes rather than import, to stay a leaf module.
 */

/** One transcript word with absolute source-timeline seconds. */
export interface TimedWord {
  text: string;
  /** Seconds from the start of the source. */
  start: number;
  /** Seconds from the start of the source. */
  end: number;
}

/** A half-open span of the SOURCE timeline to keep (or drop), in seconds. */
export interface Segment {
  start: number;
  end: number;
}

/** A caption word remapped onto the TRIMMED timeline (RenderCaptionWord-shaped). */
export interface TrimmedCaptionWord {
  text: string;
  start: number;
  end: number;
}

export interface KeepOptions {
  /** Drop non-lexical filler words ("um", "uh", …). Default true. */
  removeFillers?: boolean;
  /** Cut the dead air in any pause longer than the threshold. Default true. */
  removeSilences?: boolean;
  /** A pause longer than this (seconds) is trimmed (its middle dropped). Default 0.6. */
  silenceThresholdSec?: number;
  /** Breathing room kept on each side of a cut (seconds). Default 0.08. */
  padSec?: number;
  /** Filler vocabulary (lowercased, letters only). Defaults to DEFAULT_FILLER_WORDS. */
  fillerWords?: readonly string[];
  /** Kept spans shorter than this (seconds) are discarded as noise. Default 0.12. */
  minSegmentSec?: number;
}

/**
 * Non-lexical fillers dropped by default. Deliberately conservative: only sounds
 * that carry no meaning ("um"/"uh"/"er"/"hmm"…). Words like "like" / "you know"
 * are real vocabulary in most sentences, so they're OPT-IN via `fillerWords`,
 * not defaulted — matching video-use's umm/uh focus and avoiding butchered copy.
 */
export const DEFAULT_FILLER_WORDS: readonly string[] = [
  "um",
  "umm",
  "ummm",
  "uhm",
  "uh",
  "uhh",
  "uhhh",
  "er",
  "err",
  "erm",
  "ah",
  "ahh",
  "eh",
  "hmm",
  "hmmm",
  "mm",
  "mmm",
];

const DEFAULT_SILENCE_THRESHOLD_SEC = 0.6;
const DEFAULT_PAD_SEC = 0.08;
const DEFAULT_MIN_SEGMENT_SEC = 0.12;

/** Lowercase + strip everything but a–z, so "Um," / "UHH!" normalize to the token. */
function normalizeToken(text: string): string {
  return text.toLowerCase().replace(/[^a-z]/g, "");
}

/** Whether a transcript word is a filler given the active vocabulary. */
function isFiller(text: string, fillers: ReadonlySet<string>): boolean {
  const t = normalizeToken(text);
  return t.length > 0 && fillers.has(t);
}

/** Clamp, sort, and discard malformed words; cap ends at `duration`. */
function sanitizeWords(words: readonly TimedWord[], duration: number): TimedWord[] {
  return words
    .filter(
      (w) =>
        typeof w.start === "number" &&
        typeof w.end === "number" &&
        Number.isFinite(w.start) &&
        Number.isFinite(w.end) &&
        w.end > w.start &&
        w.start >= 0,
    )
    .map((w) => ({
      text: w.text,
      start: Math.max(0, w.start),
      end: Math.min(duration, w.end),
    }))
    .filter((w) => w.end > w.start)
    .sort((a, b) => a.start - b.start);
}

/** Merge overlapping/adjacent spans (sorted), discarding sub-`minLen` slivers. */
function mergeSegments(segs: Segment[], minLen: number): Segment[] {
  const sorted = [...segs]
    .filter((s) => s.end - s.start > 0)
    .sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    // A negative/zero gap (touching or overlapping) coalesces into one span.
    if (last && s.start <= last.end + 1e-6) {
      last.end = Math.max(last.end, s.end);
    } else {
      out.push({ start: s.start, end: s.end });
    }
  }
  return out.filter((s) => s.end - s.start >= minLen);
}

/**
 * Compute the spans of the SOURCE to KEEP. Builds DROP intervals (filler-word
 * spans + the middles of over-long pauses, each shrunk by `pad`) and subtracts
 * them from `[0, duration]`. The two toggles compose: a filler sitting inside a
 * long pause yields one merged drop → a single clean cut.
 *
 * Safe by construction: an empty / all-filler transcript or a degenerate
 * duration returns the WHOLE clip (`[{0, duration}]`) rather than nuking it.
 */
export function computeKeepSegments(
  words: readonly TimedWord[],
  duration: number,
  opts: KeepOptions = {},
): Segment[] {
  const removeFillers = opts.removeFillers ?? true;
  const removeSilences = opts.removeSilences ?? true;
  const threshold = Math.max(0, opts.silenceThresholdSec ?? DEFAULT_SILENCE_THRESHOLD_SEC);
  const pad = Math.max(0, opts.padSec ?? DEFAULT_PAD_SEC);
  const minSeg = Math.max(0, opts.minSegmentSec ?? DEFAULT_MIN_SEGMENT_SEC);
  const fillers = new Set(
    (opts.fillerWords ?? DEFAULT_FILLER_WORDS).map((w) => normalizeToken(w)),
  );

  // Resolve a usable duration: prefer the reported one, else the last word end.
  const ws = sanitizeWords(words, Number.isFinite(duration) && duration > 0 ? duration : Infinity);
  const lastEnd = ws.length ? ws[ws.length - 1].end : 0;
  const d = Number.isFinite(duration) && duration > 0 ? duration : lastEnd;
  if (d <= 0 || ws.length === 0) {
    return d > 0 ? [{ start: 0, end: d }] : [];
  }

  // If filler removal would leave no real words (the clip is all filler/silence),
  // keep it whole rather than emit a useless silence-only stub.
  if (removeFillers && !ws.some((w) => !isFiller(w.text, fillers))) {
    return [{ start: 0, end: d }];
  }

  const drops: Segment[] = [];

  // (1) Filler-word spans.
  if (removeFillers) {
    for (const w of ws) {
      if (isFiller(w.text, fillers)) drops.push({ start: w.start, end: w.end });
    }
  }

  // (2) Over-long pauses (incl. leading/trailing dead air). A "pause" is any
  // stretch of the timeline not covered by a word; the head gap is [0, first],
  // the tail gap is [last, duration]. Keep `pad` of each pause, drop the middle.
  if (removeSilences) {
    let cursor = 0;
    const boundaries: Segment[] = [
      ...ws.map((w) => ({ start: w.start, end: w.end })),
    ];
    for (const w of boundaries) {
      const gap = w.start - cursor;
      if (gap > threshold) {
        // Leading dead air keeps no head pad (nothing before it to breathe from).
        const dropStart = cursor === 0 ? 0 : cursor + pad;
        const dropEnd = w.start - pad;
        if (dropEnd > dropStart) drops.push({ start: dropStart, end: dropEnd });
      }
      cursor = Math.max(cursor, w.end);
    }
    // Trailing dead air after the last word.
    if (d - cursor > threshold) {
      const dropStart = cursor + pad;
      if (d > dropStart) drops.push({ start: dropStart, end: d });
    }
  }

  // Subtract merged drops from [0, d].
  const mergedDrops = mergeSegments(drops, 0).filter(
    (s) => s.end > s.start,
  );
  const keep: Segment[] = [];
  let pos = 0;
  for (const dseg of mergedDrops) {
    const start = Math.max(0, Math.min(d, dseg.start));
    const end = Math.max(0, Math.min(d, dseg.end));
    if (start > pos) keep.push({ start: pos, end: start });
    pos = Math.max(pos, end);
  }
  if (pos < d) keep.push({ start: pos, end: d });

  const cleaned = mergeSegments(keep, minSeg);
  // Never return nothing: if every span got trimmed away (pathological input),
  // fall back to the whole clip so the user still gets a (valid) render.
  return cleaned.length ? cleaned : [{ start: 0, end: d }];
}

/** Total kept length in seconds — the trimmed output's duration. */
export function totalKeptDuration(segments: readonly Segment[]): number {
  return segments.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
}

/**
 * Map a SOURCE-timeline instant onto the TRIMMED timeline: the summed length of
 * kept spans strictly before `t`, plus the offset into the span containing `t`.
 * A `t` that falls in a dropped gap collapses to the start of the next kept span
 * (its nearest surviving instant). Assumes `segments` is sorted & non-overlapping.
 */
function mapToTrimmed(t: number, segments: readonly Segment[]): number {
  let acc = 0;
  for (const s of segments) {
    if (t < s.start) return acc; // inside a dropped gap → next kept boundary
    if (t <= s.end) return acc + (t - s.start);
    acc += s.end - s.start;
  }
  return acc; // past the end → total kept duration
}

/**
 * Remap caption words onto the trimmed timeline. Filler words are dropped (they
 * shouldn't caption a cut), as are words wholly inside a removed span. A word
 * straddling a cut is clamped to its surviving portion. Output is sorted,
 * `end > start`, and RenderCaptionWord-shaped — ready for `renderSettings.captions`.
 */
export function remapWordsToTrimmed(
  words: readonly TimedWord[],
  segments: readonly Segment[],
  opts: Pick<KeepOptions, "removeFillers" | "fillerWords"> = {},
): TrimmedCaptionWord[] {
  if (!segments.length) return [];
  const removeFillers = opts.removeFillers ?? true;
  const fillers = new Set(
    (opts.fillerWords ?? DEFAULT_FILLER_WORDS).map((w) => normalizeToken(w)),
  );
  const sourceEnd = segments[segments.length - 1].end;
  const ws = sanitizeWords(words, sourceEnd);

  const out: TrimmedCaptionWord[] = [];
  for (const w of ws) {
    if (removeFillers && isFiller(w.text, fillers)) continue;
    // The portion of this word that survives in some kept span.
    let kept: { start: number; end: number } | null = null;
    for (const s of segments) {
      const a = Math.max(w.start, s.start);
      const b = Math.min(w.end, s.end);
      if (b > a) {
        kept = kept ? { start: Math.min(kept.start, a), end: Math.max(kept.end, b) } : { start: a, end: b };
      }
    }
    if (!kept) continue; // word fell entirely inside a cut
    const start = mapToTrimmed(kept.start, segments);
    const end = mapToTrimmed(kept.end, segments);
    const text = w.text.trim();
    if (text.length > 0 && end > start) out.push({ text, start, end });
  }
  return out.sort((a, b) => a.start - b.start);
}
