import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  db,
  emailVerificationsTable,
  passwordResetsTable,
  usersTable,
} from "@workspace/db";
import { GetCurrentAuthUserResponse } from "@workspace/api-zod";
import {
  clearSession,
  createSession,
  generateToken,
  getSessionId,
  hashPassword,
  hashToken,
  setSessionCookie,
  verifyPassword,
} from "../lib/auth";
import { sendPasswordResetEmail, sendVerificationEmail } from "../lib/email";
import {
  findOrCreateOAuthUser,
  generateCodeVerifier,
  generateState,
  getGitHubClient,
  getGoogleClient,
  isProviderConfigured,
  type OAuthProvider,
} from "../lib/oauth";
import {
  forgotPasswordLimiter,
  loginLimiter,
  signupLimiter,
  verifyEmailLimiter,
} from "../middlewares/rateLimit";

const router: IRouter = Router();

const SignupBody = z.object({
  email: z.string().email().min(3).max(254),
  password: z.string().min(8).max(256),
  firstName: z.string().max(100).nullable().optional(),
  lastName: z.string().max(100).nullable().optional(),
});

const LoginBody = z.object({
  email: z.string().email().min(3).max(254),
  password: z.string().min(1).max(256),
});

const ForgotPasswordBody = z.object({
  email: z.string().email().min(3).max(254),
});

const ResetPasswordBody = z.object({
  token: z.string().min(8).max(256),
  password: z.string().min(8).max(256),
});

const ResendVerificationBody = z.object({
  email: z.string().email().min(3).max(254),
});

const VerifyEmailQuery = z.object({
  token: z.string().min(8).max(256),
});

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RESET_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getSafeReturnTo(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//")
  ) {
    return "/";
  }
  return value;
}

function userEnvelope(row: typeof usersTable.$inferSelect) {
  return GetCurrentAuthUserResponse.parse({
    user: {
      id: row.id,
      email: row.email,
      firstName: row.firstName,
      lastName: row.lastName,
      profileImageUrl: row.profileImageUrl,
    },
  });
}

async function issueVerification(
  user: typeof usersTable.$inferSelect,
): Promise<void> {
  if (!user.email) return;
  const token = generateToken();
  await db.insert(emailVerificationsTable).values({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
  });
  await sendVerificationEmail({
    to: user.email,
    firstName: user.firstName,
    token,
  });
}

router.get("/auth/user", (req: Request, res: Response) => {
  res.json(
    GetCurrentAuthUserResponse.parse({
      user: req.isAuthenticated() ? req.user : null,
    }),
  );
});

router.post(
  "/auth/signup",
  signupLimiter,
  async (req: Request, res: Response) => {
    const parsed = SignupBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues[0]?.message ?? "Invalid signup payload",
      });
      return;
    }

    const { email, password, firstName, lastName } = parsed.data;
    const normalizedEmail = email.toLowerCase().trim();

    const existing = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, normalizedEmail));

    if (existing.length > 0) {
      res
        .status(409)
        .json({ error: "An account already exists for this email" });
      return;
    }

    const passwordHash = await hashPassword(password);

    const [user] = await db
      .insert(usersTable)
      .values({
        email: normalizedEmail,
        passwordHash,
        firstName: firstName ?? null,
        lastName: lastName ?? null,
      })
      .returning();

    // Best-effort verification mail; failure does not block signup.
    issueVerification(user).catch((err) =>
      req.log.warn({ err, userId: user.id }, "Verification email send failed"),
    );

    const sid = await createSession({ userId: user.id });
    setSessionCookie(res, sid);
    res.status(201).json(userEnvelope(user));
  },
);

router.post(
  "/auth/login",
  loginLimiter,
  async (req: Request, res: Response) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid login payload" });
      return;
    }

    const { email, password } = parsed.data;
    const normalizedEmail = email.toLowerCase().trim();

    const [row] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, normalizedEmail));

    if (
      !row?.passwordHash ||
      !(await verifyPassword(row.passwordHash, password))
    ) {
      res.status(401).json({ error: "Email or password is incorrect" });
      return;
    }

    const sid = await createSession({ userId: row.id });
    setSessionCookie(res, sid);
    res.status(200).json(userEnvelope(row));
  },
);

router.post("/auth/logout", async (req: Request, res: Response) => {
  const sid = getSessionId(req);
  await clearSession(res, sid);
  res.status(200).json({ success: true });
});

