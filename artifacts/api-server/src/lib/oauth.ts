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
  firstName: string | null;
  lastName: string | null;
  profileImageUrl: string | null;
}

/**
 * Find a Sorrel user matching this provider identity, linking the OAuth
 * account if needed. Returns the user (or creates a new one). Auto-links
 * on email match — this is fine for our trust model since both GitHub and
 * Google verify their primary emails.
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

  // 2) Existing user with this email? Link the new identity.
  if (profile.email) {
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

  // 3) Brand new user. emailVerifiedAt is set because the provider verified it.
  const [newUser] = await db
    .insert(usersTable)
    .values({
      email: profile.email ? profile.email.toLowerCase().trim() : null,
      emailVerifiedAt: profile.email ? new Date() : null,
      firstName: profile.firstName,
      lastName: profile.lastName,
      profileImageUrl: profile.profileImageUrl,
    })
    .returning();

  await db.insert(oauthAccountsTable).values({
    userId: newUser.id,
    provider,
    providerAccountId: profile.providerAccountId,
    providerEmail: profile.email,
  });

  return newUser;
}
