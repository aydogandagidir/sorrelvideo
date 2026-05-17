import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const brandKitTable = pgTable("brand_kit", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().default(""),
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
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertBrandKitSchema = createInsertSchema(brandKitTable).omit({
  id: true,
  updatedAt: true,
});
export type InsertBrandKit = z.infer<typeof insertBrandKitSchema>;
export type BrandKit = typeof brandKitTable.$inferSelect;
