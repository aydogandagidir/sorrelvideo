/**
 * Render settings — the per-project, user-editable render configuration.
 *
 * Stored as a single jsonb column on `projects.render_settings` (see
 * projects.ts) rather than a column-per-knob, so adding knobs needs no
 * migration. Null → today's defaults (`DEFAULT_RENDER_SETTINGS`), so existing
 * projects render exactly as before this column existed.
 *
 * The string-literal unions are intentionally framed in the app's own terms
 * and kept free of any `@hyperframes/*` import — `lib/db` must stay a leaf
 * package. The api-server `renderSettingsService` maps these to the engine's
 * `RenderConfig` (fps `{num,den}`, `CanvasResolution`, etc.).
 *
 * `resolution` names mirror the engine's `CANVAS_DIMENSIONS` keys (verified
 * against @hyperframes/core@0.6.6): the three aspects (landscape 1920×1080,
 * portrait 1080×1920, square 1080×1080) and their 4K variants. This single
 * field encodes BOTH aspect ratio and resolution tier.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { projectsTable } from "./projects";

export type RenderQuality = "draft" | "standard" | "high";
export type RenderFormat = "mp4" | "webm" | "mov" | "png-sequence";
export type RenderFps = 24 | 30 | 60;
export type RenderResolution =
  | "landscape"
  | "portrait"
  | "square"
  | "landscape-4k"
  | "portrait-4k"
  | "square-4k";

/** A single shader transition between scenes (wired in M8). */
export interface RenderTransition {
  /** Start time in seconds. */
  time: number;
  /** Shader name (e.g. "whip-pan", "glitch") — validated against the catalog in M8. */
  shader: string;
  /** Transition duration in seconds. */
  duration: number;
  /** GSAP easing function name. */
  ease: string;
}

export interface RenderSettings {
  fps: RenderFps;
  quality: RenderQuality;
  format: RenderFormat;
  resolution: RenderResolution;
  /** True alpha output — only valid for webm/mov/png-sequence (Pro). */
  transparent: boolean;
  /** When true, a watermark is burned into the output (forced on for Free). */
  watermark: boolean;
  /** Optional shader transitions (M8). Absent/empty → no transitions. */
  transitions?: RenderTransition[];
}

/**
 * Defaults applied when `render_settings` is null. Chosen to reproduce the
 * pre-settings render output byte-for-byte: draft quality, 30fps, mp4, the
 * portrait 9:16 the Studio compositions are authored at, opaque, watermarked.
 */
export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  fps: 30,
  quality: "draft",
  format: "mp4",
  resolution: "portrait",
  transparent: false,
  watermark: true,
};

/**
 * Render-job ledger. One row per render attempt, distinct from the project's
 * own `status`/`renderError` columns: the project tracks "what is the latest
 * state of this project's video", while this table is the per-attempt audit
 * trail the M2 pipeline writes to (queued → rendering → ready/failed/cancelled),
 * including which backend ran it (inline worker, BullMQ, or a future Lambda),
 * the resolved config snapshot, progress, and an optional cost estimate.
 *
 * `id` is a non-numeric UUID on purpose — it doubles as a queue/job correlation
 * id and BullMQ rejects purely-numeric custom job ids. Every row is userId-scoped
 * like the rest of the schema; the service layer enforces ownership.
 */
export const renderJobsTable = pgTable(
  "render_jobs",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    // FKs give the ledger referential integrity + retention: deleting a project
    // (or its owning user) cascades away its render-job rows, so the table can't
    // accumulate orphans scanned on every distributed-quota check / boot recovery.
    // projectId integer → projects.id (serial/integer); userId text → users.id
    // (varchar — text↔varchar is FK-comparable in Postgres).
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    /** Which executor ran the job: inline | bullmq | lambda. */
    backend: varchar("backend").notNull().default("inline"),
    /** Backend-specific id (e.g. a BullMQ job id or Lambda request id). */
    externalId: varchar("external_id"),
    /** Lifecycle: queued | rendering | ready | failed | cancelled. */
    status: varchar("status").notNull().default("queued"),
    /** Progress as an integer percentage (0–100). */
    progress: integer("progress").notNull().default(0),
    /** Optional cost estimate in cents (populated by metered backends). */
    costCents: integer("cost_cents"),
    /** Output container format, copied from the resolved settings. */
    format: varchar("format"),
    /** Snapshot of the resolved RenderSettings this job ran with. */
    config: jsonb("config").$type<RenderSettings>(),
    /** Filesystem/object path of the produced artifact, when ready. */
    outputPath: text("output_path"),
    /** Failure message, when status = failed. */
    error: text("error"),
    /** Set when a caller asks the running job to abort. */
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index("IDX_render_jobs_project").on(table.projectId)],
);

/**
 * A persisted render-job row. Named `RenderJobRow` (not `RenderJob`) to avoid
 * clashing with `@hyperframes/producer`'s in-memory `RenderJob` type.
 */
export type RenderJobRow = typeof renderJobsTable.$inferSelect;
export type NewRenderJobRow = typeof renderJobsTable.$inferInsert;