router.post(
  "/auth/forgot-password",
  forgotPasswordLimiter,
  async (req: Request, res: Response) => {
    const parsed = ForgotPasswordBody.safeParse(req.body);
    if (!parsed.success) {
      // Same generic response — never tip off whether the email is valid.
      res.status(200).json({ success: true });
      return;
    }

    const normalizedEmail = parsed.data.email.toLowerCase().trim();
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, normalizedEmail));

    if (user) {
      const token = generateToken();
      await db.insert(passwordResetsTable).values({
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      });
      try {
        await sendPasswordResetEmail({
          to: normalizedEmail,
          firstName: user.firstName,
          token,
        });
      } catch (err) {
        req.log.warn({ err, userId: user.id }, "Reset email send failed");
      }
    }

    // Always 200 so an attacker can't probe registered emails.
    res.status(200).json({ success: true });
  },
);

router.post("/auth/reset-password", async (req: Request, res: Response) => {
  const parsed = ResetPasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid reset payload" });
    return;
  }

  const { token, password } = parsed.data;
  const tokenHash = hashToken(token);

  const [row] = await db
    .select()
    .from(passwordResetsTable)
    .where(
      and(
        eq(passwordResetsTable.tokenHash, tokenHash),
        isNull(passwordResetsTable.usedAt),
        gt(passwordResetsTable.expiresAt, new Date()),
      ),
    );

  if (!row) {
    res.status(400).json({ error: "Reset link is invalid or has expired" });
    return;
  }

  const passwordHash = await hashPassword(password);

  await db
    .update(usersTable)
    .set({ passwordHash })
    .where(eq(usersTable.id, row.userId));

  await db
    .update(passwordResetsTable)
    .set({ usedAt: new Date() })
    .where(eq(passwordResetsTable.id, row.id));

  res.status(200).json({ success: true });
});

router.get(
  "/auth/verify-email",
  verifyEmailLimiter,
  async (req: Request, res: Response) => {
    const parsed = VerifyEmailQuery.safeParse(req.query);
    if (!parsed.success) {
      res.redirect("/email-verified?status=invalid");
      return;
    }

    const tokenHash = hashToken(parsed.data.token);

    const [row] = await db
      .select()
      .from(emailVerificationsTable)
      .where(
        and(
          eq(emailVerificationsTable.tokenHash, tokenHash),
          gt(emailVerificationsTable.expiresAt, new Date()),
        ),
      );

    if (!row) {
      res.redirect("/email-verified?status=invalid");
      return;
    }

    await db
      .update(usersTable)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(usersTable.id, row.userId));

    // Single-use: delete the row so the same link can't be replayed.
    await db
      .delete(emailVerificationsTable)
      .where(eq(emailVerificationsTable.id, row.id));

    res.redirect("/email-verified?status=ok");
  },
);

router.post(
  "/auth/resend-verification",
  verifyEmailLimiter,
  async (req: Request, res: Response) => {
    const parsed = ResendVerificationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(200).json({ success: true });
      return;
    }

    const normalizedEmail = parsed.data.email.toLowerCase().trim();
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, normalizedEmail));

    if (user && !user.emailVerifiedAt) {
      issueVerification(user).catch((err) =>
        req.log.warn(
          { err, userId: user.id },
          "Resend verification email failed",
        ),
      );
    }

    res.status(200).json({ success: true });
  },
);

// --- OAuth (GitHub + Google) ----------------------------------------------

const OAUTH_COOKIE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function parseProvider(value: unknown): OAuthProvider | null {
  if (value === "github" || value === "google") return value;
  return null;
}

function setOauthCookie(res: Response, name: string, value: string): void {
  res.cookie(name, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // OAuth callbacks redirect cross-site → cookie must travel with the
    // top-level navigation. `lax` is the safest level that still works.
    sameSite: "lax",
    path: "/",
    maxAge: OAUTH_COOKIE_TTL_MS,
  });
}

function clearOauthCookies(res: Response): void {
  res.clearCookie("oauth_state", { path: "/" });
  res.clearCookie("oauth_code_verifier", { path: "/" });
  res.clearCookie("oauth_return_to", { path: "/" });
}

router.get("/auth/oauth/:provider", (req: Request, res: Response): void => {
  const provider = parseProvider(req.params.provider);
  if (!provider) {
    res.status(404).json({ error: "Unknown OAuth provider" });
    return;
  }
  if (!isProviderConfigured(provider)) {
    res
      .status(503)
      .json({ error: `OAuth provider '${provider}' is not configured` });
    return;
  }

  const state = generateState();
  const returnTo = getSafeReturnTo(req.query.returnTo);
  setOauthCookie(res, "oauth_state", state);
  setOauthCookie(res, "oauth_return_to", returnTo);

  let url: URL;
  if (provider === "github") {
    url = getGitHubClient().createAuthorizationURL(state, ["user:email"]);
  } else {
    const codeVerifier = generateCodeVerifier();
    setOauthCookie(res, "oauth_code_verifier", codeVerifier);
    url = getGoogleClient().createAuthorizationURL(state, codeVerifier, [
      "openid",
      "email",
      "profile",
    ]);
  }

  res.redirect(url.toString());
});

