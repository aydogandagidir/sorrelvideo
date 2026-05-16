import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { GetCurrentAuthUserResponse } from "@workspace/api-zod";
import {
  clearSession,
  createSession,
  getSessionId,
  hashPassword,
  setSessionCookie,
  verifyPassword,
} from "../lib/auth";

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

router.get("/auth/user", (req: Request, res: Response) => {
  res.json(
    GetCurrentAuthUserResponse.parse({
      user: req.isAuthenticated() ? req.user : null,
    }),
  );
});

router.post("/auth/signup", async (req: Request, res: Response) => {
  const parsed = SignupBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid signup payload" });
    return;
  }

  const { email, password, firstName, lastName } = parsed.data;
  const normalizedEmail = email.toLowerCase().trim();

  const existing = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, normalizedEmail));

  if (existing.length > 0) {
    res.status(409).json({ error: "An account already exists for this email" });
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

  const sid = await createSession({ userId: user.id });
  setSessionCookie(res, sid);
  res.status(201).json(userEnvelope(user));
});

router.post("/auth/login", async (req: Request, res: Response) => {
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

  if (!row?.passwordHash || !(await verifyPassword(row.passwordHash, password))) {
    res.status(401).json({ error: "Email or password is incorrect" });
    return;
  }

  const sid = await createSession({ userId: row.id });
  setSessionCookie(res, sid);
  res.status(200).json(userEnvelope(row));
});

router.post("/auth/logout", async (req: Request, res: Response) => {
  const sid = getSessionId(req);
  await clearSession(res, sid);
  res.status(200).json({ success: true });
});

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
