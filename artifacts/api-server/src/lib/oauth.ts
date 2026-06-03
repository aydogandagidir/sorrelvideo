import { GitHub, Google, generateState, generateCodeVerifier } from "arctic";
import { and, eq } from "drizzle-orm";
import { db, oauthAccountsTable, usersTable } from "@workspace/db";

export type OAuthProvider = "github" | "google";

function appUrl(): string {
  return process.env.APP_URL?.replace(/\/$/, "") ?? "http://localhost:8080";
}

function callbackUrl(provider: OAuthProvider): string {
  return `${appUrl()}/api/auth/oauth/${provider}/callback`;
}

function readEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set; configure the OAuth provider`);
  }
  return value;
}

let githubClient: GitHub | null = null;
export function getGitHubClient(): GitHub {
  if (!githubClient) {
    githubClient = new GitHub(
      readEnv("GITHUB_OAUTH_CLIENT_ID"),
      readEnv("GITHUB_OAUTH_CLIENT_SECRET"),
      callbackUrl("github"),
    );
  }
  return githubClient;
}

let googleClient: Google | null = null;
export function getGoogleClient(): Google {
  if (!googleClient) {
    googleClient = new Google(
      readEnv("GOOGLE_OAUTH_CLIENT_ID"),
      readEnv("GOOGLE_OAUTH_CLIENT_SECRET"),
      callbackUrl("google"),
    );
  }
  return googleClient;
}

export function isProviderConfigured(provider: OAuthProvider): boolean {
  if (provider === "github") {
    return Boolean(
      process.env.GITHUB_OAUTH_CLIENT_ID &&
      process.env.GITHUB_OAUTH_CLIENT_SECRET,
    );
  }
  return Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID &&
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  );
}

export { generateState, generateCodeVerifier };

interface ProviderProfile {
  providerAccountId: string;
  email: string | null;
  /**
   * Whether the provider has *verified* `email` belongs to this identity.
   * The caller MUST only set this when the provider attests it (GitHub:
   * primary && verified from /user/emails; Google: `email_verified`). An
   * unverified email is never trusted for the email→account auto-link in
   * step 2, because owning a GitHub/Google account does not prove ownership
   * of an arbitrary address attached to it — trusting it would let an
   * attacker take over a Sorrel account by attaching the victim's email.
   */
  emailVerified: boolean;
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
}

/**
 * Find a Sorrel user matching this provider identity, linking the OAuth
 * account if needed. Returns the user (or creates a new one).
 *
 * Auto-linking by email (step 2) happens ONLY when `profile.emailVerified` is
 * true. The provider email is still stored on the oauth_accounts row for
 * reference either way, but an unverified address never grants access to a
 * pre-existing account.
 */
export async function findOrCreateOAuthUser(
  provider: OAuthProvider,
  profile: ProviderProfile,
): Promise<typeof usersTable.$inferSelect> {
  // 1) Already linked? Return that user.
  const [existingLink] = await db
    .select()
    .from(oauthAccountsTable)
    .where(
      and(
        eq(oauthAccountsTable.provider, provider),
        eq(oauthAccountsTable.providerAccountId, profile.providerAccountId),
      ),
    );

  if (existingLink) {
    const [linked] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, existingLink.userId));
    if (linked) return linked;
  }

  // 2) Existing user with this email? Link the new identity — but ONLY when the
  // provider verified the email. Without that guarantee, an attacker who owns a
  // provider account could attach a victim's email to it and silently take over
  // the victim's Sorrel account.
  if (profile.email && profile.emailVerified) {
    const normalized = profile.email.toLowerCase().trim();
    const [byEmail] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, normalized));

    if (byEmail) {
      await db.insert(oauthAccountsTable).values({
        userId: byEmail.id,
        provider,
        providerAccountId: profile.providerAccountId,
        providerEmail: profile.email,
      });
      // Provider already verified the email — make sure the user reflects that.
      if (!byEmail.emailVerifiedAt) {
        await db
          .update(usersTable)
          .set({ emailVerifiedAt: new Date() })
          .where(eq(usersTable.id, byEmail.id));
      }
      return byEmail;
    }
  }

  // 3) Brand new user. We only persist (and mark verified) an email the
  // provider verified — an unverified address is dropped so it can't later be
  // matched against, or collide with, a real account's email.
  const verifiedEmail =
    profile.email && profile.emailVerified
      ? profile.email.toLowerCase().trim()
      : null;
  const [newUser] = await db
    .insert(usersTable)
    .values({
      email: verifiedEmail,
      emailVerifiedAt: verifiedEmail ? new Date() : null,
      firstName: profile.firstName,
      lastName: profile.lastName,
      profileImageUrl: profile.profileImageUrl,
    })
    .returning();

  await db.insert(oauthAccountsTable).values({
    userId: newUser.id,
    provider,
    providerAccountId: profile.providerAccountId,
    // Record the raw provider email (verified or not) for reference/debugging;
    // it carries no auth weight.
    providerEmail: profile.email,
  });

  return newUser;
}