router.get(
  "/auth/oauth/:provider/callback",
  async (req: Request, res: Response): Promise<void> => {
    const provider = parseProvider(req.params.provider);
    if (!provider) {
      res.status(404).json({ error: "Unknown OAuth provider" });
      return;
    }

    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    const expectedState = req.cookies?.oauth_state;
    const returnTo = getSafeReturnTo(req.cookies?.oauth_return_to);

    if (!code || !state || !expectedState || state !== expectedState) {
      clearOauthCookies(res);
      res.redirect("/login?oauth=invalid");
      return;
    }

    try {
      let profileEmail: string | null = null;
      let providerAccountId: string;
      let firstName: string | null = null;
      let lastName: string | null = null;
      let profileImageUrl: string | null = null;

      if (provider === "github") {
        const client = getGitHubClient();
        const tokens = await client.validateAuthorizationCode(code);
        const accessToken = tokens.accessToken();
        const userRes = await fetch("https://api.github.com/user", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!userRes.ok) throw new Error(`GitHub user fetch ${userRes.status}`);
        const ghUser = (await userRes.json()) as {
          id: number;
          email: string | null;
          name: string | null;
          login: string;
          avatar_url: string | null;
        };
        providerAccountId = String(ghUser.id);
        profileImageUrl = ghUser.avatar_url;
        const fullName = (ghUser.name ?? ghUser.login).trim();
        const space = fullName.indexOf(" ");
        firstName = space > 0 ? fullName.slice(0, space) : fullName;
        lastName = space > 0 ? fullName.slice(space + 1) : null;

        // GitHub may hide the primary email; fetch /user/emails to find a
        // verified primary, falling back to the noreply alias.
        profileEmail = ghUser.email;
        if (!profileEmail) {
          const emailsRes = await fetch("https://api.github.com/user/emails", {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (emailsRes.ok) {
            const emails = (await emailsRes.json()) as Array<{
              email: string;
              primary: boolean;
              verified: boolean;
            }>;
            const primary = emails.find((e) => e.primary && e.verified);
            profileEmail = primary?.email ?? null;
          }
        }
      } else {
        const codeVerifier = req.cookies?.oauth_code_verifier;
        if (!codeVerifier) {
          clearOauthCookies(res);
          res.redirect("/login?oauth=invalid");
          return;
        }
        const client = getGoogleClient();
        const tokens = await client.validateAuthorizationCode(
          code,
          codeVerifier,
        );
        const accessToken = tokens.accessToken();
        const userRes = await fetch(
          "https://openidconnect.googleapis.com/v1/userinfo",
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (!userRes.ok) throw new Error(`Google userinfo ${userRes.status}`);
        const gUser = (await userRes.json()) as {
          sub: string;
          email: string | null;
          email_verified?: boolean;
          given_name: string | null;
          family_name: string | null;
          picture: string | null;
        };
        providerAccountId = gUser.sub;
        profileEmail = gUser.email_verified ? gUser.email : null;
        firstName = gUser.given_name;
        lastName = gUser.family_name;
        profileImageUrl = gUser.picture;
      }

      const user = await findOrCreateOAuthUser(provider, {
        providerAccountId,
        email: profileEmail,
        firstName,
        lastName,
        profileImageUrl,
      });

      clearOauthCookies(res);
      const sid = await createSession({ userId: user.id });
      setSessionCookie(res, sid);
      res.redirect(returnTo);
    } catch (err) {
      req.log.error({ err, provider }, "OAuth callback failed");
      clearOauthCookies(res);
      res.redirect("/login?oauth=error");
    }
  },
);

// Backward-compatible browser entry points so that existing client code that
// navigates to /api/login or /api/logout keeps working without JS-driven flows.
router.get("/login", (req: Request, res: Response) => {
  const returnTo = getSafeReturnTo(req.query.returnTo);
  const search = new URLSearchParams();
  if (returnTo !== "/") search.set("returnTo", returnTo);
  const qs = search.toString();
  res.redirect(qs ? `/login?${qs}` : "/login");
});

router.get("/logout", async (req: Request, res: Response) => {
  const sid = getSessionId(req);
  await clearSession(res, sid);
  res.redirect("/");
});

export default router;
