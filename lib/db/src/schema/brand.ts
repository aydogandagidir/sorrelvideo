import {
  pgTable,
  text,
  serial,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./auth";

export const brandKitTable = pgTable(
  "brand_kit",
  {
    id: serial("id").primaryKey(),
    // FK → users.id (varchar). text↔varchar is FK-comparable in Postgres. The
    // owning user going away deletes their brand kits (ON DELETE CASCADE). Keep
    // the .default("") for legacy inserts that predate the column being required.
    userId: text("user_id")
      .notNull()
      .default("")
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // A user can keep several brand kits (one per brand / per captured site).
    // `name` is the human label shown in the picker; `isDefault` marks the kit
    // used when a project doesn't pin a specific one. `sourceUrl` records the
    // website a kit was auto-extracted from (null for hand-authored kits).
    name: text("name").notNull().default("Brand kit"),
    isDefault: boolean("is_default").notNull().default(false),
    sourceUrl: text("source_url"),
    logoUrl: text("logo_url"),
    primaryColor: text("primary_color").notNull().default("#6366f1"),
    secondaryColor: text("secondary_color").notNull().default("#8b5cf6"),
    accentColor: text("accent_color"),
    fontFamily: text("font_family").notNull().default("Inter"),
    companyName: text("company_name"),
    // Brand voice — drives the system prompt fed to the AI provider.
    // brandVoice slug picks one of four canonical tones; voiceDescription is
    // a free-text override the user can use to add nuance ("clinical, no
    // exclamation marks, plural pronouns only", etc.).
    brandVoice: text("brand_voice", {
      enum: ["professional", "playful", "bold", "minimal"],
    }),
    voiceDescription: text("voice_description"),
    // ── Brand DNA (Pomelli-style): the narrative identity, AI-extracted from the
    // site and editable. Distinct from the visual identity (colors/font/logo)
    // above; all nullable so a kit that predates DNA (or a no-AI heuristic
    // extraction) is still valid. Consumed by the AI copy suggester + video-idea
    // generator (NOT injected into compositions, so they need no CSS/attr guard).
    tagline: text("tagline"),
    description: text("description"),
    valueProposition: text("value_proposition"),
    targetAudience: text("target_audience"),
    industry: text("industry"),
    keywords: jsonb("keywords").$type<string[]>(),
    personality: jsonb("personality").$type<string[]>(),
    imageStyle: text("image_style"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Hot path: every brand query filters `WHERE user_id = ?` (list, ownership
    // checks, the render-time default lookup), so keep it off a seq scan.
    index("IDX_brand_kit_user").on(table.userId),
    // At most ONE default kit per user. A PARTIAL unique index (only rows where
    // is_default) lets a user own many non-default kits while guaranteeing the
    // render-time `WHERE is_default` lookup is unambiguous. Replaces the old
    // UNIQUE(user_id) (which capped users at a single kit).
    uniqueIndex("UQ_brand_kit_default")
      .on(table.userId)
      .where(sql`${table.isDefault}`),
  ],
);

export const insertBrandKitSchema = createInsertSchema(brandKitTable).omit({
  id: true,
  updatedAt: true,
});
export type InsertBrandKit = z.infer<typeof insertBrandKitSchema>;
export type BrandKit = typeof brandKitTable.$inferSelect;
