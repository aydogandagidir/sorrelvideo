import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db, brandKitTable, type BrandKit } from "@workspace/db";
import { isSafeCssColor } from "../lib/compositionVars";
import { isSafeLogoUrl } from "../lib/logoUrl";

/**
 * Brand kits are now many-per-user with a single default (partial-unique index
 * UQ_brand_kit_default). This service centralises the default invariant: any
 * write that sets a kit default first clears the user's other defaults inside a
 * transaction, so the index can never be violated and the render-time default
 * lookup stays unambiguous.
 */

export type BrandKitWrite = {
  name?: string;
  companyName?: string | null;
  primaryColor?: string;
  secondaryColor?: string;
  accentColor?: string | null;
  fontFamily?: string;
  logoUrl?: string | null;
  brandVoice?: "professional" | "playful" | "bold" | "minimal" | null;
  voiceDescription?: string | null;
  sourceUrl?: string | null;
  isDefault?: boolean;
};

export class BrandKitValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandKitValidationError";
  }
}

const SAFE_FONT = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}$/;

/**
 * Reject brand fields that would break out of the composition contexts they're
 * injected into: colors land UNQUOTED in `<style>`/SVG paint, logoUrl in an
 * `<img src>`, fontFamily inside a single-quoted `font-family:'…'`. (The render
 * template only escapes `< > &`, not quotes — see lib/compositionVars.ts.)
 */
export function assertSafeBrandFields(input: BrandKitWrite): void {
  for (const key of ["primaryColor", "secondaryColor", "accentColor"] as const) {
    const v = input[key];
    if (v != null && !isSafeCssColor(v)) {
      throw new BrandKitValidationError(
        `${key} must be a hex (#rgb/#rrggbb), rgb()/rgba(), or hsl()/hsla() color`,
      );
    }
  }
  if (input.logoUrl != null && !isSafeLogoUrl(input.logoUrl)) {
    throw new BrandKitValidationError("logoUrl must be a valid http(s) URL");
  }
  if (input.fontFamily != null && input.fontFamily !== "" && !SAFE_FONT.test(input.fontFamily)) {
    throw new BrandKitValidationError(
      "fontFamily must be a plain family name (letters, digits, spaces, - or _)",
    );
  }
}

export function listBrandKits(userId: string): Promise<BrandKit[]> {
  return db
    .select()
    .from(brandKitTable)
    .where(eq(brandKitTable.userId, userId))
    .orderBy(desc(brandKitTable.isDefault), asc(brandKitTable.id));
}

export async function getBrandKit(
  userId: string,
  id: number,
): Promise<BrandKit | null> {
  const [row] = await db
    .select()
    .from(brandKitTable)
    .where(and(eq(brandKitTable.id, id), eq(brandKitTable.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** The user's default kit (or the earliest as a fallback), null if they have none. */
export async function getDefaultBrandKit(
  userId: string,
): Promise<BrandKit | null> {
  const [preferred] = await db
    .select()
    .from(brandKitTable)
    .where(and(eq(brandKitTable.userId, userId), eq(brandKitTable.isDefault, true)))
    .limit(1);
  if (preferred) return preferred;
  const [earliest] = await db
    .select()
    .from(brandKitTable)
    .where(eq(brandKitTable.userId, userId))
    .orderBy(asc(brandKitTable.id))
    .limit(1);
  return earliest ?? null;
}

/** Get-or-create the default kit (used by PUT /brand when the user saves). */
export async function ensureDefaultBrandKit(userId: string): Promise<BrandKit> {
  const existing = await getDefaultBrandKit(userId);
  if (existing) return existing;
  return createBrandKit(userId, { name: "My brand", isDefault: true });
}

/**
 * A non-persisted default kit, so `GET /brand` (studio's read-only useGetBrandKit)
 * always has an object to render WITHOUT creating a placeholder row. Creating a
 * placeholder used to make website→video reuse an empty indigo kit (the "magenta
 * Your Brand" bug); not persisting here means "the user has a kit" stays truthful.
 */
export function transientDefaultBrandKit(userId: string): BrandKit {
  return {
    id: 0,
    userId,
    name: "My brand",
    isDefault: true,
    sourceUrl: null,
    logoUrl: null,
    primaryColor: "#6366f1",
    secondaryColor: "#8b5cf6",
    accentColor: null,
    fontFamily: "Inter",
    companyName: null,
    brandVoice: null,
    voiceDescription: null,
    updatedAt: new Date(),
  };
}

/**
 * True when a kit carries real brand intent (a company name or a detected
 * source) rather than being an untouched placeholder. website→video uses this
 * to decide whether to reuse the user's default or auto-detect from the site —
 * so a leftover empty default from the old single-kit code doesn't win.
 */
export function isConfiguredBrandKit(kit: BrandKit): boolean {
  return !!(kit.companyName && kit.companyName.trim()) || !!kit.sourceUrl;
}

async function clearDefaults(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: string,
): Promise<void> {
  await tx
    .update(brandKitTable)
    .set({ isDefault: false })
    .where(and(eq(brandKitTable.userId, userId), eq(brandKitTable.isDefault, true)));
}

export async function createBrandKit(
  userId: string,
  input: BrandKitWrite,
): Promise<BrandKit> {
  assertSafeBrandFields(input);
  return db.transaction(async (tx) => {
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(brandKitTable)
      .where(eq(brandKitTable.userId, userId));
    // First kit is always the default; otherwise honour the caller's request.
    const makeDefault = input.isDefault === true || count === 0;
    if (makeDefault) await clearDefaults(tx, userId);

    const { isDefault: _omit, ...rest } = input;
    const [row] = await tx
      .insert(brandKitTable)
      .values({ userId, ...rest, isDefault: makeDefault })
      .returning();
    return row;
  });
}

/** Update an owned kit. Returns null when the kit doesn't exist / isn't theirs. */
export async function updateBrandKit(
  userId: string,
  id: number,
  input: BrandKitWrite,
): Promise<BrandKit | null> {
  assertSafeBrandFields(input);
  return db.transaction(async (tx) => {
    const [owned] = await tx
      .select()
      .from(brandKitTable)
      .where(and(eq(brandKitTable.id, id), eq(brandKitTable.userId, userId)))
      .limit(1);
    if (!owned) return null;

    if (input.isDefault === true) await clearDefaults(tx, userId);
    // Never let an explicit isDefault:false orphan the user with no default —
    // demotion happens implicitly by promoting another kit, not here.
    const set: Partial<typeof brandKitTable.$inferInsert> = { ...input };
    if (input.isDefault === false) delete set.isDefault;

    const [row] = await tx
      .update(brandKitTable)
      .set(set)
      .where(and(eq(brandKitTable.id, id), eq(brandKitTable.userId, userId)))
      .returning();
    return row ?? null;
  });
}

/** Delete an owned kit; if it was the default, promote the earliest remaining. */
export async function deleteBrandKit(
  userId: string,
  id: number,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(brandKitTable)
      .where(and(eq(brandKitTable.id, id), eq(brandKitTable.userId, userId)))
      .returning();
    if (!deleted) return false;

    if (deleted.isDefault) {
      const [next] = await tx
        .select()
        .from(brandKitTable)
        .where(eq(brandKitTable.userId, userId))
        .orderBy(asc(brandKitTable.id))
        .limit(1);
      if (next) {
        await tx
          .update(brandKitTable)
          .set({ isDefault: true })
          .where(eq(brandKitTable.id, next.id));
      }
    }
    return true;
  });
}
