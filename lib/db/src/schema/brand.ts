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
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertBrandKitSchema = createInsertSchema(brandKitTable).omit({ id: true, updatedAt: true });
export type InsertBrandKit = z.infer<typeof insertBrandKitSchema>;
export type BrandKit = typeof brandKitTable.$inferSelect;
