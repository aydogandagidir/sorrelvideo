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
      res
        .status(400)
        .json({
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
