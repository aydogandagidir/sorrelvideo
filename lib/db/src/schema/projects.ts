import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./auth";
import type { RenderSettings } from "./render";

export const projectsTable = pgTable(
  "projects",
  {
    id: serial("id").primaryKey(),
    // FK → users.id (varchar). text↔varchar is FK-comparable in Postgres. ON
    // DELETE CASCADE so deleting a user removes their projects (and, transitively
    // via render_jobs' own FK, their render-job rows). The .default("") is kept
    // for legacy/back-compat inserts that predate the column being required.
    userId: text("user_id")
      .notNull()
      .default("")
      .references(() => usersTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("draft"),
    module: text("module").notNull(),
    templateId: integer("template_id"),
    // Optional brand kit this project renders with. Null → the user's default
    // kit at render time (renderService.loadBrandKit). A bare integer (like
    // templateId) rather than an FK: ownership is re-checked at load time, so a
    // dangling id is treated as "use the default" instead of failing a write.
    brandKitId: integer("brand_kit_id"),
    thumbnailUrl: text("thumbnail_url"),
    videoUrl: text("video_url"),
    duration: integer("duration"),
    renderError: text("render_error"),
    // Per-project values used to fill placeholders in the HTML composition
    // (e.g. headline, bodyText, ctaText). Studio writes here; the render
    // service merges this with the user's brand kit at render time.
    compositionVars: jsonb("composition_vars").$type<Record<string, string>>(),
    // Full studio-authored composition HTML. Written by the embedded Studio when
    // a project's entry composition is saved (routes/studio.ts). When set (a
    // non-empty string), renderService.buildCompositionHtml returns it VERBATIM —
    // the document is already the final, fully-authored HTML, so the brand-kit +
    // compositionVars template merge is bypassed. Null → the legacy template+vars
    // merge, so existing projects (and the default render) are byte-identical.
    compositionHtml: text("composition_html"),
    // Per-project render configuration (fps, quality, format, resolution,
    // transparency, watermark, transitions). Null → DEFAULT_RENDER_SETTINGS, so
    // existing rows render exactly as before this column existed. Edited via
    // PATCH /projects/:id/render-settings; consumed by renderService at render time.
    renderSettings: jsonb("render_settings").$type<RenderSettings>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  // Index the tenant scope: every project query filters `WHERE user_id = ?`
  // (project list, ownership checks), so this btree keeps those off a seq scan
  // as the table grows.
  (table) => [index("IDX_projects_user").on(table.userId)],
);

export const insertProjectSchema = createInsertSchema(projectsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projectsTable.$inferSelect;
